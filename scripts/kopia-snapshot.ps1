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
  [string]$KopiaExe = $(if ($env:KOPIA_EXE) { $env:KOPIA_EXE } else { 'C:\Cardoso Customer App\kopia\kopia.exe' })
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
