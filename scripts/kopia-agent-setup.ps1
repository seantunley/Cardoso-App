# Cardoso — one-time Kopia site agent setup.
#
# Connects this site to the hub Kopia repository server and schedules the daily
# snapshot. Idempotent: safe to re-run (re-connects + replaces the task). This
# is the manual/pilot path described in docs/kopia-backups.md Part B; the
# installer will eventually run the equivalent automatically (Stage 3b).
#
# PREREQUISITE: the hub must already be running the Kopia server (docs Part A) —
# you need its URL, the SHA256 cert fingerprint it printed, and this site's
# server username/password.
#
# IMPORTANT — run AS THE SAME ACCOUNT the scheduled task will run under, so the
# kopia repository connection (cached per-user) is visible to the task. By
# default the task runs as SYSTEM; run this script as SYSTEM too, e.g.:
#     PsExec64.exe -s -i powershell.exe -ExecutionPolicy Bypass -File kopia-agent-setup.ps1 ...
# or pass -TaskUser '<account>' and run this script as that account.
#
# Example:
#   .\kopia-agent-setup.ps1 -HubUrl https://hub.tail1234.ts.net:51515 `
#       -CertFingerprint a1b2c3... -SiteName Ermelo -ServerPassword '<secret>'

param(
  [Parameter(Mandatory = $true)][string]$HubUrl,           # https://<hub>:51515
  [Parameter(Mandatory = $true)][string]$CertFingerprint,  # SHA256 from `kopia server start`
  [Parameter(Mandatory = $true)][string]$SiteName,         # becomes the snapshot hostname
  [Parameter(Mandatory = $true)][string]$ServerPassword,   # this site's server-user password
  [string]$ServerUsername = 'cardoso',
  [string]$AppDir   = 'C:\Cardoso Customer App',
  [string]$KopiaExe = 'C:\Cardoso Customer App\kopia\kopia.exe',
  [string]$SnapshotTime = '02:30',
  [string]$TaskUser = 'SYSTEM'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $KopiaExe)) { throw "kopia not found at $KopiaExe - install it first (see docs Part A/B)." }
if (-not (Test-Path $AppDir))   { throw "app dir not found at $AppDir" }

# 1. Write .kopiaignore at the app root. Excludes the reinstallable binaries
#    (the installer recreates them) and the live WAL database (snapshot the
#    consistent database\backups\ copy instead). Everything else under the app
#    folder — .env, database\backups, all of uploads\ — is captured.
$ignore = @'
/node_modules/
/node/
/dist/
/src/
/nssm/
/logs/
*.exe
/database/cardoso.db
/database/cardoso.db-wal
/database/cardoso.db-shm
/database/tmp-backups/
/uploads/bat-pdf-cache/
'@
Set-Content -Path (Join-Path $AppDir '.kopiaignore') -Value $ignore -Encoding utf8
Write-Host "Wrote $($AppDir)\.kopiaignore"

# 2. Connect to the hub repository server (idempotent — re-running re-points
#    the connection). The repo's encryption password lives on the hub; this
#    site authenticates with its own server username/password.
& $KopiaExe repository connect server `
  --url=$HubUrl `
  --server-cert-fingerprint=$CertFingerprint `
  --override-username=$ServerUsername `
  --override-hostname=$SiteName `
  --password=$ServerPassword
if ($LASTEXITCODE -ne 0) { throw "kopia repository connect failed (exit $LASTEXITCODE)" }
Write-Host "Connected to $HubUrl as $ServerUsername@$SiteName"

# 3. Register the daily snapshot Scheduled Task (replaces any existing one).
$snapScript = Join-Path $AppDir 'scripts\kopia-snapshot.ps1'
if (-not (Test-Path $snapScript)) { throw "snapshot script missing at $snapScript" }

$arg = "-NonInteractive -ExecutionPolicy Bypass -File `"$snapScript`" -AppDir `"$AppDir`" -KopiaExe `"$KopiaExe`""
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger   = New-ScheduledTaskTrigger -Daily -At $SnapshotTime
$principal = New-ScheduledTaskPrincipal -UserId $TaskUser -RunLevel Highest -LogonType ServiceAccount
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 4)

Register-ScheduledTask -TaskName 'CardosoKopiaAgent' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Registered Scheduled Task 'CardosoKopiaAgent' (daily $SnapshotTime as $TaskUser)"

Write-Host ""
Write-Host "Done. Verify with a manual run now:"
Write-Host "    powershell -ExecutionPolicy Bypass -File `"$snapScript`""
Write-Host "Then confirm on the hub: the site should appear green on the Hub Backups page."
