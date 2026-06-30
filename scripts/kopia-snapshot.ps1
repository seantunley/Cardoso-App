# Cardoso — Kopia daily snapshot (site agent).
#
# Run by the Scheduled Task "CardosoKopiaAgent" that kopia-agent-setup.ps1
# registers. Snapshots the whole app folder; the .kopiaignore at the app root
# (written by the setup script) excludes the reinstallable binaries and the
# live WAL database — Kopia snapshots database\backups\ instead, which holds the
# consistent db.backup() copy the site already makes at 02:00. See
# docs/kopia-backups.md.
#
# Exit 0 on success, 1 on failure (so the Scheduled Task's Last Run Result and
# the hub-side kopia-site-stale alert both reflect reality).

param(
  [string]$AppDir   = $(if ($env:KOPIA_SOURCE_DIR) { $env:KOPIA_SOURCE_DIR } else { 'C:\Cardoso Customer App' }),
  [string]$KopiaExe = $(if ($env:KOPIA_EXE) { $env:KOPIA_EXE } else { 'C:\Cardoso Customer App\kopia\kopia.exe' }),
  # Refuse to snapshot if the newest local DB backup is older than this. Stops
  # the agent shipping STALE data and reporting success when the 02:00 local
  # backup failed - the worst outcome (an off-site copy that looks fine but is
  # old, discovered only at restore). 0 disables the check. Default 26h.
  [int]$MaxSourceAgeHours = $(if ($env:KOPIA_MAX_SOURCE_AGE_HOURS) { [int]$env:KOPIA_MAX_SOURCE_AGE_HOURS } else { 26 })
)

$ErrorActionPreference = 'Stop'

# Validate the source FIRST — before creating <AppDir>\logs. New-Item -Force
# would auto-create a mistyped/missing -AppDir, making the guard below pass and
# letting kopia snapshot a brand-new empty directory — a false green with no
# real backup. So bail (to console; there's no log dir yet) if it's wrong.
if (-not (Test-Path $KopiaExe)) { Write-Error "kopia not found at $KopiaExe"; exit 1 }
if (-not (Test-Path $AppDir))   { Write-Error "app dir not found at $AppDir"; exit 1 }

$logDir = Join-Path $AppDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'kopia-agent.log'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date).ToString('s'), $msg
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

try {
  # SOURCE-FRESHNESS GUARD. The off-site copy is only as fresh as the local
  # db.backup() output in database\backups\. If the 02:00 local backup failed,
  # that folder still holds yesterday's .db - snapshotting it would ship STALE
  # data and report success (off-site "fine" but old). Refuse instead, so the
  # missing fresh snapshot ages the off-site chip to red (kopia-site-stale) and
  # the failure is visible NOW, not at restore time. Disabled when
  # MaxSourceAgeHours <= 0.
  if ($MaxSourceAgeHours -gt 0) {
    $backupsDir = Join-Path $AppDir 'database\backups'
    $newest = $null
    if (Test-Path $backupsDir) {
      $newest = Get-ChildItem -Path $backupsDir -Filter '*.db' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if (-not $newest) {
      Write-Log "REFUSING to snapshot: no local DB backup found in $backupsDir (local backup never ran?)."
      exit 1
    }
    $ageH = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalHours, 1)
    if ($ageH -gt $MaxSourceAgeHours) {
      Write-Log "REFUSING to snapshot: newest local backup $($newest.Name) is $ageH h old (> $MaxSourceAgeHours h). The local 02:00 backup likely failed - not shipping stale data off-site."
      exit 1
    }
    Write-Log "Source fresh: newest local backup $($newest.Name) is $ageH h old."
  }

  Write-Log "snapshot start -> $AppDir"
  # Quote the source — the path contains a space. The repo connection was
  # established once by kopia-agent-setup.ps1 and is cached in this account's
  # kopia config, so no password is needed here.
  & $KopiaExe snapshot create "$AppDir"
  if ($LASTEXITCODE -ne 0) { throw "kopia snapshot create exited $LASTEXITCODE" }
  Write-Log "snapshot OK"
  exit 0
} catch {
  Write-Log ("snapshot FAILED: " + $_.Exception.Message)
  exit 1
}
