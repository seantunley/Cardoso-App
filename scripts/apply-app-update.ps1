# Apply an "app delta" update — extracts an app-vX.zip over the install dir,
# preserving node_modules, the bundled node runtime, nssm, the database, the
# .env file, and the logs directory. Used by the in-app auto-updater when the
# new release's lock_hash matches the installed lock_hash (i.e. dependencies
# haven't changed since the last full install). Saves ~95MB per update vs.
# re-running the full EXE installer.
#
# Called by triggerWindowsUpdate() in src/routes/system.js — runs detached
# in PowerShell. The Node service is still running when this script starts;
# it stops it, swaps the files, restarts it.
#
# On any failure the script restores the previous version from .backup-<ts>
# before re-starting the service, so a partial extract or a service that
# fails to come up never leaves the install in a broken state.

param(
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [Parameter(Mandatory=$false)][string]$ExpectedSha256,
  [Parameter(Mandatory=$false)][string]$AppDir = "C:\Cardoso Customer App",
  [Parameter(Mandatory=$false)][string]$ServiceName = "CardosoCigarettes",
  [Parameter(Mandatory=$false)][string]$NewLockHash = "",
  [Parameter(Mandatory=$false)][string]$NewVersion = ""
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $AppDir "logs"
$logFile = Join-Path $logDir "update.log"
$statusFile = Join-Path $AppDir ".last-update-status.json"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

function Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  try { Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue } catch {}
  Write-Host $line
}

# Always-write status marker so the Node side can detect partial failures
# even when the script exits cleanly. Without this, a Move-Item that hit
# a file lock would silently roll back, the script would exit 1, but the
# in-app UI showed "Update successful" because nothing read the exit code.
function WriteStatus($state, $errorMessage) {
  try {
    $payload = @{
      ok               = ($state -eq 'ok')
      state            = $state           # 'ok' | 'failed' | 'rolled_back'
      expected_version = $NewVersion
      finished_at      = (Get-Date -Format 'o')
      error            = $errorMessage
    } | ConvertTo-Json -Compress
    Set-Content -Path $statusFile -Value $payload -Encoding ASCII -ErrorAction SilentlyContinue
  } catch {}
}

# Resume a paused service before we try to stop/start it. Returns nothing;
# best-effort. NSSM and SCM both reject START on a paused service with
# "Unexpected status SERVICE_PAUSED in response to START control", which
# rolls back every update attempt and leaves the operator stuck. Production
# 2026-05-12 saw exactly this: a service paused for unrelated reasons
# (operator-initiated, services.msc, or Windows admin tooling) blocked
# every UI-driven update until a manual install fixed the underlying state.
#
# Idempotent: if the service is already Running, this is a no-op. If it's
# Stopped, this is also a no-op (Resume-Service throws on Stopped, we catch).
function Resume-IfPaused($svcName) {
  try {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    if ($svc.Status -eq 'Paused' -or $svc.Status -eq 'PausePending') {
      Log "Service $svcName is in state '$($svc.Status)' — resuming before lifecycle operation"
      try {
        Resume-Service -Name $svcName -ErrorAction Stop
        Start-Sleep -Seconds 2
        $after = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        Log "  Service now in state '$($after.Status)' after Resume"
      } catch {
        Log "  Resume-Service failed: $($_.Exception.Message) (continuing anyway)"
      }
    }
  } catch {
    Log "Resume-IfPaused probe failed: $($_.Exception.Message) (continuing)"
  }
}

# Wait until the service reaches one of the target states (or timeout).
# Returns $true on hit, $false on timeout. Used after stop/start to
# verify the operation actually took effect — without this, the script
# would press on with files still locked by a not-yet-stopped service.
function Wait-ForServiceState($svcName, [string[]]$targetStates, $timeoutSec = 20) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if (-not $svc) { return $false }
    if ($targetStates -contains [string]$svc.Status) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# Move-Item with retry. Newly-stopped Node sometimes leaves *.js / app.asar
