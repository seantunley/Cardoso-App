// Hub-side reader for what's INSIDE a Kopia snapshot — the file tree of one
// site's off-site backup, and specifically a verdict on whether the SQL Server
// backups (Ola Hallengren .bak files) actually made it off-site and are fresh.
//
// Why this exists: kopiaStatus.js answers "did a snapshot arrive, and when?".
// It can't answer "is the SQL database backup in that snapshot, and is it
// recent?" — because that lives one level down, in the snapshot's file tree.
// This module walks the tree (`kopia ls`) to answer it, so the hub can both
// SHOW the operator the SQL backups off-site and ALERT when a site's SQL backup
// silently stops reaching the hub.
//
// Cross-site safety: every read here is scoped to ONE snapshot's rootID, and a
// snapshot belongs to exactly one site (Kopia partitions by --override-hostname).
// So two sites that both have a database called CARDAT never mix — you are only
// ever looking at one site's tree. The caller (routes) additionally verifies the
// rootID belongs to the site before browsing.
//
// Design mirrors kopiaStatus.js: the impure part (shelling `kopia`) is thin and
// never throws; the parsing/verdict logic is PURE and unit-tested without a
// binary or repo (kopia `ls` has no --json, so we parse its `-l` text — the one
// fragile seam, kept in a single tested function).

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Where Ola Hallengren writes the .bak files, relative to the snapshot root
// (the agent snapshots "C:\Cardoso Customer App"). See docs/sql-backup-setup.md.
export const SQL_BACKUP_SUBPATH = 'database/sql-backups';

function kopiaExe() {
  return process.env.KOPIA_EXE || 'kopia';
}
function kopiaArgs(args) {
  const full = [...args];
  if (process.env.KOPIA_CONFIG_FILE) full.unshift('--config-file', process.env.KOPIA_CONFIG_FILE);
  return full;
}

/**
 * Parse the text output of `kopia ls -l` (and `-l -r`). Kopia's `ls` has no
 * --json mode, so this is the one place we parse its human format. Each line:
 *
 *   -rw-r--r--         1234 2024-06-15 14:30:00 SAST  path/to/file.bak
 *   drwxr-xr-x            0 2024-06-15 14:30:00 SAST  subdir/
 *
 * i.e. mode, size, "YYYY-MM-DD HH:MM:SS", a timezone token, then the name (which
 * may itself contain spaces and, under -r, slashes). PURE — no I/O.
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, isDir: boolean, size: number|null,
 *   mtimeRaw: string|null, mtime: string|null }>} one entry per parsed line;
 *   unparseable lines are skipped (they don't crash the listing).
 */
export function parseKopiaLsLong(stdout) {
  const out = [];
  // mode | size | date time | tz token | name(rest)
  const re = /^([dlbcps-][rwxsStT-]{9})\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.+?)\s*$/;
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    const m = re.exec(line);
    if (!m) continue;
    const [, mode, sizeStr, dateTime] = m;
    let name = m[5];
    const isDir = mode[0] === 'd' || name.endsWith('/');
    if (name.endsWith('/')) name = name.slice(0, -1);
    // Interpret the timestamp as local time (fleet is single-timezone). Dropping
    // the tz abbrev is deliberate — JS can't parse "SAST"; local is close enough
    // for freshness, and the authoritative time for SQL comes from the filename.
    const t = Date.parse(dateTime.replace(/\s+/, 'T'));
    out.push({
      name,
      isDir,
      size: isDir ? null : Number(sizeStr),
      mtimeRaw: `${dateTime} ${m[4]}`,
      mtime: Number.isFinite(t) ? new Date(t).toISOString() : null,
    });
  }
  return out;
}

