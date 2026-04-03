# hotpatch.ps1 - Pull latest code from GitHub and restart the Cardoso service
# Works with the refactored multi-file structure (src/routes, src/db, etc.)
# Run as Administrator on the target machine (site or hub)
#
# Usage:
#   .\hotpatch.ps1
#   .\hotpatch.ps1 -Branch dev        # pull from a specific branch

param(
    [string]$Branch = "main"
)

$ServiceName = "CardosoCigarettes"
$AppDir      = "C:\Cardoso Customer App"

Write-Host "Cardoso Hotpatch" -ForegroundColor Cyan
Write-Host "Branch : $Branch"
Write-Host "AppDir : $AppDir"
Write-Host ""

# Verify install dir exists
if (-not (Test-Path $AppDir)) {
    Write-Error "App directory not found: $AppDir"
    exit 1
}

# Verify git is available
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git not found. Install Git for Windows and ensure it is on PATH."
    exit 1
}

Set-Location $AppDir

# Stop service
Write-Host "Stopping service $ServiceName..." -NoNewline
try {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " WARNING (service may not be running)" -ForegroundColor Yellow
}

# Pull latest code
Write-Host "Pulling latest code from $Branch..." -NoNewline
$gitOutput = git pull origin $Branch 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host $gitOutput
    Write-Warning "git pull failed. Starting service with existing code."
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    exit 1
}
Write-Host " OK" -ForegroundColor Green
Write-Host $gitOutput

# Start service
Write-Host "Starting service $ServiceName..." -NoNewline
try {
    Start-Service -Name $ServiceName -ErrorAction Stop
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Error "Service failed to start: $_"
    exit 1
}

Write-Host ""
Write-Host "Hotpatch complete." -ForegroundColor Green
