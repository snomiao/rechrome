//! rechrome-tray — a native menu-bar / system-tray icon for the rechrome
//! `serve` daemon.
//!
//! It reflects daemon health at a glance and offers the common controls
//! (restart / stop / open / copy) so a non-technical user never needs a
//! terminal. NSStatusItem on macOS, Shell_NotifyIcon on Windows, via the
//! `tray-icon` crate over a `tao` event loop.
//!
//! State: it reads `RECHROME_URL` (env, else `~/.env.local`) and probes the
//! daemon's authenticated `GET /ping`. A 200 means the daemon is up *and* the
//! bearer key matches — the most common real failure is a rotated key after a
//! serve restart, which shows as "reachable" (port open) but not "healthy".
//! There is no push channel, so it polls.

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod imp {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::process::Command;
    use std::time::{Duration, Instant};

    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

    const POLL_INTERVAL: Duration = Duration::from_secs(2);
    const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Health {
        Healthy,      // /ping → 200: daemon up and bearer key valid
        Reachable,    // port open but /ping not OK (e.g. rotated/rejected key)
        Down,         // nothing listening
        Unconfigured, // no RECHROME_URL yet (run `rech setup`)
    }

    struct Parsed {
        key: String,
        host: String,
        port: u16,
        https: bool,
        raw: String,
    }

    impl Parsed {
        fn origin(&self) -> String {
            format!(
                "{}://{}:{}/",
                if self.https { "https" } else { "http" },
                self.host,
                self.port
            )
        }
    }

    /// Whether a desktop GUI session is available. On Linux there must be an X11
    /// or Wayland display; a headless box (SSH, CI, container) has neither, so we
    /// skip the tray rather than crash. macOS/Windows desktop sessions
    /// effectively always have a GUI — and if one somehow doesn't, tray creation
    /// fails and we bypass gracefully there too (see `run`).
    fn gui_available() -> bool {
        #[cfg(target_os = "linux")]
        {
            let has = |k: &str| std::env::var_os(k).map(|v| !v.is_empty()).unwrap_or(false);
            has("DISPLAY") || has("WAYLAND_DISPLAY")
        }
        #[cfg(not(target_os = "linux"))]
        {
            true
        }
    }

    /// `~/.rechrome/tray.hidden` — a flag file the running tray polls so the
    /// `rech tray hide` / `rech tray show` commands (separate processes) and the
    /// in-menu "Hide" item all drive one shared visibility state.
    fn hidden_flag_path() -> Option<std::path::PathBuf> {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()?;
        Some(std::path::PathBuf::from(home).join(".rechrome").join("tray.hidden"))
    }

    fn is_hidden() -> bool {
        hidden_flag_path().map(|p| p.exists()).unwrap_or(false)
    }

    fn set_hidden_flag() {
        if let Some(p) = hidden_flag_path() {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&p, b"1");
        }
    }

    /// `RECHROME_URL` from the environment, falling back to the first matching
    /// line in `~/.env.local` (where `rech` persists it).
    fn read_rechrome_url() -> Option<String> {
        if let Ok(v) = std::env::var("RECHROME_URL") {
            if !v.trim().is_empty() {
                return Some(v);
            }
        }
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()?;
        let body = std::fs::read_to_string(format!("{home}/.env.local")).ok()?;
        for line in body.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("RECHROME_URL=") {
                let v = rest.trim().trim_matches(['"', '\'']);
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
        None
    }

    /// Parse `scheme://[key@]host[:port][/...][?...]`. rechrome puts the bearer
    /// key in the userinfo and no password, so a plain split is sufficient.
    fn parse_url(raw: &str) -> Option<Parsed> {
        let raw = raw.trim();
        let (scheme, rest) = raw.split_once("://")?;
        let https = scheme.eq_ignore_ascii_case("https");
        let authority = rest.split(['/', '?']).next().unwrap_or(rest);
        let (key, hostport) = match authority.split_once('@') {
            Some((u, h)) => (u.to_string(), h),
            None => (String::new(), authority),
        };
        let default_port = if https { 443 } else { 80 };
        let (host, port) = match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(default_port)),
            None => (hostport.to_string(), default_port),
        };
        if host.is_empty() {
            return None;
        }
        Some(Parsed {
            key,
            host,
            port,
            https,
            raw: raw.to_string(),
        })
    }

    fn probe(p: &Parsed) -> Health {
        let addr = match (p.host.as_str(), p.port)
            .to_socket_addrs()
            .ok()
            .and_then(|mut it| it.next())
        {
            Some(a) => a,
            None => return Health::Down,
        };
        let mut stream = match TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) {
            Ok(s) => s,
            Err(_) => return Health::Down,
        };
        // We can't speak TLS without a crate; a remote https daemon being
        // reachable is the best signal we cheaply have.
        if p.https {
            return Health::Reachable;
        }
        let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
        let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
        let req = format!(
            "GET /ping HTTP/1.0\r\nHost: {}:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            p.host, p.port, p.key
        );
        if stream.write_all(req.as_bytes()).is_err() {
            return Health::Reachable;
        }
        let mut buf = [0u8; 256];
        match stream.read(&mut buf) {
            Ok(n) if n > 0 => {
                let head = String::from_utf8_lossy(&buf[..n]);
                let status_line = head.lines().next().unwrap_or("");
                if status_line.contains(" 200") {
                    Health::Healthy
                } else {
                    // Port open but request rejected — e.g. 401 from a rotated key.
                    Health::Reachable
                }
            }
            _ => Health::Reachable,
        }
    }

    fn pm_bin() -> &'static str {
        if cfg!(target_os = "windows") {
            "pm2"
        } else {
            "oxmgr"
        }
    }

    /// `bunx <pm> <verb> rechrome` — mirrors how `rech` manages the daemon.
    fn pm_action(verb: &str) {
        let _ = Command::new("bunx")
            .args(["-y", pm_bin(), verb, "rechrome"])
            .spawn();
    }

    fn open_in_browser(url: &str) {
        #[cfg(target_os = "macos")]
        let _ = Command::new("open").arg(url).spawn();
        #[cfg(target_os = "windows")]
        let _ = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }

    fn copy_to_clipboard(text: &str) {
        #[cfg(target_os = "macos")]
        let mut cmd = Command::new("pbcopy");
        #[cfg(target_os = "windows")]
        let mut cmd = Command::new("clip");
        cmd.stdin(std::process::Stdio::piped());
        if let Ok(mut child) = cmd.spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }

    fn make_icon(health: Health) -> Icon {
        const SIZE: i32 = 32;
        let (r, g, b) = match health {
            Health::Healthy => (52, 199, 89),    // green
            Health::Reachable => (255, 204, 0),  // amber
            Health::Down => (255, 69, 58),       // red
            Health::Unconfigured => (142, 142, 147), // grey
        };
        let c = (SIZE as f32 - 1.0) / 2.0;
        let radius = SIZE as f32 / 2.0 - 1.0;
        let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
        for y in 0..SIZE {
            for x in 0..SIZE {
                let dx = x as f32 - c;
                let dy = y as f32 - c;
                let dist = (dx * dx + dy * dy).sqrt();
                let alpha = ((radius - dist) + 0.5).clamp(0.0, 1.0);
                rgba.extend_from_slice(&[r, g, b, (alpha * 255.0) as u8]);
            }
        }
        Icon::from_rgba(rgba, SIZE as u32, SIZE as u32).expect("valid RGBA")
    }

    fn status_text(parsed: &Option<Parsed>, health: Health) -> String {
        match (parsed, health) {
            (_, Health::Unconfigured) => "rechrome: not configured (run `rech setup`)".into(),
            (Some(p), Health::Healthy) => format!("rechrome: connected ✓  {}:{}", p.host, p.port),
            (Some(p), Health::Reachable) => {
                format!("rechrome: reachable, key rejected?  {}:{}", p.host, p.port)
            }
            (Some(p), Health::Down) => format!("rechrome: not running  {}:{}", p.host, p.port),
            (None, _) => "rechrome: not configured (run `rech setup`)".into(),
        }
    }

    fn title(health: Health) -> &'static str {
        match health {
            Health::Healthy => "rech ✓",
            Health::Reachable => "rech ~",
            Health::Down => "rech ✗",
            Health::Unconfigured => "rech ?",
        }
    }

    pub fn run() -> ! {
        // Headless / no-GUI session → bypass the tray entirely (exit cleanly so
        // callers like `rech setup` aren't disrupted on a server or over SSH).
        if !gui_available() {
            eprintln!("rechrome-tray: no desktop GUI session detected — skipping tray.");
            std::process::exit(0);
        }

        #[allow(unused_mut)]
        let mut event_loop = EventLoopBuilder::new().build();

        #[cfg(target_os = "macos")]
        {
            use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
            event_loop.set_activation_policy(ActivationPolicy::Accessory);
        }

        // Menu items are created once (stable ids) and only their text/state is
        // refreshed on each poll.
        let status_item = MenuItem::new("rechrome: …", false, None);
        let open_item = MenuItem::new("Open status page", true, None);
        let restart_item = MenuItem::new("Restart daemon", true, None);
        let stop_item = MenuItem::new("Stop daemon", true, None);
        let copy_item = MenuItem::new("Copy RECHROME_URL", true, None);
        let hide_item = MenuItem::new("Hide (run `rech tray show` to restore)", true, None);
        let quit_item = MenuItem::new("Quit", true, None);

        let (open_id, restart_id, stop_id, copy_id, hide_id, quit_id) = (
            open_item.id().clone(),
            restart_item.id().clone(),
            stop_item.id().clone(),
            copy_item.id().clone(),
            hide_item.id().clone(),
            quit_item.id().clone(),
        );

        let menu = Menu::new();
        let _ = menu.append_items(&[
            &status_item,
            &PredefinedMenuItem::separator(),
            &open_item,
            &restart_item,
            &stop_item,
            &copy_item,
            &PredefinedMenuItem::separator(),
            &hide_item,
            &quit_item,
        ]);

        let mut tray: Option<TrayIcon> = None;
        let mut current: Option<Parsed> = None;
        let mut last_health: Option<Health> = None;
        // Visibility is driven by the shared hidden-flag file (CLI + menu).
        let mut visible = true;
        let menu_channel = MenuEvent::receiver();

        let refresh = |tray: &Option<TrayIcon>,
                       status_item: &MenuItem,
                       current: &mut Option<Parsed>,
                       last_health: &mut Option<Health>| {
            let parsed = read_rechrome_url().and_then(|u| parse_url(&u));
            let health = match &parsed {
                None => Health::Unconfigured,
                Some(p) => probe(p),
            };
            status_item.set_text(status_text(&parsed, health));
            if Some(health) != *last_health {
                if let Some(t) = tray.as_ref() {
                    let _ = t.set_icon(Some(make_icon(health)));
                    let _ = t.set_title(Some(title(health)));
                    let _ = t.set_tooltip(Some(status_text(&parsed, health)));
                }
                *last_health = Some(health);
            }
            *current = parsed;
        };

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::WaitUntil(Instant::now() + POLL_INTERVAL);

            match event {
                Event::NewEvents(StartCause::Init) => {
                    let parsed = read_rechrome_url().and_then(|u| parse_url(&u));
                    let health = match &parsed {
                        None => Health::Unconfigured,
                        Some(p) => probe(p),
                    };
                    status_item.set_text(status_text(&parsed, health));
                    match TrayIconBuilder::new()
                        .with_menu(Box::new(menu.clone()))
                        .with_tooltip(status_text(&parsed, health))
                        .with_title(title(health))
                        .with_icon(make_icon(health))
                        .build()
                    {
                        Ok(t) => tray = Some(t),
                        Err(e) => {
                            // No window server (e.g. headless macOS/Windows) —
                            // bypass cleanly rather than failing the caller.
                            eprintln!("rechrome-tray: no GUI tray available ({e}) — skipping.");
                            std::process::exit(0);
                        }
                    }
                    current = parsed;
                    last_health = Some(health);
                    // Honour a pre-existing hidden flag on startup.
                    visible = !is_hidden();
                    if !visible {
                        if let Some(t) = tray.as_ref() {
                            let _ = t.set_visible(false);
                        }
                    }
                }
                Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                    refresh(&tray, &status_item, &mut current, &mut last_health);
                    // Reconcile visibility with the shared hidden flag.
                    let want = !is_hidden();
                    if want != visible {
                        if let Some(t) = tray.as_ref() {
                            let _ = t.set_visible(want);
                        }
                        visible = want;
                    }
                }
                _ => {}
            }

            while let Ok(ev) = menu_channel.try_recv() {
                if ev.id == quit_id {
                    std::process::exit(0);
                } else if ev.id == restart_id {
                    pm_action("restart");
                } else if ev.id == stop_id {
                    pm_action("stop");
                } else if ev.id == open_id {
                    if let Some(p) = current.as_ref() {
                        open_in_browser(&p.origin());
                    }
                } else if ev.id == copy_id {
                    if let Some(p) = current.as_ref() {
                        copy_to_clipboard(&p.raw);
                    }
                } else if ev.id == hide_id {
                    // Persist the flag so the icon stays hidden across restarts
                    // and `rech tray show` can bring it back.
                    set_hidden_flag();
                    if let Some(t) = tray.as_ref() {
                        let _ = t.set_visible(false);
                    }
                    visible = false;
                }
            }
        })
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn main() {
    imp::run();
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn main() {
    eprintln!("rechrome-tray: the tray icon is only supported on macOS and Windows.");
    std::process::exit(1);
}