/**
 * Given a recursive file path under the SQL backup folder, extract the database
 * name, backup type and backup time. Ola Hallengren's default layout is
 *   <Server>$<Instance>/<Database>/<FULL|DIFF|LOG>/<Server>$<Instance>_<DB>_<TYPE>_<yyyymmdd>_<hhmmss>.bak
 * so the DB name and type come from the PATH (robust to underscores/spaces in the
 * server name) and the timestamp from the filename (unambiguous, embedded by Ola).
 * PURE.
 *
 * @param {{ name: string, mtime?: string|null }} entry  a file entry (path may be
 *   relative to the sql-backups folder, or the bare filename)
 * @returns {{ database: string, type: string, at: number|null, filename: string }|null}
 *   null when the path/name doesn't look like an Ola backup.
 */
export function parseSqlBackupEntry(entry) {
  const full = String(entry?.name || '');
  const parts = full.split('/').filter(Boolean);
  const filename = parts[parts.length - 1] || full;
  if (!/\.bak$/i.test(filename)) return null;

  // Type + database from the path segments (…/<DB>/<TYPE>/<file>.bak).
  let type = null;
  let database = null;
  const typeIdx = parts.findIndex((p) => /^(FULL|DIFF|LOG)$/i.test(p));
  if (typeIdx > 0) {
    type = parts[typeIdx].toUpperCase();
    database = parts[typeIdx - 1];
  }
  // Fall back to the filename (…_<DB>_<TYPE>_<ts>.bak) when the path is flat.
  const fnType = filename.match(/_(FULL|DIFF|LOG)_\d{8}_\d{6}/i);
  if (!type && fnType) type = fnType[1].toUpperCase();

  // Timestamp: Ola embeds _YYYYMMDD_HHMMSS (optionally _NN for split files).
  let at = null;
  const ts = filename.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?\.bak$/i);
  if (ts) {
    const [, Y, Mo, D, H, Mi, S] = ts;
    const parsed = Date.parse(`${Y}-${Mo}-${D}T${H}:${Mi}:${S}`);
    if (Number.isFinite(parsed)) at = parsed;
  }
  if (at == null && entry?.mtime) {
    const p = Date.parse(entry.mtime);
    if (Number.isFinite(p)) at = p;
  }
  if (!database && fnType) {
    // best-effort DB from filename: text between last "_" before _TYPE_ and _TYPE_
    const mm = filename.match(/_([^_]+)_(?:FULL|DIFF|LOG)_\d{8}_\d{6}/i);
    if (mm) database = mm[1];
  }
  if (!database) database = '(unknown)';
  return { database, type: type || 'FULL', at, filename };
}

/**
 * Roll a snapshot's SQL backup files up into a per-site verdict. PURE.
 *
 * @param {Array} fileEntries  parseKopiaLsLong entries under the sql-backups folder
 * @param {{ now?: number, staleHours?: number }} [opts]
 * @returns {{ status: 'ok'|'stale'|'never', reason: string, newest_at: string|null,
 *   age_hours: number|null, file_count: number,
 *   databases: Array<{ name: string, full_at: string|null, diff_at: string|null,
 *     newest_at: string|null, status: 'ok'|'stale' }> }}
 */
