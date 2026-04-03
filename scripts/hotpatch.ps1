# hotpatch.ps1 - Patch server.js from GitHub without a full installer build
# Use for backend-only changes to server.js (no frontend, no new dependencies)
# Run as Administrator on the target machine (site or hub)
#
# Usage:
#   .\hotpatch.ps1
#   .\hotpatch.ps1 -Branch dev        # pull from a specific branch
#   .\hotpatch.ps1 -DryRun            # download only, don't restart service

param(
    [string]$Branch = "main",
    [switch]$DryRun
)

$ServiceName = "CardosoCigarettes"
$AppDir      = "C:\Cardoso Customer App"
$RawUrl      = "https://raw.githubusercontent.com/seantunley/Cardoso-App/$Branch/server.js"
$Backup      = "$AppDir\server.js.bak"

Write-Host "Cardoso Hotpatch" -ForegroundColor Cyan
Write-Host "Branch : $Branch"
Write-Host "AppDir : $AppDir"
Write-Host ""

# Verify install dir exists
if (-not (Test-Path $AppDir)) {
    Write-Error "App directory not found: $AppDir"
    exit 1
}

# Download new server.js to a temp file first
$TempFile = "$env:TEMP\cardoso-server-patch.js"
Write-Host "Downloading server.js from $Branch..." -NoNewline
try {
    Invoke-WebRequest -Uri $RawUrl -OutFile $TempFile -UseBasicParsing -TimeoutSec 30
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Error "Download failed: $_"
    exit 1
}

if ($DryRun) {
    Write-Host "DryRun mode - skipping service restart. Downloaded to: $TempFile" -ForegroundColor Yellow
    exit 0
}

# Stop service
Write-Host "Stopping service $ServiceName..." -NoNewline
try {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " WARNING (service may not be running)" -ForegroundColor Yellow
}

# Back up existing server.js
if (Test-Path "$AppDir\server.js") {
    Copy-Item "$AppDir\server.js" $Backup -Force
    Write-Host "Backup saved: $Backup"
}

# Replace server.js
Copy-Item $TempFile "$AppDir\server.js" -Force
Write-Host "server.js updated."

# Start service
Write-Host "Starting service $ServiceName..." -NoNewline
try {
    Start-Service -Name $ServiceName -ErrorAction Stop
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Warning "Service failed to start. Restoring backup..."
    if (Test-Path $Backup) {
        Copy-Item $Backup "$AppDir\server.js" -Force
        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
        Write-Host "Rollback complete."
    }
    exit 1
}

Write-Host ""
Write-Host "Hotpatch complete." -ForegroundColor Green
