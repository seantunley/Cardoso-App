# Apply a hub-pushed restore — replace the live cardoso.db (and
# optionally uploads/bat-previews/) with a snapshot the hub already
# downloaded into a staging directory on this site.
#
# Mirrors scripts/apply-app-update.ps1 in shape and safety guarantees:
#   - Stop the Cardoso service before touching live files (avoid file-
#     lock failures on the swap)
#   - Back up the current live files first (timestamped .before-restore-*)
#   - Apply the new files
#   - Run PRAGMA integrity_check on the restored cardoso.db
#   - If integrity fails, roll back from the just-taken backup
#   - Start the service again
#   - Write a status marker file the in-app status endpoint can read
#
# Called from src/routes/hub.js receive-restore handler via Task
# Scheduler so the script survives the service stop (NSSM kill-tree
# would otherwise terminate any descendant of the Cardoso process the
# moment the service stops).

param(
  [Parameter(Mandatory=$true)][string]$StagingDir,
  [Parameter(Mandatory=$true)][string]$SnapshotDbPath,
  [Parameter(Mandatory=$false)][string]$SnapshotPreviewsZipPath = "",
  [Parameter(Mandatory=$false)][string]$AppDir = "C:\Cardoso Customer App",
  [Parameter(Mandatory=$false)][string]$ServiceName = "CardosoCigarettes",
  [Parameter(Mandatory=$false)][string]$RestoreId = ""
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $AppDir "logs"
$logFile = Join-Path $logDir "restore.log"
$statusFile = Join-Path $AppDir ".last-restore-status.json"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

function Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  try { Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue } catch {}
  Write-Host $line
}

# Status marker so the Node process (after restart) can read what
# happened during the restore window. Same shape as apply-app-update's
# .last-update-status.json.
function WriteStatus($state, $errorMessage, $extra) {
  try {
    $payload = @{
      ok               = ($state -eq 'ok')
      state            = $state          # 'ok' | 'failed' | 'rolled_back'
      restore_id       = $RestoreId
      finished_at      = (Get-Date -Format 'o')
      error            = $errorMessage
    }
    if ($extra) {
      foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] }
    }
    $json = $payload | ConvertTo-Json -Compress
    Set-Content -Path $statusFile -Value $json -Encoding ASCII -ErrorAction SilentlyContinue
  } catch {}
}

# Move-Item with retry. Same defensive helper apply-app-update.ps1
# uses — Windows briefly locks the just-stopped service's files via
# AV scanners, search indexer, etc. A bare Move-Item -Force fails
# instantly on those races; the retry covers the ~1s window.
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

$dbBackupPath = $null
$previewsBackupPath = $null

