# backup.ps1 - Cardoso Cigarettes local database backup
# Copies the live SQLite database to a timestamped file in the backups folder.
# Keeps the last 30 daily backups and deletes older ones automatically.
#
# Run manually:  powershell -ExecutionPolicy Bypass -File backup.ps1
# Scheduled:     Use install-backup-task.bat to register a daily Task Scheduler job.

param(
    [string]$AppDir  = "C:\Cardoso Customer App",
    [string]$DbFile  = "database\cardoso.db",
    [string]$BackDir = "database\backups",
    [int]   $Keep    = 30
)

$ErrorActionPreference = "Stop"
$logFile = Join-Path $AppDir "logs\backup.log"

function Write-Log {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Add-Content -Path $logFile -Value $line
    Write-Host $line
}

$srcDb = Join-Path $AppDir $DbFile
$srcEnv = Join-Path $AppDir ".env"
$backupRoot = Join-Path $AppDir $BackDir

New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

if (-not (Test-Path $srcDb)) {
    Write-Log "ERROR: Database not found at $srcDb - aborting"
    exit 1
}

$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$siteId = if ($env:SITE_ID) { $env:SITE_ID } else { "site" }
$destFile = Join-Path $backupRoot "cardoso-$siteId-$stamp.db"

try {
    Copy-Item -Path $srcDb -Destination $destFile -Force
    $sizeMb = [math]::Round((Get-Item $destFile).Length / 1MB, 2)
    Write-Log "OK Backup saved to $destFile ($sizeMb MB)"
} catch {
    Write-Log "ERROR: DB copy failed - $_"
    exit 1
}

# Backup .env (site identity + secrets — required for disaster recovery)
if (Test-Path $srcEnv) {
    $destEnv = Join-Path $backupRoot "cardoso-$siteId-latest.env"
    try {
        Copy-Item -Path $srcEnv -Destination $destEnv -Force
        Write-Log "OK .env backed up to $destEnv"
    } catch {
        Write-Log "WARN: .env backup failed - $_ (non-fatal)"
    }
} else {
    Write-Log "WARN: .env not found at $srcEnv — skipping config backup"
}

$allBackups = Get-ChildItem -Path $backupRoot -Filter "cardoso-*.db" |
    Sort-Object LastWriteTime -Descending

if ($allBackups.Count -gt $Keep) {
    $toDelete = $allBackups | Select-Object -Skip $Keep
    foreach ($f in $toDelete) {
        Remove-Item $f.FullName -Force
        Write-Log "DEL Removed old backup: $($f.Name)"
    }
}

$retained = $allBackups.Count
if ($retained -gt $Keep) { $retained = $Keep }
Write-Log "DONE $retained backup(s) retained in $backupRoot"
exit 0