# briefly locked (sub-second) by lingering file handles, antivirus scanners,
# or the search indexer. A single Move-Item -Force fails immediately in
# those cases; retrying with backoff almost always succeeds within 5s and
# turns "update broken until reinstall" into "update finished, slightly
# slower". Falls through to throw on persistent failure so the catch
# block can rollback.
function Move-WithRetry($src, $dst, $maxAttempts = 6) {
  for ($i = 1; $i -le $maxAttempts; $i++) {
    try {
      Move-Item -Path $src -Destination $dst -Force -ErrorAction Stop
      return
    } catch {
      if ($i -eq $maxAttempts) {
        throw "Move-Item failed after $maxAttempts attempts: $($_.Exception.Message) (src=$src dst=$dst)"
      }
      $delayMs = [Math]::Min(2000, 200 * [Math]::Pow(2, $i - 1))
      Log "  Move-Item attempt $i failed ($($_.Exception.Message)); retrying in ${delayMs}ms"
      Start-Sleep -Milliseconds $delayMs
    }
  }
}

$backupDir = $null
$stagingDir = $null

try {
  Log "=== Delta update starting ==="
  Log "ZipPath: $ZipPath"
  Log "AppDir: $AppDir"

  if (-not (Test-Path $ZipPath)) {
    throw "Zip not found: $ZipPath"
  }

  # Verify checksum BEFORE touching anything
  if ($ExpectedSha256) {
    $actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $ExpectedSha256.ToLower()) {
      throw "SHA-256 mismatch: expected $ExpectedSha256, got $actual"
    }
    Log "Checksum verified."
  }

  # Resume the service if it's currently paused — NSSM/SCM will reject
  # both stop AND start on a paused service in some transitional states,
  # and a paused service still holds file handles that block the swap.
  Resume-IfPaused $ServiceName

  # Stop service. Tolerate "service not installed" / "already stopped".
  Log "Stopping service $ServiceName..."
  $nssm = Join-Path $AppDir "nssm\nssm.exe"
  if (Test-Path $nssm) {
    & $nssm stop $ServiceName 2>&1 | Out-Null
  } else {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  }
  # Wait for actual Stopped state instead of a fixed 3s sleep. A service
  # mid-stop holds file handles; moving over those handles is what
  # produces the partial-extract + rollback loops we used to see.
  if (-not (Wait-ForServiceState $ServiceName @('Stopped') 20)) {
    $current = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
    Log "WARN: service did not reach Stopped state within 20s (current: $current). Continuing."
  }

  # Extract zip to a staging directory adjacent to the install
  $ts = [DateTimeOffset]::Now.ToUnixTimeSeconds()
  $stagingDir = Join-Path $AppDir ".staging-$ts"
  $backupDir  = Join-Path $AppDir ".backup-$ts"
  Log "Extracting to staging: $stagingDir"
  Expand-Archive -Path $ZipPath -DestinationPath $stagingDir -Force

  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

  # Move every top-level item from staging into the install dir, backing up
  # the existing version first. We only touch what's in the zip — node_modules,
  # node/, nssm/, database/, .env, logs/, uploads/ are left untouched.
  $stagingItems = Get-ChildItem -Path $stagingDir
  foreach ($item in $stagingItems) {
    $target       = Join-Path $AppDir   $item.Name
    $backupTarget = Join-Path $backupDir $item.Name
    if (Test-Path $target) {
      Log "Backup: $target -> $backupTarget"
      Move-WithRetry $target $backupTarget
    }
    Log "Apply: $($item.FullName) -> $target"
    Move-WithRetry $item.FullName $target
  }

  Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue
  $stagingDir = $null

  # Update marker files so the next delta update can compare against this one
  if ($NewLockHash) {
    Set-Content -Path (Join-Path $AppDir ".lock-hash") -Value $NewLockHash -NoNewline -Encoding ASCII
    Log "Wrote .lock-hash: $NewLockHash"
  }
  if ($NewVersion) {
    Set-Content -Path (Join-Path $AppDir ".installed-version") -Value $NewVersion -NoNewline -Encoding ASCII
    Log "Wrote .installed-version: $NewVersion"
  }

  # Start service. The pre-stop Resume-IfPaused should have ensured we
  # come into this in Stopped state, but a race (operator clicks Pause
  # in services.msc mid-update, NSSM transient state, etc.) can land us
  # in Paused at start time too — handle that defensively below.
  Log "Starting service..."
  if (Test-Path $nssm) {
    & $nssm start $ServiceName 2>&1 | Out-Null
  } else {
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
  }
  # Wait up to 30s for Running. If we land in Paused (the production
  # 2026-05-12 failure mode), explicitly Resume — the start succeeded
  # but SCM ended up in Paused state for reasons that are usually
  # external (operator action mid-update, group policy, etc.).
  if (-not (Wait-ForServiceState $ServiceName @('Running') 30)) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Paused') {
      Log "Service landed in Paused state after start — attempting Resume"
      try {
        Resume-Service -Name $ServiceName -ErrorAction Stop
        if (Wait-ForServiceState $ServiceName @('Running') 10) {
          Log "  Resume succeeded; service is Running"
        } else {
          $svc2 = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
          throw "Service stayed in '$($svc2.Status)' after Resume — manual intervention needed (services.msc → $ServiceName → Resume). Update files swapped; rollback will restore the previous version."
        }
      } catch {
        throw "Service was Paused after start and Resume failed: $($_.Exception.Message)"
      }
    } else {
      $observed = if ($svc) { $svc.Status } else { 'not-installed' }
      throw "Service did not reach Running within 30s after start (observed: $observed). NSSM/SCM start completed but the service did not begin executing — most common causes: missing dependency, port conflict, or service binary path broken. Check Windows Event Viewer → Application log for service startup errors."
    }
  }
  Log "Service running. Backup retained at $backupDir"
  Log "=== Update complete ==="

  # Clean up the dropped zip
  try { Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue } catch {}

  WriteStatus 'ok' $null
  exit 0
} catch {
  $primaryError = "$_"
  Log "ERROR: $primaryError"
  $rollbackOk = $true
  $rollbackError = $null
  if ($backupDir -and (Test-Path $backupDir)) {
    Log "Rolling back from $backupDir..."
    try {
      Get-ChildItem -Path $backupDir | ForEach-Object {
        $target = Join-Path $AppDir $_.Name
        if (Test-Path $target) { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
        Move-Item -Path $_.FullName -Destination $target -Force
      }
      Log "Rollback complete."
    } catch {
      $rollbackOk = $false
      $rollbackError = "$_"
      Log "Rollback ALSO failed: $rollbackError  Backup files left at $backupDir for manual recovery."
    }
  } else {
    $rollbackOk = $false
    $rollbackError = 'no_backup_to_restore'
  }
  if ($stagingDir -and (Test-Path $stagingDir)) {
    Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue
  }

  # Best-effort restart. Pause-aware so the rollback path can recover
  # from the same SERVICE_PAUSED failure mode that caused the rollback.
  Log "Attempting to restart service..."
  try {
    Resume-IfPaused $ServiceName
    if (Test-Path (Join-Path $AppDir "nssm\nssm.exe")) {
      & (Join-Path $AppDir "nssm\nssm.exe") start $ServiceName 2>&1 | Out-Null
    } else {
      Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    }
    # If we still land in Paused, Resume one more time so the operator
    # at least gets a Running service after the rollback — separately
    # from the failed-update status the WriteStatus call records below.
    Start-Sleep -Seconds 2
    $svcAfter = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svcAfter -and $svcAfter.Status -eq 'Paused') {
      Log "  Service Paused after rollback restart — Resume"
      try { Resume-Service -Name $ServiceName -ErrorAction Stop } catch {}
    }
  } catch {}

  if ($rollbackOk) {
    WriteStatus 'rolled_back' $primaryError
  } else {
    WriteStatus 'failed' "$primaryError | rollback: $rollbackError"
  }
  exit 1
}
