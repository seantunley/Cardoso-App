import express from 'express';
import path from 'path';
import fs from 'fs';
import BetterSqlite3 from 'better-sqlite3';
import db, { dbPath } from '../db/index.js';
import { logError } from '../lib/errorLog.js';
import { reportingRateLimiter, backupHeavyRateLimiter } from '../middleware/rateLimit.js';

const DEFAULT_SQLBACKUP_ROUTINES_DB_PATH = 'C:\\ProgramData\\Pranas.NET\\SQLBackupAndFTP\\Db\\routines.db';
const DEFAULT_SQLBACKUP_OBJECT_EXCLUDE_LIST = 'PPDdata';
const SENSITIVE_ENV_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASS|KEY|PRIVATE|CERT|COOKIE|SESSION|AUTH)/i;

// Match URL-style userinfo embedded in a value: scheme://user:pass@host
// Used to redact secrets that hide inside URL keys not caught by the
// key-name pattern above (e.g. DATABASE_URL=postgres://app:hunter2@db/x).
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+\-.]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

// PEM-style heredoc value markers — when an env value spans multiple lines
// (a wrapped private key, certificate, etc.), the line-by-line redactor
// would only blank the first line. We detect the begin marker on a value
// and treat everything up to the matching end marker as one redactable unit.
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]+-----/;
const PEM_END_RE   = /-----END [A-Z0-9 ]+-----/;

function _safeIp(req) {
  // Use req.ip (Express respects the trust-proxy setting in server.js); fall
  // back to socket address. Truncated to keep audit / log payloads small.
  try { return String(req?.ip || req?.socket?.remoteAddress || 'unknown').slice(0, 64); }
  catch { return 'unknown'; }
}

function requireReportingToken(req, res, next) {
  const token = req.headers['x-reporting-token'];
  const expectedToken = process.env.REPORTING_TOKEN;

  if (!expectedToken || token !== expectedToken) {
    // Log auth failures so probing / brute-force attempts against the
    // backup endpoints are visible in the System Log (and via the
    // securitySignals 401 counter). NEVER log the supplied token —
    // even truncated/hashed forms can leak information about the
    // probe pattern. Just record the fact, the route, and the IP.
    try {
      logError(
        'backup.auth_failed',
        new Error(`Unauthorized backup request to ${req.path}`),
        {
          route: req.path,
          ip: _safeIp(req),
          ua: String(req.get('user-agent') || '').slice(0, 200),
          token_present: !!token,
          token_correct_shape: typeof token === 'string' && token.length > 0,
        },
        'warn',
      );
    } catch {}
    return res.status(401).json({ error: 'Unauthorized: valid x-reporting-token required' });
  }

  next();
}

// Apply Cache-Control: no-store to every backup endpoint. The download
// and config responses contain sensitive data that should never be cached
// by intermediaries; the status endpoints are time-sensitive enough that
// caching is also undesirable. One mw covers all routes.
function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function getSqlBackupRoutinesDbPath() {
  return (process.env.SQLBACKUP_ROUTINES_DB_PATH || DEFAULT_SQLBACKUP_ROUTINES_DB_PATH).trim();
}

