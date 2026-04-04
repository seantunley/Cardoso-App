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
    Write-Log "ERROR: Copy failed - $_"
    exit 1
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
