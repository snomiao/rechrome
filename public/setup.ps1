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

# 4. Run first-time setup (daemon + Chrome extension + config)
Write-Host '==> Running ''rech setup'' ...' -ForegroundColor Cyan
rech setup

Write-Host "All set. Drive your browser with 'rech open <url>' / 'rech screenshot'." -ForegroundColor Green
Write-Host "Docs: https://github.com/snomiao/rechrome"
