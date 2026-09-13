# Local CRX packer (Windows). Uses Chrome/Chromium/Helium --pack-extension.
# Usage:
#   .\tools\pack.ps1
#   .\tools\pack.ps1 -ChromePath "C:\...\chrome.exe"
# Keep key.pem secret. Same key => same extension ID => in-place upgrades.

param(
  [string]$ChromePath = "",
  [string]$OutDir = "dist-out"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not $ChromePath) {
  $candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\imput\Helium\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $ChromePath = $c; break }
  }
}
if (-not $ChromePath -or -not (Test-Path $ChromePath)) {
  throw "No Chromium browser found. Pass -ChromePath."
}

$stage = Join-Path $root "dist"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$files = @(
  "manifest.json", "background.js", "bridge.js", "inject.js",
  "popup.html", "popup.js", "harvester.html", "harvester.js",
  "ytm_harvester_cs.js", "icon16.png", "icon48.png", "icon128.png", "logo.svg"
)
foreach ($f in $files) {
  Copy-Item (Join-Path $root $f) (Join-Path $stage $f)
}

$key = Join-Path $root "key.pem"
$chromeArgs = @("--pack-extension=$stage")
if (Test-Path $key) {
  $chromeArgs += "--pack-extension-key=$key"
}
$chromeArgs += "--no-message-box"

$p = Start-Process -FilePath $ChromePath -ArgumentList $chromeArgs -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { throw "pack failed exit=$($p.ExitCode)" }

New-Item -ItemType Directory -Force -Path (Join-Path $root $OutDir) | Out-Null
$crx = Join-Path $root "dist.crx"
if (-not (Test-Path $crx)) { throw "dist.crx not produced" }

$ver = (Get-Content (Join-Path $stage "manifest.json") -Raw | ConvertFrom-Json).version
$dest = Join-Path $root "$OutDir\ytspoofingstream-vorapis-$ver.crx"
Move-Item $crx $dest -Force

if (-not (Test-Path $key) -and (Test-Path "dist.pem")) {
  Move-Item "dist.pem" $key
  Write-Host "Generated new key.pem - store as secret CRX_PEM_BASE64 for future upgrades."
}

if (Test-Path $key) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $id = & $nodeCmd.Source (Join-Path $root "tools\extid.js") $key
    Write-Host "Extension ID: $id"
    Write-Host "update_url appid must match that ID."
  }
}

Write-Host "Packed: $dest"