function getExcludedSqlBackupObjects() {
  return String(process.env.SQLBACKUP_OBJECT_EXCLUDE_LIST || DEFAULT_SQLBACKUP_OBJECT_EXCLUDE_LIST)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function createSqlBackupUnavailableResponse(message) {
  return {
    ok: false,
    path: getSqlBackupRoutinesDbPath(),
    message,
    filter: {
      include_suffix: 'DAT',
      exclude_objects: getExcludedSqlBackupObjects(),
    },
    lastJob: null,
    databases: [],
  };
}

function getBackupConfigExportMode() {
  const raw = String(process.env.BACKUP_CONFIG_EXPORT_MODE || '').trim().toLowerCase();
  if (['disabled', 'redacted', 'full'].includes(raw)) return raw;
  return process.env.NODE_ENV === 'production' ? 'redacted' : 'full';
}

// Redact sensitive content from a .env file before exposing it. The original
// version was key-name only — values like
//   DATABASE_URL=postgres://app:hunter2@db/x
// passed through untouched because `URL` isn't in the SENSITIVE_ENV_KEY_PATTERN.
// Audit caught this as a real leak surface. The hardened version applies
// three independent passes:
//
//   1. Key-name redaction (unchanged) — replaces the entire value when the
//      key matches SENSITIVE_ENV_KEY_PATTERN. Catches the obvious cases:
//      JWT_SECRET, SESSION_SECRET, REPORTING_TOKEN, etc.
//
//   2. URL userinfo redaction — within any value that survived #1, strip
//      embedded credentials of the form `scheme://user:pass@host`. The
//      hostname remains visible (operators want to know "where does that
//      URL point"); only the user and password are blanked.
//
//   3. Multi-line PEM block redaction — values that begin with -----BEGIN ...-----
//      are kept as-is for the marker line but every subsequent line up to
//      the matching -----END ...----- is replaced with a single
//      __REDACTED_PEM_BODY__ marker. The naive line-by-line approach left
//      the body of multi-line keys exposed.
//
// All three passes run in order so a redacted multi-line key whose key-name
// also matches #1 still ends up with the value blanked entirely.
function redactValueUrls(value) {
  return String(value).replace(URL_USERINFO_PATTERN, '$1__REDACTED__:__REDACTED__@');
}

function redactEnvFile(envText) {
  const lines = String(envText || '').split(/\r?\n/);
  const out = [];
  let inPemBlock = false;

  for (const line of lines) {
    // Inside a multi-line PEM body, drop lines until we hit the end marker.
    // A single placeholder for the first dropped line keeps the file shape
    // intact and signals to the reader that something was there.
    if (inPemBlock) {
      if (PEM_END_RE.test(line)) {
        inPemBlock = false;
        out.push(line); // keep the END marker
      } else if (out[out.length - 1] !== '__REDACTED_PEM_BODY__') {
        out.push('__REDACTED_PEM_BODY__');
      }
      continue;
    }

    if (!line || line.trim().startsWith('#')) {
      out.push(line);
      continue;
    }

    const idx = line.indexOf('=');
    if (idx === -1) {
      out.push(line);
      continue;
    }

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1);

    // Pass 1 — key name match.
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) {
      out.push(`${key}=__REDACTED__`);
      // If the redacted value is the start of a PEM block (e.g.
      // PRIVATE_KEY="-----BEGIN ...-----), enter PEM-skip mode so the
      // wrapped body lines that follow are also redacted.
      if (PEM_BEGIN_RE.test(value)) inPemBlock = true;
      continue;
    }

    // Pass 2 — URL userinfo match within a value the key-pass kept.
    if (URL_USERINFO_PATTERN.test(value)) {
      // Reset lastIndex because the .test() call above advances it for
      // the global flag. Without this, .replace would skip the first match.
      URL_USERINFO_PATTERN.lastIndex = 0;
      value = redactValueUrls(value);
    }

    // Pass 3 — PEM begin marker on the value (multi-line key/cert).
    if (PEM_BEGIN_RE.test(value)) {
      // The line itself stays, but mark that we're inside a PEM body so
      // subsequent lines get squashed.
      inPemBlock = true;
    }

    out.push(`${key}=${value}`);
  }

  return out.join('\n');
}

// Clean up any stale snapshot files left behind from a crashed previous run.
// The /api/backup/download handler unlinks its temp file on success or stream
// error, but a process kill mid-snapshot would leave one behind. Run once at
// module load.
//
// TTL is env-tunable. Default 1 hour, floor 60 seconds.
//
// Two failure modes get handled differently:
//   - parse fails (NaN, Infinity, missing value) → fall back to default
//   - parsed value is below the floor              → CLAMP to the floor,
//     not the default. An operator who sets `BACKUP_TMP_TTL_MS=30000`
//     clearly wants quick cleanup; treating that as "invalid, use 1 hour"
//     would make it appear that the env was ignored. Clamping to 60s
//     respects the operator's intent while still preventing pathological
//     near-zero values that would thrash the FS.
//
// Without this distinction, an earlier draft returned the default for
// BOTH cases, so a low-but-valid setting silently delayed cleanup by an
// hour — flagged in PR review.
function _staleTtlMs() {
  const FLOOR = 60_000;       // 60 seconds — minimum sane cleanup interval
  const DEFAULT = 60 * 60 * 1000; // 1 hour
  const raw = process.env.BACKUP_TMP_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT;
  if (n < FLOOR) return FLOOR;
  return n;
}
(function cleanupStaleSnapshots() {
  try {
    const tmpDir = path.join(process.cwd(), 'database', 'tmp-backups');
    if (!fs.existsSync(tmpDir)) return;
    const cutoff = Date.now() - _staleTtlMs();
    let removed = 0;
    for (const f of fs.readdirSync(tmpDir)) {
      const p = path.join(tmpDir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
      } catch {}
    }
    if (removed > 0) console.log(`[backup] Cleaned up ${removed} stale snapshot file(s) from previous run`);
  } catch (err) {
    console.warn('[backup] Stale-snapshot cleanup failed:', err.message);
  }
})();

