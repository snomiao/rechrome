# rechrome installer — https://rechrome.pages.dev
# Usage: powershell -c "irm rechrome.pages.dev/setup.ps1 | iex"
$ErrorActionPreference = 'Stop'

# 1. Ensure Bun (rechrome runs on Bun >= 1.0)
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host '==> Bun not found — installing from https://bun.sh ...' -ForegroundColor Cyan
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}

# 2. Install rechrome globally (provides `rech` and `rechrome`)
Write-Host '==> Installing rechrome ...' -ForegroundColor Cyan
bun add -g rechrome

# 3. Make sure `rech` is on PATH for this shell
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
if (-not (Get-Command rech -ErrorAction SilentlyContinue)) {
  Write-Host "==> Could not find 'rech' after install. Add to PATH: $env:USERPROFILE\.bun\bin" -ForegroundColor Yellow
  exit 1
}

# 4. Done. We do NOT auto-run setup — `rech setup` is interactive (it installs
# the Chrome extension + starts a daemon) and is only needed on the machine
# that hosts the browser. Print the next step instead.
Write-Host '==> rechrome installed.' -ForegroundColor Green
Write-Host ''
Write-Host '  Next, on the machine with a browser, run first-time setup:'
Write-Host '      rech setup' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Then drive it:  rech open <url>  |  rech screenshot  |  rech tab-list'
Write-Host '  Docs: https://github.com/snomiao/rechrome'
