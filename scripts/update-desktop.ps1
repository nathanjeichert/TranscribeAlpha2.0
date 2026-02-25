# update-desktop.ps1
# Pulls latest main, rebuilds the Tauri desktop app, and installs it.
# Run from the repo root, e.g.:  .\scripts\update-desktop.ps1

param(
    [switch]$SkipPython,   # skip rebuilding the Python sidecar
    [switch]$SkipInstall   # skip launching the installer after build
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$FrontendDir = Join-Path $RepoRoot "frontend-next"
$BinariesDir = Join-Path $FrontendDir "src-tauri\binaries"
$Triple = "x86_64-pc-windows-msvc"

function Log($msg) { Write-Host "[update-desktop] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# ── 1. Pull latest main ───────────────────────────────────────────────────────
Log "Pulling latest from origin/main..."
Push-Location $RepoRoot
$before = git rev-parse HEAD
git fetch origin main | Out-Host
git reset --hard origin/main | Out-Host
$after = git rev-parse HEAD

if ($before -eq $after) {
    Log "Already up to date ($after). Nothing changed — skipping rebuild."
    Pop-Location
    exit 0
}
Log "Updated $before -> $after"

# ── 2. Python sidecar ────────────────────────────────────────────────────────
if (-not $SkipPython) {
    Log "Installing Python requirements..."
    pip install -r requirements.txt --quiet | Out-Host

    Log "Building Python sidecar with PyInstaller..."
    New-Item -ItemType Directory -Force -Path $BinariesDir | Out-Null
    pyinstaller backend/sidecar.spec `
        --distpath "$BinariesDir" `
        --workpath "$RepoRoot\.pyinstaller-build" `
        --noconfirm | Out-Host

    $exeSrc = Join-Path $BinariesDir "transcribealpha-server-$Triple.exe"
    if (-not (Test-Path $exeSrc)) {
        Die "PyInstaller did not produce $exeSrc"
    }
    Log "Python sidecar built: $exeSrc"
}

# ── 3. FFmpeg sidecar ────────────────────────────────────────────────────────
$ffmpegDst = Join-Path $BinariesDir "ffmpeg-$Triple.exe"
if (-not (Test-Path $ffmpegDst)) {
    Log "ffmpeg sidecar not found — downloading..."
    $zip = Join-Path $env:TEMP "ffmpeg-win64.zip"
    Invoke-WebRequest `
        -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" `
        -OutFile $zip -UseBasicParsing
    $extract = Join-Path $env:TEMP "ffmpeg-extract"
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $ffmpegExe = Get-ChildItem -Recurse -Filter "ffmpeg.exe" $extract | Select-Object -First 1
    if (-not $ffmpegExe) { Die "ffmpeg.exe not found in archive" }
    Copy-Item $ffmpegExe.FullName $ffmpegDst
    Log "FFmpeg sidecar ready: $ffmpegDst"
} else {
    Log "FFmpeg sidecar already present — skipping download."
}

# ── 4. npm install ───────────────────────────────────────────────────────────
Log "Running npm install..."
Push-Location $FrontendDir
npm install | Out-Host

# ── 5. Tauri build ───────────────────────────────────────────────────────────
Log "Building Tauri app (this takes a few minutes)..."
# Ensure Rust/cargo is in PATH
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri:build | Out-Host

# ── 6. Install ───────────────────────────────────────────────────────────────
if (-not $SkipInstall) {
    $installer = Get-ChildItem -Recurse `
        -Path (Join-Path $FrontendDir "src-tauri\target\release\bundle") `
        -Include "*.msi","*-setup.exe" | Select-Object -First 1
    if ($installer) {
        Log "Launching installer: $($installer.FullName)"
        Start-Process -FilePath $installer.FullName -Wait
    } else {
        Log "No installer found — check src-tauri/target/release/bundle/"
    }
}

Pop-Location
Pop-Location
Log "Done!"
