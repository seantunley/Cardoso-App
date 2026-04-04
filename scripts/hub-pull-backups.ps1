# hub-pull-backups.ps1 — Pull database backups from all sites via the Hub
# -------------------------------------------------------------------------
# Runs on the Head Office machine. Loops through each registered site,
# calls GET /api/backup/download on each site's API URL, and saves the
# .db file locally under database\hub-backups\<site_id>\
#
# Prerequisites:
#   - Hub is running and sites are configured with API URLs + reporting tokens
#   - REPORTING_TOKEN env var matches what each site has set
#
# Schedule with: install-backup-task.bat (set HUB_PULL=1 if needed)
# Or run manually: powershell -ExecutionPolicy Bypass -File hub-pull-backups.ps1

param(
    [string]$AppDir      = "C:\Cardoso Customer App",
    [string]$BackupRoot  = "database\hub-backups",
    [int]   $Keep        = 30,
    [string]$ConfigFile  = ".env"
)

$ErrorActionPreference = "Stop"
$logFile = Join-Path $AppDir "logs\hub-backup.log"

function Write-Log {
    param([string]$msg)
    $ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Add-Content -Path $logFile -Value $line
    Write-Host $line
}

function Get-EnvValue {
    param([string]$File, [string]$Key)
    $envPath = Join-Path $AppDir $File
    if (-not (Test-Path $envPath)) { return $null }
    Get-Content $envPath | ForEach-Object {
        if ($_ -match "^\s*${Key}\s*=\s*(.+)$") { return $Matches[1].Trim().Trim('"').Trim("'") }
    }
    return $null
}

New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null

# ── Read hub URL and token from .env ─────────────────────────────────────
$hubPort  = Get-EnvValue -File $ConfigFile -Key "PORT"
if (-not $hubPort) { $hubPort = "3001" }
$hubUrl   = "http://localhost:$hubPort"
$token    = Get-EnvValue -File $ConfigFile -Key "REPORTING_TOKEN"

if (-not $token) {
    Write-Log "ERROR: REPORTING_TOKEN not found in $ConfigFile — aborting"
    exit 1
}

Write-Log "START hub-pull-backups from $hubUrl"

# ── Fetch site list from hub API ──────────────────────────────────────────
try {
    $sitesRes = Invoke-RestMethod -Uri "$hubUrl/api/hub/sites" `
        -Headers @{ "x-reporting-token" = $token } -Method Get
    # /api/hub/sites returns a JSON array
    $sites = if ($sitesRes -is [array]) { $sitesRes } else { $sitesRes.sites }
} catch {
    Write-Log "ERROR: Could not reach hub API at $hubUrl — $_"
    exit 1
}

if (-not $sites -or $sites.Count -eq 0) {
    Write-Log "WARN: No sites returned from hub. Nothing to back up."
    exit 0
}

Write-Log "Found $($sites.Count) site(s)"

$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$backupDir = Join-Path $AppDir $BackupRoot

foreach ($site in $sites) {
    $siteId  = $site.site_id
    $apiUrl  = $site.url

    if (-not $apiUrl) {
        Write-Log "SKIP $siteId — no api_url configured"
        continue
    }

    $siteDir = Join-Path $backupDir $siteId
    New-Item -ItemType Directory -Force -Path $siteDir | Out-Null

    $destFile = Join-Path $siteDir "cardoso-$siteId-$stamp.db"
    $destEnv  = Join-Path $siteDir "cardoso-$siteId-latest.env"

    try {
        Invoke-WebRequest -Uri "$apiUrl/api/backup/download" `
            -Headers @{ "x-reporting-token" = $token } `
            -OutFile $destFile -UseBasicParsing
        $sizeMb = [math]::Round((Get-Item $destFile).Length / 1MB, 2)
        Write-Log "OK  $siteId → $destFile ($sizeMb MB)"
    } catch {
        Write-Log "ERROR $siteId — DB download failed: $_"
        if (Test-Path $destFile) { Remove-Item $destFile -Force }
        continue
    }

    # Pull site .env for disaster recovery
    try {
        Invoke-WebRequest -Uri "$apiUrl/api/backup/config" `
            -Headers @{ "x-reporting-token" = $token } `
            -OutFile $destEnv -UseBasicParsing
        Write-Log "OK  $siteId → .env backed up"
    } catch {
        Write-Log "WARN $siteId — .env backup failed (non-fatal): $_"
    }

    # Rotate old backups for this site
    $allBackups = Get-ChildItem -Path $siteDir -Filter "cardoso-$siteId-*.db" |
        Sort-Object LastWriteTime -Descending
    if ($allBackups.Count -gt $Keep) {
        $toDelete = $allBackups | Select-Object -Skip $Keep
        foreach ($f in $toDelete) {
            Remove-Item $f.FullName -Force
            Write-Log "DEL $siteId — removed old backup: $($f.Name)"
        }
    }
}

Write-Log "DONE hub-pull-backups complete"
exit 0
