#!/usr/bin/env bash
# rechrome installer — https://rechrome.pages.dev
# Usage: curl -fsSL rechrome.pages.dev/setup.sh | bash
set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }

# 1. Ensure Bun (rechrome runs on Bun >= 1.0)
if ! command -v bun >/dev/null 2>&1; then
  info "Bun not found — installing from https://bun.sh ..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# 2. Install rechrome globally (provides `rech` and `rechrome`)
info "Installing rechrome ..."
bun add -g rechrome

# 3. Make sure `rech` is on PATH for this shell
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
export PATH="$BUN_BIN:$PATH"
if ! command -v rech >/dev/null 2>&1; then
  warn "Could not find 'rech' after install. Add Bun's global bin to your PATH:"
  warn "  export PATH=\"$BUN_BIN:\$PATH\""
  exit 1
fi

# 4. Run first-time setup (daemon + Chrome extension + config).
# When piped via `curl ... | bash`, stdin is the script, so reconnect the
# terminal for the interactive prompts; fall back to non-interactive otherwise.
info "Running 'rech setup' ..."
if [ -t 1 ] && [ -r /dev/tty ]; then
  rech setup </dev/tty
else
  rech setup || true
fi

info "All set. Drive your browser with 'rech open <url>' / 'rech screenshot'."
info "Docs: https://github.com/snomiao/rechrome"
