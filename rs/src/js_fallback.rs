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
    let candidates = runtimes(&script);
    let mut last_error = None;
    for runtime in &candidates {
        let mut command = program(&runtime[0]);
        command.args(&runtime[1..]).arg(&script).args(&args);
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
    let tried: Vec<&str> = candidates.iter().map(|c| c[0].as_str()).collect();
    eprintln!(
        "cannot run {}: none of {} could be started ({})",
        script.display(),
        tried.join(", "),
        last_error.map(|e| e.to_string()).unwrap_or_default()
    );
    std::process::exit(127);
}

/// The commands to try for running `script`, in order. First what the
/// script's own `#!` line names, because that is what ran it before this
/// binary existed; then bun and node, whichever is installed.
fn runtimes(script: &std::path::Path) -> Vec<Vec<String>> {
    let head = std::fs::read(script).unwrap_or_default();
    let first_line = String::from_utf8_lossy(&head[..head.len().min(512)]).lines().next().unwrap_or("").to_string();
    let is_typescript = matches!(
        script.extension().and_then(|e| e.to_str()),
        Some("ts" | "mts" | "cts" | "tsx")
    );
    let mut list: Vec<Vec<String>> = interpreter(&first_line).into_iter().collect();
    // node cannot be relied on to run TypeScript, so it is only tried for a
    // TypeScript entry when the entry asks for it.
    let fallbacks: &[&str] = if is_typescript { &["bun"] } else { &["bun", "node"] };
    for name in fallbacks {
        if !list.iter().any(|c| c[0] == *name) {
            list.push(vec![name.to_string()]);
        }
    }
    list
}

/// The command a `#!` line asks for, without its directory:
/// `#!/usr/bin/env node` is `["node"]`, `#!/usr/bin/env -S npx tsx` is
/// `["npx", "tsx"]`, and a line that is not a `#!` line is `None`.
fn interpreter(first_line: &str) -> Option<Vec<String>> {
    let mut words = first_line.strip_prefix("#!")?.split_whitespace();
    let name = |path: &str| path.rsplit(['/', '\\']).next().unwrap_or(path).to_string();
    let first = name(words.next()?);
    let command: Vec<String> = if first == "env" {
        // Skip env's own flags (-S) and VAR=value settings.
        words.skip_while(|w| w.starts_with('-') || w.contains('=')).map(String::from).collect()
    } else {
        std::iter::once(first).chain(words.map(String::from)).collect()
    };
    (!command.is_empty()).then_some(command)
}

/// A command for `name`. On Windows, tools installed by a package manager
/// (npx, tsx, …) are `.cmd` files, which have to be started through cmd.
fn program(name: &str) -> Command {
    #[cfg(windows)]
    if !matches!(name, "bun" | "node" | "deno") {
        let mut command = Command::new("cmd");
        command.args(["/C", name]);
        return command;
    }
    Command::new(name)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn names(script: &std::path::Path) -> Vec<String> {
        runtimes(script).into_iter().map(|c| c.join(" ")).collect()
    }

    #[test]
    fn the_shebang_names_the_interpreter() {
        assert_eq!(interpreter("#!/usr/bin/env node"), Some(vec!["node".to_string()]));
        assert_eq!(interpreter("#!/usr/bin/env bun"), Some(vec!["bun".to_string()]));
        assert_eq!(interpreter("#!/usr/local/bin/node --no-warnings").unwrap(), ["node", "--no-warnings"]);
        assert_eq!(interpreter("#!/usr/bin/env -S npx tsx").unwrap(), ["npx", "tsx"]);
        assert_eq!(interpreter("#!/usr/bin/env npx tsx").unwrap(), ["npx", "tsx"]);
        assert_eq!(interpreter("#! /usr/bin/env  FOO=1 node").unwrap(), ["node"]);
        assert_eq!(interpreter("import x from \"y\";"), None);
        assert_eq!(interpreter("#!/usr/bin/env"), None);
        assert_eq!(interpreter(""), None);
    }

    #[test]
    fn the_script_decides_which_runtime_is_tried_first() {
        let dir = std::env::temp_dir().join(format!("rustify-fallback-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str, text: &str| {
            let path = dir.join(name);
            std::fs::write(&path, text).unwrap();
            path
        };
        assert_eq!(names(&file("a.js", "#!/usr/bin/env node\nx")), ["node", "bun"]);
        assert_eq!(names(&file("b.js", "#!/usr/bin/env bun\nx")), ["bun", "node"]);
        assert_eq!(names(&file("c.js", "console.log(1)")), ["bun", "node"]);
        assert_eq!(names(&file("d.ts", "#!/usr/bin/env bun\nx")), ["bun"]);
        assert_eq!(names(&file("e.ts", "#!/usr/bin/env npx tsx\nx")), ["npx tsx", "bun"]);
        assert_eq!(names(&file("f.ts", "#!/usr/bin/env node\nx")), ["node", "bun"]);
        assert_eq!(names(&dir.join("missing.js")), ["bun", "node"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
