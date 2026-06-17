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

# 4. Done. We do NOT auto-run setup — `rech setup` is interactive (it installs
# the Chrome extension + starts a daemon) and is only needed on the machine
# that hosts the browser. Print the next step instead.
info "rechrome installed."
printf '\n  Next, on the machine with a browser, run first-time setup:\n'
printf '      \033[1mrech setup\033[0m\n\n'
printf '  Then drive it:  rech open <url>  |  rech screenshot  |  rech tab-list\n'
printf '  Docs: https://github.com/snomiao/rechrome\n'
