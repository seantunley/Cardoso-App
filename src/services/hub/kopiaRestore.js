// Off-site (Kopia) restore — the write/extract side, kept separate from the
// read-only kopiaStatus.js. Restoring pulls a snapshot's data tree OUT of the
// encrypted repo to a staging folder on the hub, from which the operator either
// downloads the DB or has it pushed to the live site.
//
// Mirrors docs/kopia-backups.md Part F exactly: `kopia restore <rootObjectID>
// <folder>`, then use the consistent db.backup() copy under
// database/backups/*.db (NOT the live cardoso.db, which the .kopiaignore
// excludes from the snapshot). Async (execFile) so a multi-minute restore can't
// freeze the hub's event loop.
//
// NOTE: this shells the real `kopia` binary against a real repository, so it
// can only be exercised on a hub with Kopia configured — there's no way to
// unit-test the extraction itself without a repo.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

function kopiaExe() {
  return process.env.KOPIA_EXE || 'kopia';
}

// Prepend --config-file when set, matching kopiaStatus.runKopiaJson so read and
// write paths talk to the same repository.
function kopiaArgs(args) {
  const full = [...args];
  if (process.env.KOPIA_CONFIG_FILE) full.unshift('--config-file', process.env.KOPIA_CONFIG_FILE);
  return full;
}

/**
 * Extract one snapshot's newest SQLite backup to a fresh temp folder.
 *
 * @param {{ rootID: string, timeoutMs?: number }} args
 *   rootID: the snapshot's ROOT OBJECT id (rootEntry.obj from `snapshot list`),
 *   NOT the manifest id — the root object stages the file tree.
 * @returns {Promise<{ dbPath: string, workDir: string, cleanup: () => void }>}
 *   The caller MUST call cleanup() when done (after streaming / after the site
 *   has pulled the file).
 */
export async function extractSnapshotDb({ rootID, timeoutMs = 15 * 60 * 1000 }) {
  if (!rootID || typeof rootID !== 'string') {
    throw new Error('extractSnapshotDb: a snapshot rootID (root object id) is required.');
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardoso-offsite-'));
  const cleanup = () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); }
    catch (e) { console.warn('[kopiaRestore.cleanup] could not remove', workDir, '-', e.message); }
  };

  try {
    // Restore the ROOT object into workDir. With the app-root .kopiaignore the
    // tree is just database/backups + uploads + .env, so this is bounded.
    await execFileAsync(kopiaExe(), kopiaArgs(['restore', rootID, workDir]), {
      env: { ...process.env },
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });

    const backupsDir = path.join(workDir, 'database', 'backups');
    let dbPath = null;
    try {
      const files = fs.readdirSync(backupsDir)
        .filter((f) => /\.db$/i.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length) dbPath = path.join(backupsDir, files[0].f);
    } catch (e) {
      throw new Error(
        `Snapshot ${rootID} restored but its database/backups folder could not be read (${e.code || e.message}). ` +
        `The snapshot may pre-date the current backup layout.`,
      );
    }
    if (!dbPath) {
      throw new Error(`Snapshot ${rootID} restored but contained no *.db under database/backups.`);
    }
    return { dbPath, workDir, cleanup };
  } catch (err) {
    cleanup();
    // Surface kopia's own stderr — usually the actionable part ("repository is
    // not connected", "object not found", etc.).
    const msg = String(err?.stderr || err?.message || err).slice(0, 600);
    throw new Error(`kopia restore failed: ${msg}`);
  }
}