export function summarizeSqlOffsite(fileEntries, { now = Date.now(), staleHours = 26 } = {}) {
  const parsed = (Array.isArray(fileEntries) ? fileEntries : [])
    .filter((e) => e && !e.isDir)
    .map((e) => parseSqlBackupEntry(e))
    .filter(Boolean);

  if (parsed.length === 0) {
    return { status: 'never', reason: 'no_sql_backups', newest_at: null, age_hours: null, file_count: 0, databases: [] };
  }

  const byDb = new Map();
  for (const f of parsed) {
    const cur = byDb.get(f.database) || { name: f.database, fullMs: null, diffMs: null };
    if (f.type === 'DIFF') cur.diffMs = Math.max(cur.diffMs ?? -Infinity, f.at ?? -Infinity);
    else cur.fullMs = Math.max(cur.fullMs ?? -Infinity, f.at ?? -Infinity);
    byDb.set(f.database, cur);
  }

  const toIso = (ms) => (Number.isFinite(ms) && ms > -Infinity ? new Date(ms).toISOString() : null);
  let newestMs = -Infinity;
  const databases = [...byDb.values()]
    .map((d) => {
      const newest = Math.max(d.fullMs ?? -Infinity, d.diffMs ?? -Infinity);
      if (newest > newestMs) newestMs = newest;
      const ageH = newest > -Infinity ? (now - newest) / 3_600_000 : null;
      return {
        name: d.name,
        full_at: toIso(d.fullMs),
        diff_at: toIso(d.diffMs),
        newest_at: toIso(newest),
        status: ageH != null && ageH <= staleHours ? 'ok' : 'stale',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const newest_at = toIso(newestMs);
  const age_hours = newestMs > -Infinity ? Number(((now - newestMs) / 3_600_000).toFixed(2)) : null;
  const status = age_hours != null && age_hours <= staleHours ? 'ok' : 'stale';
  return {
    status,
    reason: status === 'ok' ? 'ok' : 'stale',
    newest_at,
    age_hours,
    file_count: parsed.length,
    databases,
  };
}

// Shared thin shell for `kopia ls`. Read-only, async (off the main thread), and
// never used with a path outside a caller-validated snapshot rootID.
async function runKopiaLs(objectPath, { recursive = false, timeoutMs = 30_000 } = {}) {
  const args = ['ls', '-l'];
  if (recursive) args.push('-r');
  args.push(objectPath);
  const { stdout } = await execFileAsync(kopiaExe(), kopiaArgs(args), {
    env: { ...process.env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/**
 * List one directory inside a snapshot's file tree — powers the "browse
 * snapshot" viewer. Addresses entries by path from the snapshot root, so no
 * per-directory object IDs are needed and navigation is just an accumulated
 * path. Read-only; never throws (a kopia error becomes a structured result).
 *
 * @param {{ rootID: string, subPath?: string }} args  rootID = snapshot rootEntry.obj
 * @returns {Promise<{ entries: Array, error: string|null, path: string }>}
 */
export async function listSnapshotDir({ rootID, subPath = '' } = {}) {
  if (!rootID) return { entries: [], error: 'missing snapshot id', path: subPath || '' };
  // Guard against path traversal / absolute overrides — only descend.
  const clean = String(subPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  const objectPath = clean ? `${rootID}/${clean}` : rootID;
  try {
    const stdout = await runKopiaLs(objectPath, { recursive: false });
    const entries = parseKopiaLsLong(stdout)
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { entries, error: null, path: clean };
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).slice(0, 400);
    return { entries: [], error: `kopia ls failed: ${msg}`, path: clean };
  }
}

/**
 * Verdict on whether ONE site's SQL backups reached the off-site repo and are
 * fresh, read from a specific snapshot. Recursively lists the sql-backups folder
 * inside the snapshot and summarizes. Read-only; never throws.
 *
 * A snapshot that simply has no sql-backups folder (site doesn't run SQL, or
 * hasn't been set up yet) comes back status:'never' with a benign reason — the
 * alert rule treats that as "not configured", not a failure, so SQL-less sites
 * are never nagged.
 *
 * @param {{ rootID: string, now?: number, staleHours?: number }} args
 * @returns {Promise<object>} summarizeSqlOffsite shape + { error }
 */
export async function collectSqlOffsite({ rootID, now = Date.now(), staleHours = 26 } = {}) {
  const empty = { status: 'never', reason: 'no_sql_backups', newest_at: null, age_hours: null, file_count: 0, databases: [], error: null };
  if (!rootID) return { ...empty, reason: 'no_snapshot' };
  try {
    const stdout = await runKopiaLs(`${rootID}/${SQL_BACKUP_SUBPATH}`, { recursive: true });
    return { ...summarizeSqlOffsite(parseKopiaLsLong(stdout), { now, staleHours }), error: null };
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err);
    // The folder not existing is expected for a site without SQL backups — not
    // an error, just "none".
    if (/not found|does not exist|no such|unable to (get|open)/i.test(msg)) {
      return { ...empty, reason: 'no_sql_folder' };
    }
    return { ...empty, error: `kopia ls failed: ${msg.slice(0, 400)}` };
  }
}
