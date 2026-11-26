//! rechrome — Rust entry point.
//!
//! Installed from npm, this binary is the command users run. A command runs
//! here once it has been ported and a parity test shows it behaves like the
//! TypeScript; until then it is handed back to the JavaScript the package
//! still ships, so nothing changes for users.

mod js_fallback;

/// The package's JavaScript entry, relative to the package root.
const JS_ENTRY: &str = "rechrome.ts";

/// `RECHROME_NO_NATIVE=1` hands every command back to the JavaScript: the way
/// out for a user if a ported command misbehaves.
#[allow(dead_code)]
fn native() -> bool {
    std::env::var_os("RECHROME_NO_NATIVE").is_none()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // Ported commands go here, one arm each, once their parity cases pass:
        //   Some("status") if native() => status::run(&args[1..]),
        _ => js_fallback::run(JS_ENTRY),
    }
}
