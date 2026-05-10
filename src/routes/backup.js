import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import archiver from 'archiver';
import BetterSqlite3 from 'better-sqlite3';
import db, { dbPath } from '../db/index.js';
import { logAudit } from '../lib/audit.js';
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
// Stale-snapshot cleanup. NOT invoked as a module-load IIFE here —
// server.js calls dotenv.config() AFTER its imports finish, so module-load
// time would always read process.env.BACKUP_TMP_TTL_MS as undefined and
// silently fall back to the 1-hour default (the env override would be
// dead-on-arrival). Same shape as the rate-limiter `max` issue caught in
// PR review. Invoked instead from createBackupRouter(), which server.js
// calls after dotenv has run.
function cleanupStaleSnapshots() {
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
}

export function createBackupRouter() {
  // Run the stale-snapshot sweep once when the router is mounted.
  // server.js calls this after dotenv.config(), so process.env reflects
  // the operator's .env values by this point.
  cleanupStaleSnapshots();

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

    // Audit-state plumbing — same shape as /api/backup/download. The
    // success audit MUST hang off res.on('finish') (the actual flush-
    // to-client signal), not the synchronous res.send() return. An
    // earlier draft wrote the success row immediately after res.send,
    // but res.send returns once the data is queued, not delivered —
    // a client disconnect between send and flush would record success
    // for an operation that never reached the wire. Caught in PR review.
    //
    // resourceType MUST match the auditlog CHECK constraint in
    // src/db/schema.js — currently allows ('user','connection','record',
    // 'rule','system'). An earlier draft used 'site_config' which fails
    // the CHECK; logAudit catches insert errors internally (so it never
    // breaks the actual export operation), but that means a typo here
    // would silently drop every audit row with no error surfaced. The
    // backup is site-wide system state, so 'system' is the right slot —
    // the action ('backup_config_exported') and resourceName carry the
    // backup-specific signal.
    let auditWritten = false;
    const writeConfigAudit = (status) => {
      if (auditWritten) return; auditWritten = true;
      try {
        logAudit({
          req,
          action: 'backup_config_exported',
          resourceType: 'system',
          resourceId: process.env.SITE_ID || 'site',
          resourceName: filename,
          details: `mode=${exportMode}, bytes=${payload.length}`,
          status,
          userOverride: { email: 'system:reporting-token', full_name: 'reporting-token' },
        });
      } catch {}
    };

    // Attach lifecycle listeners BEFORE sending. res.send is synchronous
    // and returns once the data is queued; on a clean response 'finish'
    // will fire later when bytes are flushed, and 'close' fires after
    // that. On a mid-flush disconnect 'close' fires without 'finish' —
    // that's the case the auditWritten guard turns into a 'failure' row.
    res.on('finish', () => writeConfigAudit('success'));
    res.on('close', () => {
      if (!auditWritten) writeConfigAudit('failure');
    });

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

    // Cleanup + audit state declared at the top of the handler so the
    // res.on('close') listener (attached BEFORE any awaits below) can
    // close over them. This matters because:
    //
    //   - db.backup(tmpPath) can take seconds on a large database
    //   - awaiting pipeline(...) for the SHA-256 hash takes another
    //     ~1-2s per 200MB
    //
    // If the client disconnects during either of those phases, res's
    // 'close' event fires THEN. An earlier draft attached the listener
    // only after both awaits completed, so a disconnect during the
    // pre-stream work fired close before any listener existed and the
    // backup_db_exported audit row never got written. Caught in PR
    // review — moved listener attachment to before the first await.
    let cleaned = false;
    let auditWritten = false;
    let filename = null;        // populated after db.backup() returns
    let size = null;            // populated after statSync() runs
    let sha256 = null;          // populated after pipeline(... hash)
    // The `cleaned` guard MUST only flip to true once we've actually had
    // a tmpPath to delete. An earlier shape was
    //   if (cleaned) return; cleaned = true;
    //   if (tmpPath) fs.unlinkSync(tmpPath);
    // — so a close event that fired early (client disconnect during
    // db.backup() or the hash pass, BEFORE tmpPath was assigned) flipped
    // cleaned=true immediately. Then when the snapshot file was actually
    // created and the code reached `if (res.destroyed) { cleanup(); return; }`,
    // cleanup early-returned because cleaned was already set, leaving the
    // file orphaned in database/tmp-backups until the stale-file sweeper
    // ran. Caught in PR review.
    //
    // The fixed guard: skip cleanup entirely when there's nothing to
    // clean (tmpPath null), so cleaned only flips on the call that
    // actually had a path to unlink. unlinkSync is wrapped in a
    // try/catch so a second call after a successful unlink (file
    // already gone) is harmless — `cleaned=true` is a defensive
    // dedup, not a correctness requirement.
    const cleanup = () => {
      if (cleaned) return;
      if (!tmpPath) return; // nothing to clean yet — try again later
      cleaned = true;
      try { fs.unlinkSync(tmpPath); } catch {}
    };
    const writeAudit = (status) => {
      if (auditWritten) return; auditWritten = true;
      // Audit trail: every download attempt that we became aware of —
      // including ones that disconnected during snapshot/hash before
      // we ever started streaming. Status reflects whether the
      // response actually flushed to the client (success via
      // res.on('finish')) or didn't (failure via res.on('close') OR
      // stream error).
      //
      // resourceType: 'system' — auditlog CHECK constraint restricts
      // resource_type to a fixed set; 'site_backup' fails and
      // logAudit silently swallows the insert error.
      //
      // Some fields may be null on early-disconnect rows (filename
      // until db.backup runs; size until statSync; sha256 until the
      // hash pass completes). The details string adapts to whatever's
      // available so the operator can still tell which phase the
      // pull died in.
      const detailParts = [];
      if (size != null) detailParts.push(`bytes=${size}`);
      if (sha256) detailParts.push(`sha256=${sha256.slice(0, 16)}…`);
      if (status === 'failure' && !filename) detailParts.push('phase=pre-stream');
      try {
        logAudit({
          req,
          action: 'backup_db_exported',
          resourceType: 'system',
          resourceId: process.env.SITE_ID || 'site',
          resourceName: filename || `cardoso-backup-${process.env.SITE_ID || 'site'}-pending`,
          details: detailParts.join(', ') || null,
          status,
          userOverride: { email: 'system:reporting-token', full_name: 'reporting-token' },
        });
      } catch {}
    };

    // AbortController lets the close-handler cancel the SHA-256 hash
    // pipeline mid-flight on client disconnect, instead of letting the
    // hash run to completion against bytes nobody is going to read.
    // On a 200MB DB the hash takes ~1-2s; without abort, repeated
    // aborted pulls would tie up backup I/O for no useful work.
    // pipeline(...) rejects with AbortError when signalled — the catch
    // block treats that the same as any other pre-stream failure.
    const hashAbortController = new AbortController();

    // Lifecycle listeners attached IMMEDIATELY — BEFORE any awaits.
    // res.on('close') covers disconnects during db.backup(), the
    // hash pipeline, AND the streaming phase below. res.on('finish')
    // is the success signal once the streamed response has actually
    // flushed. Order on a clean response:
    //   1. response fully flushed   → 'finish'  → writeAudit('success')
    //   2. socket closed            → 'close'   → auditWritten guard skips
    // On a mid-flight disconnect:
    //   1. socket closed            → 'close'   → writeAudit('failure')
    //      + hashAbortController fires (abort is idempotent — safe to
    //      call after the pipeline has already finished/rejected)
    res.on('finish', () => writeAudit('success'));
    res.on('close', () => {
      cleanup();
      if (!auditWritten) writeAudit('failure');
      hashAbortController.abort();
    });

    try {
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      tmpPath = path.join(tmpDir, `snapshot-${process.pid}-${ts}.db`);

      // Online backup — safe even while the live db has writers attached.
      // better-sqlite3's .backup() returns a Promise that resolves once the
      // pages have been copied; the resulting file is fully checkpointed
      // (no separate WAL needed).
      await db.backup(tmpPath);

      filename = `cardoso-backup-${process.env.SITE_ID || 'site'}-${new Date().toISOString().slice(0, 10)}.db`;
      size = fs.statSync(tmpPath).size;

      // Compute SHA-256 of the snapshot BEFORE streaming. The hub-side
      // ingestion can compare its computed hash against this header to
      // detect transport/read corruption immediately — separately from
      // the SQLite-level PRAGMA integrity_check that happens later.
      // Two checks catch different things:
      //   - SHA-256 mismatch  → bytes differ between site and hub
      //                         (network corruption, partial read,
      //                         streaming bug, etc.)
      //   - integrity_check fail → bytes match but SQLite structure
      //                         is damaged (pre-existing on the site)
      // TLS already provides wire-level integrity, so this is defence
      // in depth — catches application-layer bugs the transport can't.
      // Cost is one extra full-file read on the site side (~1-2s for
      // a 200MB DB). Hub pulls hourly, so the latency is in the noise.
      const hash = crypto.createHash('sha256');
      try {
        await pipeline(fs.createReadStream(tmpPath), hash, {
          signal: hashAbortController.signal,
        });
        sha256 = hash.digest('hex');
      } catch (err) {
        // Abort path — client disconnected, close-handler fired the
        // abort, pipeline rejected with AbortError. The close-handler
        // already wrote the failure audit, so just clean up and bail.
        // Re-throw any non-abort error so the outer catch surfaces it.
        if (err?.name === 'AbortError' || hashAbortController.signal.aborted) {
          cleanup();
          return;
        }
        throw err;
      }

      // If the client disconnected during db.backup() or the hash pass,
      // res.on('close') has already fired writeAudit('failure'). Bail
      // before sending headers — Express will throw if we try to write
      // headers on a destroyed response.
      if (res.destroyed) {
        cleanup();
        return;
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(size));
      res.setHeader('X-Backup-Site', process.env.SITE_ID || 'unknown');
      res.setHeader('X-Backup-Timestamp', new Date().toISOString());
      res.setHeader('X-Backup-Bytes', String(size));
      res.setHeader('X-Backup-SHA256', sha256);

      const stream = fs.createReadStream(tmpPath);
      // 'error' MUST be attached before pipe(). Without it, any read-side
      // failure (file deleted between statSync and open due to AV
      // sweep, permission flip, transient FS hiccup) emits an
      // unhandled 'error' event — and on modern Node that takes the
      // whole process down by default. A previous refactor lost this
      // listener while restructuring the lifecycle code; flagged in
      // PR review and restored.
      //
      // res.on('close') is also already attached (at the top of the
      // handler), so even if pipe was already pumping bytes when this
      // fires, the failure audit + cleanup still happen via that path.
      // This handler does the same work eagerly so the temp file is
      // unlinked immediately rather than waiting for the response to
      // tear down.
      stream.on('error', (err) => {
        console.error('[backup] Stream error:', err.message);
        cleanup();
        writeAudit('failure');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream snapshot' });
        } else {
          // Headers already flushed via setHeader-then-pipe-then-error;
          // we can't change status, but we can still abort the response
          // so the hub-side fetch gets a clean disconnect rather than
          // a hung half-stream.
          try { res.destroy(err); } catch {}
        }
      });
      // Clean up the temp file when the read finishes — but DON'T audit
      // success here. `stream.on('end')` only means the readable is
      // exhausted; the bytes can still be sitting in res's outbound
      // buffer / TCP buffer / on the wire. The success audit is keyed
      // off res.on('finish') (attached at the top of the handler).
      stream.on('end', cleanup);
      stream.pipe(res);
    } catch (err) {
      console.error('[backup] Snapshot/stream failed:', err.message);
      cleanup();
      // Pre-stream failure — write failure audit if the close-handler
      // hasn't already done it. The early-attached res.on('close')
      // listener will also fire when we send the 500 below, but it
      // sees auditWritten=true and skips.
      writeAudit('failure');
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // GET /api/backup/bat-previews
  // Streams a zip of uploads/bat-previews/ — every OCR'd row's preview
  // JPEG (~50-200 KB each, named <extractionId>.jpg). The hub pulls
  // this alongside the .db backup so a site restored from hub backups
  // doesn't have to re-OCR every reconciliation to regenerate previews.
  // Files are append-only (each preview is written once when the row
  // is OCR'd; never modified) so a full snapshot is always self-
  // sufficient — no need for incremental sync.
  //
  // Same auth + rate-limit as /api/backup/download (heavy endpoint,
  // token-only). Streams directly from disk into archiver into res
  // so the whole zip never lives in memory — important when a site
  // has accumulated hundreds of MB of previews.
  //
  // Empty-dir case returns an empty zip (operator on a fresh site
  // with no OCR runs yet still gets a valid response, hub stores
  // a tiny zip — same handling on restore).
  router.get('/api/backup/bat-previews', backupHeavyRateLimiter, requireReportingToken, async (req, res) => {
    const previewDir = path.join(process.cwd(), 'uploads', 'bat-previews');
    const siteId = process.env.SITE_ID || 'site';
    const filename = `bat-previews-${siteId}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;

    let auditWritten = false;
    let bytesStreamed = 0;
    const writeAudit = (status, extra = {}) => {
      if (auditWritten) return; auditWritten = true;
      try {
        logAudit({
          req,
          action: 'backup_bat_previews_exported',
          resourceType: 'system',
          resourceId: siteId,
          resourceName: filename,
          details: `bytes=${bytesStreamed}` + (extra.error ? `, error=${extra.error}` : ''),
          status,
          userOverride: { email: 'system:reporting-token', full_name: 'reporting-token' },
        });
      } catch {}
    };

    res.on('finish', () => writeAudit('success'));
    res.on('close', () => { if (!res.writableFinished) writeAudit('failure'); });

    try {
      // Make sure the dir exists. A site that's never run OCR won't
      // have it, and we still want to return a valid (empty) zip.
      let entries = [];
      try {
        entries = fs.readdirSync(previewDir).filter((f) => f.toLowerCase().endsWith('.jpg'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Backup-Preview-Count', String(entries.length));
      res.setHeader('Cache-Control', 'no-store');

      // store=true (zip with no compression) — JPEGs are already
      // compressed; deflate would burn CPU for ~no size win and slow
      // the stream. Hub-side restore unzips with the same setting.
      const archive = archiver('zip', { store: true });

      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          console.warn(`[backup-previews] non-fatal warning: ${err.message}`);
        } else {
          throw err;
        }
      });
      archive.on('error', (err) => {
        console.error('[backup-previews] archive error:', err.message);
        try { logError('backup.preview_zip', err, { count: entries.length }); } catch {}
        try { res.destroy(err); } catch {}
      });
      archive.on('data', (chunk) => { bytesStreamed += chunk.length; });

      archive.pipe(res);
      // Append every JPEG with its base filename — no path prefix —
      // so the hub-side unzip lays them straight back into
      // uploads/bat-previews/ on the target site without nested dirs.
      for (const f of entries) {
        archive.file(path.join(previewDir, f), { name: f });
      }
      await archive.finalize();
    } catch (err) {
      console.error('[backup-previews] failed:', err.message);
      try { logError('backup.preview_zip', err); } catch {}
      writeAudit('failure', { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        try { res.destroy(err); } catch {}
      }
    }
  });

  return router;
}