try {
  Log "=== Restore starting (RestoreId=$RestoreId) ==="
  Log "StagingDir: $StagingDir"
  Log "SnapshotDbPath: $SnapshotDbPath"
  if ($SnapshotPreviewsZipPath) { Log "SnapshotPreviewsZipPath: $SnapshotPreviewsZipPath" }

  if (-not (Test-Path $SnapshotDbPath)) {
    throw "Snapshot DB not found at $SnapshotDbPath"
  }

  # Pre-restore integrity check on the SNAPSHOT — refuse to restore
  # from a corrupt source. Same-process check using better-sqlite3
  # would be cleaner but the Cardoso service may not even be running
  # by the time this script invokes; use the bundled node + the
  # better-sqlite3 native binary in node_modules.
  $nodeExe = Join-Path $AppDir "node\node.exe"
  if (Test-Path $nodeExe) {
    Log "Running PRAGMA integrity_check on snapshot..."
    $checkScript = @"
const Database = require('$($AppDir.Replace('\','/'))/node_modules/better-sqlite3');
const db = new Database('$($SnapshotDbPath.Replace('\','/'))', { readonly: true, fileMustExist: true });
const rows = db.prepare('PRAGMA integrity_check').all();
const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
console.log(ok ? 'INTEGRITY_OK' : 'INTEGRITY_FAIL: ' + JSON.stringify(rows));
db.close();
process.exit(ok ? 0 : 1);
"@
    $checkScriptPath = Join-Path $env:TEMP "cardoso-restore-check-$RestoreId.cjs"
    Set-Content -Path $checkScriptPath -Value $checkScript -Encoding ASCII
    $checkResult = & $nodeExe $checkScriptPath 2>&1
    Remove-Item -Force $checkScriptPath -ErrorAction SilentlyContinue
    Log "Snapshot integrity: $checkResult"
    if ($LASTEXITCODE -ne 0) {
      throw "Snapshot DB failed integrity_check — refusing to restore a corrupt source. $checkResult"
    }
  } else {
    Log "WARNING: bundled node.exe not found at $nodeExe — skipping pre-restore integrity check"
  }

  # Stop service
  Log "Stopping service $ServiceName..."
  $nssm = Join-Path $AppDir "nssm\nssm.exe"
  if (Test-Path $nssm) {
    & $nssm stop $ServiceName 2>&1 | Out-Null
  } else {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3

  $ts = [DateTimeOffset]::Now.ToUnixTimeSeconds()
  $liveDbPath = Join-Path $AppDir "database\cardoso.db"
  $previewsDir = Join-Path $AppDir "uploads\bat-previews"

  # ── Live DB swap ──────────────────────────────────────────────
  if (Test-Path $liveDbPath) {
    $dbBackupPath = "$liveDbPath.before-restore-$ts"
    Log "Backing up current live DB: $liveDbPath -> $dbBackupPath"
    Move-WithRetry $liveDbPath $dbBackupPath
  } else {
    Log "No live DB at $liveDbPath (fresh install?) — skipping live-DB backup"
  }
  Log "Applying snapshot DB: $SnapshotDbPath -> $liveDbPath"
  Copy-Item -Path $SnapshotDbPath -Destination $liveDbPath -Force

  # Also remove the WAL + SHM sidecars from before the restore so the
  # new DB starts fresh. These are journal files; if left in place
  # alongside a different DB they cause corruption-like behaviour.
  Remove-Item -Force "$liveDbPath-wal" -ErrorAction SilentlyContinue
  Remove-Item -Force "$liveDbPath-shm" -ErrorAction SilentlyContinue

  # ── BAT previews swap (optional) ──────────────────────────────
  if ($SnapshotPreviewsZipPath -and (Test-Path $SnapshotPreviewsZipPath)) {
    Log "Restoring BAT previews from $SnapshotPreviewsZipPath..."
    if (Test-Path $previewsDir) {
      $previewsBackupPath = "$previewsDir.before-restore-$ts"
      Log "Backing up current previews dir: $previewsDir -> $previewsBackupPath"
      Move-WithRetry $previewsDir $previewsBackupPath
    }
    New-Item -ItemType Directory -Force -Path $previewsDir | Out-Null
    Expand-Archive -Path $SnapshotPreviewsZipPath -DestinationPath $previewsDir -Force
    $restored = (Get-ChildItem $previewsDir -Filter "*.jpg" -ErrorAction SilentlyContinue | Measure-Object).Count
    Log "Restored $restored preview JPEG(s)"
  } else {
    Log "No previews zip provided OR file missing — leaving uploads/bat-previews/ as-is"
  }

  # Post-restore integrity check on the freshly-applied live DB.
  if (Test-Path $nodeExe) {
    Log "Running post-restore PRAGMA integrity_check on live DB..."
    $postCheck = @"
const Database = require('$($AppDir.Replace('\','/'))/node_modules/better-sqlite3');
const db = new Database('$($liveDbPath.Replace('\','/'))', { readonly: true, fileMustExist: true });
const rows = db.prepare('PRAGMA integrity_check').all();
const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
console.log(ok ? 'POST_INTEGRITY_OK' : 'POST_INTEGRITY_FAIL: ' + JSON.stringify(rows));
db.close();
process.exit(ok ? 0 : 1);
"@
    $postCheckPath = Join-Path $env:TEMP "cardoso-restore-postcheck-$RestoreId.cjs"
    Set-Content -Path $postCheckPath -Value $postCheck -Encoding ASCII
    $postResult = & $nodeExe $postCheckPath 2>&1
    Remove-Item -Force $postCheckPath -ErrorAction SilentlyContinue
    Log "Post-restore integrity: $postResult"
    if ($LASTEXITCODE -ne 0) {
      throw "Post-restore integrity_check FAILED — rolling back. $postResult"
    }
  }

  # Start service
  Log "Starting service..."
  if (Test-Path $nssm) {
    & $nssm start $ServiceName 2>&1 | Out-Null
  } else {
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 4
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc -or $svc.Status -ne 'Running') {
    throw "Service did not start after restore (status: $($svc.Status))"
  }

  # Clean up staging dir — snapshot files are no longer needed once
  # they're swapped in. Backup files (.before-restore-*) stay on
  # disk; the operator can delete them after they confirm the
  # restored site is healthy.
  try {
    Remove-Item -Recurse -Force $StagingDir -ErrorAction SilentlyContinue
    Log "Cleaned up staging dir: $StagingDir"
  } catch {}

  Log "=== Restore complete ==="
  WriteStatus 'ok' $null @{
    db_backup_path       = $dbBackupPath
    previews_backup_path = $previewsBackupPath
  }
  exit 0
} catch {
  $primaryError = "$_"
  Log "ERROR: $primaryError"

  # Roll back. Move the just-saved backup files BACK on top of the
  # restored copies. If the rollback also fails (rare — would need a
  # second file-lock window) the .before-restore-* files stay in
  # place for manual recovery.
  $rollbackOk = $true
  $rollbackError = $null
  try {
    if ($dbBackupPath -and (Test-Path $dbBackupPath)) {
      Log "Rolling back live DB from $dbBackupPath..."
      $liveDbPath = Join-Path $AppDir "database\cardoso.db"
      if (Test-Path $liveDbPath) { Remove-Item -Force $liveDbPath -ErrorAction SilentlyContinue }
      Move-Item -Path $dbBackupPath -Destination $liveDbPath -Force
      Remove-Item -Force "$liveDbPath-wal" -ErrorAction SilentlyContinue
      Remove-Item -Force "$liveDbPath-shm" -ErrorAction SilentlyContinue
      Log "Live DB rolled back."
    }
    if ($previewsBackupPath -and (Test-Path $previewsBackupPath)) {
      Log "Rolling back previews dir from $previewsBackupPath..."
      $previewsDir = Join-Path $AppDir "uploads\bat-previews"
      if (Test-Path $previewsDir) { Remove-Item -Recurse -Force $previewsDir -ErrorAction SilentlyContinue }
      Move-Item -Path $previewsBackupPath -Destination $previewsDir -Force
      Log "Previews dir rolled back."
    }
  } catch {
    $rollbackOk = $false
    $rollbackError = "$_"
    Log "Rollback ALSO failed: $rollbackError. Backup files at $dbBackupPath / $previewsBackupPath for manual recovery."
  }

  # Best-effort restart so the service comes back even on failure.
  Log "Attempting to restart service..."
  try {
    $nssm = Join-Path $AppDir "nssm\nssm.exe"
    if (Test-Path $nssm) {
      & $nssm start $ServiceName 2>&1 | Out-Null
    } else {
      Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    }
  } catch {}

  if ($rollbackOk) {
    WriteStatus 'rolled_back' $primaryError @{
      db_backup_path       = $dbBackupPath
      previews_backup_path = $previewsBackupPath
    }
  } else {
    WriteStatus 'failed' "$primaryError | rollback: $rollbackError" @{
      db_backup_path       = $dbBackupPath
      previews_backup_path = $previewsBackupPath
    }
  }
  exit 1
}
