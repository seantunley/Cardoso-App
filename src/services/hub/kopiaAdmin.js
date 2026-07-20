// Hub-side DESTRUCTIVE Kopia repository operations — kept apart from the
// read-only kopiaStatus/kopiaTree and the restore extractor. Two actions the
// Hub Backups viewer exposes to admins:
//   • deleteSnapshot — drop one snapshot manifest (a restore point).
//   • runMaintenance — full maintenance/GC, which is what actually RECLAIMS the
//     disk that deleted (or retention-expired) snapshots were holding.
//
// Both shell the real `kopia` binary against the repo, using the same
// --config-file the read path uses, so they talk to the same repository. Async
// (execFile) so a long GC can't freeze the hub event loop. Never throw — a
// kopia/permission failure comes back as a structured { ok:false, error }.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function kopiaExe() {
  return process.env.KOPIA_EXE || 'kopia';
}
function kopiaArgs(args) {
  const full = [...args];
  if (process.env.KOPIA_CONFIG_FILE) full.unshift('--config-file', process.env.KOPIA_CONFIG_FILE);
  return full;
}

/**
 * Delete one snapshot by its manifest id. `--delete` is required by kopia to
 * actually perform the deletion (without it, it's a dry-run). Deletion only
 * unlinks the manifest — space is reclaimed later by runMaintenance().
 *
 * @param {{ snapshotId: string, timeoutMs?: number }} args
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function deleteSnapshot({ snapshotId, timeoutMs = 60_000 } = {}) {
  if (!snapshotId || typeof snapshotId !== 'string') return { ok: false, error: 'missing snapshot id' };
  try {
    await execFileAsync(kopiaExe(), kopiaArgs(['snapshot', 'delete', snapshotId, '--delete']), {
      env: { ...process.env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(err?.stderr || err?.message || err).slice(0, 400) };
  }
}

// Single-flight guard: a full GC is heavy and must not run twice at once. Held
// for the life of one run; the POST route reports 409 while it's set.
let _maintenanceRunning = false;
export function isMaintenanceRunning() {
  return _maintenanceRunning;
}

/**
 * Run full Kopia maintenance (compaction + garbage collection) — the step that
 * frees disk after snapshots are deleted or expire by retention. Can take many
 * minutes on a large repo; the caller runs it single-flight and the request
 * waits for it. Requires the connected config to be the maintenance owner —
 * "not the owner" surfaces as the error rather than being swallowed.
 *
 * @param {{ timeoutMs?: number }} [args]
 * @returns {Promise<{ ok: boolean, output: string|null, error: string|null, skipped?: boolean }>}
 */
export async function runMaintenance({ timeoutMs = 20 * 60 * 1000 } = {}) {
  if (_maintenanceRunning) return { ok: false, output: null, error: 'maintenance already running', skipped: true };
  _maintenanceRunning = true;
  try {
    const { stdout } = await execFileAsync(kopiaExe(), kopiaArgs(['maintenance', 'run', '--full']), {
      env: { ...process.env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return { ok: true, output: String(stdout || '').slice(-2000), error: null };
  } catch (err) {
    return { ok: false, output: null, error: String(err?.stderr || err?.message || err).slice(0, 600) };
  } finally {
    _maintenanceRunning = false;
  }
}