export function createBackupRouter() {
  const router = express.Router();

  // Apply Cache-Control: no-store + the standard reporting rate limiter
  // to every backup endpoint. The heavy endpoints layer the stricter
  // backupHeavyRateLimiter on top.
  router.use(noStore);

  // GET /api/backup/status
  router.get('/api/backup/status', reportingRateLimiter, requireReportingToken, (req, res) => {
    const backupDir = path.resolve(path.dirname(dbPath), 'backups');

    let lastBackup = null;
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => {
          const full = path.join(backupDir, f);
          const stat = fs.statSync(full);
          return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

      if (files.length > 0) {
        lastBackup = files[0];
        lastBackup.total_backups = files.length;
      }
    }

    const dbStat = fs.existsSync(dbPath) ? fs.statSync(path.resolve(dbPath)) : null;

    res.json({
      site_id: process.env.SITE_ID || 'unknown',
      site_name: process.env.SITE_NAME || 'Unknown',
      db_size: dbStat ? dbStat.size : null,
      db_modified: dbStat ? dbStat.mtime.toISOString() : null,
      last_backup: lastBackup,
      backup_dir: backupDir,
    });
  });

  // GET /api/backup/sql-status
  router.get('/api/backup/sql-status', reportingRateLimiter, requireReportingToken, (req, res) => {
    const routinesDbPath = getSqlBackupRoutinesDbPath();

    if (process.platform !== 'win32') {
      return res.json(createSqlBackupUnavailableResponse(`SQL backup status is only available on Windows site machines. Current platform: ${process.platform}`));
    }

    if (!routinesDbPath) {
      return res.json(createSqlBackupUnavailableResponse('SQLBackupAndFTP routines DB path is not configured.'));
    }

    if (!fs.existsSync(routinesDbPath)) {
      return res.json(createSqlBackupUnavailableResponse(`SQLBackupAndFTP routines DB not found at ${routinesDbPath}`));
    }

    let routinesDb;
    try {
      routinesDb = new BetterSqlite3(routinesDbPath, { readonly: true, fileMustExist: true });

      const excludedObjects = new Set(getExcludedSqlBackupObjects());
      const rows = routinesDb.prepare(`
        SELECT r.ObjectName,
               r.BackupAt,
               r.IsSuccess,
               r.ObjectStatus,
               r.DetailInfo
        FROM BackupObjectResult r
        JOIN (
          SELECT ObjectName, MAX(BackupAt) AS MaxBackupAt
          FROM BackupObjectResult
          GROUP BY ObjectName
        ) latest
          ON latest.ObjectName = r.ObjectName
         AND latest.MaxBackupAt = r.BackupAt
        ORDER BY r.ObjectName COLLATE NOCASE ASC
      `).all();

      const databases = rows
        .filter((row) => {
          const objectName = String(row.ObjectName || '').trim();
          if (!objectName) return false;
          const lowerName = objectName.toLowerCase();
          if (excludedObjects.has(lowerName)) return false;
          return lowerName.endsWith('dat');
        })
        .map((row) => ({
          name: String(row.ObjectName || '').trim(),
          backupAt: toIsoOrNull(row.BackupAt),
          isSuccess: row.IsSuccess == null ? null : Boolean(row.IsSuccess),
          objectStatus: row.ObjectStatus || null,
          detailInfo: row.DetailInfo || null,
        }));

      const lastJobRow = routinesDb.prepare(`
        SELECT Id, StartTime, EndTime, IsSuccess, BackupStatus, Size, ArchiveSize
        FROM Backup
        ORDER BY COALESCE(EndTime, StartTime) DESC, Id DESC
        LIMIT 1
      `).get();

      res.json({
        ok: true,
        path: routinesDbPath,
        message: databases.length === 0 ? 'No SQL backup objects matched the DAT filter.' : null,
        filter: {
          include_suffix: 'DAT',
          exclude_objects: Array.from(excludedObjects),
        },
        lastJob: lastJobRow ? {
          startTime: toIsoOrNull(lastJobRow.StartTime),
          endTime: toIsoOrNull(lastJobRow.EndTime),
          isSuccess: lastJobRow.IsSuccess == null ? null : Boolean(lastJobRow.IsSuccess),
          backupStatus: lastJobRow.BackupStatus || null,
          size: lastJobRow.Size ?? null,
          archiveSize: lastJobRow.ArchiveSize ?? null,
        } : null,
        databases,
      });
    } catch (err) {
      console.error('[backup/sql-status] Error reading SQLBackupAndFTP DB:', err.message);
      res.json(createSqlBackupUnavailableResponse(`Unable to read SQLBackupAndFTP routines DB: ${err.message}`));
    } finally {
      try { routinesDb?.close(); } catch (_) {}
    }
  });

  // GET /api/backup/config
  // Returns the site .env file for disaster recovery. Token-protected
  // and rate-limited (heavy endpoint: 10/hour by default; env-tunable
  // via BACKUP_HEAVY_MAX_PER_HOUR).
  router.get('/api/backup/config', backupHeavyRateLimiter, requireReportingToken, (req, res) => {
    const exportMode = getBackupConfigExportMode();
    if (exportMode === 'disabled') {
      return res.status(403).json({ error: 'Backup config export is disabled on this site' });
    }

    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return res.status(404).json({ error: '.env file not found' });
    }

    const filename = `cardoso-config-${process.env.SITE_ID || 'site'}-${new Date().toISOString().slice(0, 10)}.env`;
    const envContent = fs.readFileSync(envPath, 'utf8');
    const payload = exportMode === 'full' ? envContent : redactEnvFile(envContent);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Backup-Site', process.env.SITE_ID || 'unknown');
    res.setHeader('X-Backup-Timestamp', new Date().toISOString());
    res.setHeader('X-Backup-Config-Mode', exportMode);
    res.send(payload);
  });

  // GET /api/backup/download
  // Streams a CONSISTENT snapshot of the SQLite database to the caller (the
  // hub backup puller, primarily). Previously this streamed the live db file
  // off disk while it was open and being written to — resulting in backups
  // that would fail PRAGMA integrity_check on the hub side and get renamed
  // to .corrupt. Now we use SQLite's online backup API to write a snapshot
  // to a temp file, stream that, then delete it. Safe under concurrent writes.
  router.get('/api/backup/download', backupHeavyRateLimiter, requireReportingToken, async (req, res) => {
    const tmpDir = path.join(process.cwd(), 'database', 'tmp-backups');
    let tmpPath = null;
    try {
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      tmpPath = path.join(tmpDir, `snapshot-${process.pid}-${ts}.db`);

      // Online backup — safe even while the live db has writers attached.
      // better-sqlite3's .backup() returns a Promise that resolves once the
      // pages have been copied; the resulting file is fully checkpointed
      // (no separate WAL needed).
      await db.backup(tmpPath);

      const filename = `cardoso-backup-${process.env.SITE_ID || 'site'}-${new Date().toISOString().slice(0, 10)}.db`;
      const size = fs.statSync(tmpPath).size;

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(size));
      res.setHeader('X-Backup-Site', process.env.SITE_ID || 'unknown');
      res.setHeader('X-Backup-Timestamp', new Date().toISOString());
      res.setHeader('X-Backup-Bytes', String(size));

      const stream = fs.createReadStream(tmpPath);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return; cleaned = true;
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
      };
      stream.on('error', (err) => {
        console.error('[backup] Stream error:', err.message);
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream snapshot' });
      });
      stream.on('end', cleanup);
      res.on('close', cleanup); // client disconnect
      stream.pipe(res);
    } catch (err) {
      console.error('[backup] Snapshot/stream failed:', err.message);
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  return router;
}
