# Cardoso - Kopia restore helper (run on the HUB or a recovery box).
#
# Restores a site's backed-up data tree from the hub Kopia repository to a
# staging folder, then prints the exact hand-off steps to bring the site back.
# It deliberately does NOT touch a live site automatically - a restore replaces
# the database, so the final swap is a manual, deliberate step (or use the
# in-app "Restore..." button on the Hub Backups page for the push flow).
#
# See docs/kopia-backups.md Part F.
#
# Prereqs: kopia.exe present, the repo password in $env:KOPIA_PASSWORD, and the
# shared config file (on the hub) so this sees the same repo the service serves.
#
# Examples:
#   $env:KOPIA_PASSWORD = '<repo password>'
#   # List a site's snapshots:
#   .\kopia-restore.ps1 -SiteName Ermelo -ListOnly
#   # Restore the latest snapshot to C:\restore\Ermelo:
#   .\kopia-restore.ps1 -SiteName Ermelo
#   # Restore a specific snapshot id:
#   .\kopia-restore.ps1 -SiteName Ermelo -SnapshotId k0f3...e9 -Destination D:\dr\ermelo

param(
  [Parameter(Mandatory = $true)][string]$SiteName,
  [string]$SnapshotId,
  [string]$Destination,
  [switch]$ListOnly,
  [string]$KopiaExe   = 'C:\Cardoso Hub\kopia\kopia.exe',
  [string]$ConfigFile = 'C:\Cardoso Hub\kopia\repository.config',
  [string]$ServerUsername = 'cardoso'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $KopiaExe)) { throw "kopia not found at $KopiaExe" }
if (-not $env:KOPIA_PASSWORD)   { throw "set `$env:KOPIA_PASSWORD to the repo encryption password first" }

# Common --config-file arg (only when the file exists; a clean recovery box uses
# the default profile config).
$cfg = @()
if ($ConfigFile -and (Test-Path $ConfigFile)) { $cfg = @('--config-file', $ConfigFile) }

$source = "$ServerUsername@$SiteName" + ':C:\Cardoso Customer App'

Write-Host "Snapshots for $source :" -ForegroundColor Cyan
# --json so we can pick the latest deterministically; the source path has a
# space, so it is passed as one argument.
$listJson = & $KopiaExe @cfg snapshot list "$source" --json
if ($LASTEXITCODE -ne 0) { throw "kopia snapshot list failed ($LASTEXITCODE)" }

$snaps = @()
try { $snaps = $listJson | ConvertFrom-Json } catch { $snaps = @() }
if (-not $snaps -or $snaps.Count -eq 0) {
  throw "No snapshots found for $source. Check the site name (it's the agent's --override-hostname) and that the agent has run."
}

# Show a compact table (newest last in kopia's output).
$snaps | ForEach-Object {
  $sz = if ($_.stats.totalSize) { '{0:N1} MB' -f ($_.stats.totalSize / 1MB) } else { '?' }
  "  {0}  {1}  {2}" -f $_.id, ($_.endTime), $sz | Write-Host
}

if ($ListOnly) { return }

# Pick the snapshot: explicit id, else the newest by endTime.
$target = if ($SnapshotId) {
  $snaps | Where-Object { $_.id -eq $SnapshotId } | Select-Object -First 1
} else {
  $snaps | Sort-Object { [datetime]$_.endTime } | Select-Object -Last 1
}
if (-not $target) { throw "Snapshot '$SnapshotId' not found for $source" }

if (-not $Destination) { $Destination = Join-Path 'C:\restore' $SiteName }
if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Path $Destination -Force | Out-Null }

Write-Host ""
Write-Host "Restoring snapshot $($target.id) ($($target.endTime)) -> $Destination" -ForegroundColor Cyan
& $KopiaExe @cfg restore $target.id "$Destination"
if ($LASTEXITCODE -ne 0) { throw "kopia restore failed ($LASTEXITCODE)" }

Write-Host ""
Write-Host "Restore complete -> $Destination" -ForegroundColor Green
Write-Host "Next steps to bring the site back (run ON THE SITE):" -ForegroundColor Yellow
Write-Host "  1. Stop the service:   nssm stop CardosoCigarettes"
Write-Host "  2. Restore the DB:     copy the newest '$Destination\database\backups\cardoso-*.db'"
Write-Host "                         over 'C:\Cardoso Customer App\database\cardoso.db'"
Write-Host "                         (delete any stale cardoso.db-wal / cardoso.db-shm)"
Write-Host "  3. Restore uploads:    copy '$Destination\uploads\*' over 'C:\Cardoso Customer App\uploads\'"
Write-Host "  4. Restore config:     copy '$Destination\.env' if you are rebuilding the site identity"
Write-Host "  5. Start the service:  nssm start CardosoCigarettes"
Write-Host ""
Write-Host "Tip: for an in-place push restore of just the DB (+ previews), use the"
Write-Host "     'Restore...' button on the Hub Backups page instead."
