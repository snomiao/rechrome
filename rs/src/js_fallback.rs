//! rustify JS fallback v1 — copy into the crate as `src/js_fallback.rs`.
//!
//! For the time when the Rust binary is already the command users run but some
//! commands still exist only in the package's JavaScript. The binary handles
//! what it has ported and hands everything else to the old entry point:
//!
//! ```ignore
//! match command {
//!     "send" | "search" => run_natively(),
//!     _ => js_fallback::run("dist/cli.js"), // never returns
//! }
//! ```
//!
//! Ported commands start at native speed; the others behave exactly as before.
//! Delete this file when nothing falls back any more.

use std::path::PathBuf;
use std::process::Command;

/// Environment variable the npm launcher sets to the package directory when
/// the binary runs from the platform package. Use the same name as
/// `rustify.rootEnv` in package.json, and make it specific to the project
/// (`MYCLI_PACKAGE_ROOT`) so one tool starting another does not inherit it.
pub const ROOT_ENV: &str = "RECHROME_PACKAGE_ROOT";

/// Directory of the npm package this binary was installed with, if any.
pub fn package_root() -> Option<PathBuf> {
    // Installed and linked: the binary is <package>/bin/<command>, and the
    // packer puts a package.json marker next to it.
    if let Ok(exe) = std::env::current_exe() {
        // macOS reports the path the command was started through, and for an
        // npm install that is a symlink in the package manager's bin directory.
        #[cfg(unix)]
        let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
        if let Some(bin) = exe.parent() {
            if bin.join("package.json").is_file() {
                if let Some(root) = bin.parent() {
                    if root.join("package.json").is_file() {
                        return Some(root.to_path_buf());
                    }
                }
            }
        }
    }
    // Running from the platform package: the launcher told us.
    let root = PathBuf::from(std::env::var_os(ROOT_ENV)?);
    root.join("package.json").is_file().then_some(root)
}

/// Runs the package's JavaScript entry with this process's arguments and ends
/// the process with its exit code. `entry` is relative to the package root.
pub fn run(entry: &str) -> ! {
    let Some(root) = package_root() else {
        eprintln!(
            "this command is not available in the standalone binary yet; \
             install the npm package to use it"
        );
        std::process::exit(1);
    };
    let script = root.join(entry);
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let mut last_error = None;
    for runtime in ["bun", "node"] {
        let mut command = Command::new(runtime);
        command.arg(&script).args(&args);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Replaces this process, so signals and the exit code need no relaying.
            last_error = Some(command.exec());
        }
        #[cfg(not(unix))]
        {
            #[cfg(windows)]
            stay_alive_on_ctrl_c();
            match command.status() {
                Ok(status) => std::process::exit(status.code().unwrap_or(1)),
                Err(err) => last_error = Some(err),
            }
        }
    }
    eprintln!(
        "cannot run {}: neither bun nor node could be started ({})",
        script.display(),
        last_error.map(|e| e.to_string()).unwrap_or_default()
    );
    std::process::exit(127);
}

/// Ctrl+C reaches every process attached to the console. Without a handler
/// this process would end at once and hand the prompt back while the
/// JavaScript is still shutting down. With one it waits, and exits with the
/// child's exit code. A handler, unlike the "ignore Ctrl+C" flag, is not
/// inherited, so the child still gets the key press.
#[cfg(windows)]
fn stay_alive_on_ctrl_c() {
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    unsafe extern "system" fn handled(_event: u32) -> i32 {
        1
    }
    unsafe {
        SetConsoleCtrlHandler(Some(handled), 1);
    }
}
