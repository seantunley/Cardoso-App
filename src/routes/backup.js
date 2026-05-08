import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import BetterSqlite3 from 'better-sqlite3';
import db, { dbPath } from '../db/index.js';
import { logAudit } from '../lib/audit.js';

const DEFAULT_SQLBACKUP_ROUTINES_DB_PATH = 'C:\\ProgramData\\Pranas.NET\\SQLBackupAndFTP\\Db\\routines.db';
const DEFAULT_SQLBACKUP_OBJECT_EXCLUDE_LIST = 'PPDdata';
const SENSITIVE_ENV_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASS|KEY|PRIVATE|CERT|COOKIE|SESSION|AUTH)/i;

function requireReportingToken(req, res, next) {
  const token = req.headers['x-reporting-token'];
  const expectedToken = process.env.REPORTING_TOKEN;

  if (!expectedToken || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized: valid x-reporting-token required' });
  }

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

function redactEnvFile(envText) {
  return String(envText || '')
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.trim().startsWith('#')) return line;
      const idx = line.indexOf('=');
      if (idx === -1) return line;
      const key = line.slice(0, idx).trim();
      if (!SENSITIVE_ENV_KEY_PATTERN.test(key)) return line;
      return `${key}=__REDACTED__`;
    })
    .join('\n');
}

// Clean up any stale snapshot files left behind from a crashed previous run.
// The /api/backup/download handler unlinks its temp file on success or stream
// error, but a process kill mid-snapshot would leave one behind. Run once at
// module load.
(function cleanupStaleSnapshots() {
  try {
    const tmpDir = path.join(process.cwd(), 'database', 'tmp-backups');
    if (!fs.existsSync(tmpDir)) return;
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
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

  // GET /api/backup/status
  router.get('/api/backup/status', requireReportingToken, (req, res) => {
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
  router.get('/api/backup/sql-status', requireReportingToken, (req, res) => {
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
  // Returns the site .env file for disaster recovery. Token-protected.
  router.get('/api/backup/config', requireReportingToken, (req, res) => {
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

    // Audit trail: persist a record of every successful config export.
    // The "user" is fundamentally the hub puller (token-auth, no user
    // session). Use userOverride='system:reporting-token' so the audit
    // row is consistent across pulls and a real user identity (if/when
    // a manual ops download lands) shows up via req.currentUser instead.
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
    try {
      logAudit({
        req,
        action: 'backup_config_exported',
        resourceType: 'system',
        resourceId: process.env.SITE_ID || 'site',
        resourceName: filename,
        details: `mode=${exportMode}, bytes=${payload.length}`,
        status: 'success',
        userOverride: { email: 'system:reporting-token', full_name: 'reporting-token' },
      });
    } catch {}
  });

  // GET /api/backup/download
  // Streams a CONSISTENT snapshot of the SQLite database to the caller (the
  // hub backup puller, primarily). Previously this streamed the live db file
  // off disk while it was open and being written to — resulting in backups
  // that would fail PRAGMA integrity_check on the hub side and get renamed
  // to .corrupt. Now we use SQLite's online backup API to write a snapshot
  // to a temp file, stream that, then delete it. Safe under concurrent writes.
  router.get('/api/backup/download', requireReportingToken, async (req, res) => {
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
      await pipeline(fs.createReadStream(tmpPath), hash);
      const sha256 = hash.digest('hex');

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(size));
      res.setHeader('X-Backup-Site', process.env.SITE_ID || 'unknown');
      res.setHeader('X-Backup-Timestamp', new Date().toISOString());
      res.setHeader('X-Backup-Bytes', String(size));
      res.setHeader('X-Backup-SHA256', sha256);

      const stream = fs.createReadStream(tmpPath);
      let cleaned = false;
      let auditWritten = false;
      const cleanup = () => {
        if (cleaned) return; cleaned = true;
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
      };
      const writeAudit = (status) => {
        if (auditWritten) return; auditWritten = true;
        // Audit trail: every download attempt that reached the streaming
        // phase. Status reflects whether the stream completed (success)
        // or the client disconnected / errored mid-stream (failure).
        // Useful for forensics — "was the hub actually able to pull this
        // backup last Tuesday?" without trawling Caddy access logs.
        //
        // resourceType: 'system' — see the matching note on the /config
        // handler above. The auditlog CHECK constraint in schema.js
        // restricts resource_type to a fixed set; 'site_backup' fails
        // and logAudit silently swallows the insert error.
        try {
          logAudit({
            req,
            action: 'backup_db_exported',
            resourceType: 'system',
            resourceId: process.env.SITE_ID || 'site',
            resourceName: filename,
            details: `bytes=${size}, sha256=${sha256.slice(0, 16)}…`,
            status,
            userOverride: { email: 'system:reporting-token', full_name: 'reporting-token' },
          });
        } catch {}
      };
      stream.on('error', (err) => {
        console.error('[backup] Stream error:', err.message);
        cleanup();
        writeAudit('failure');
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream snapshot' });
      });
      stream.on('end', () => { cleanup(); writeAudit('success'); });
      res.on('close', () => {
        cleanup();
        // res.on('close') fires for both clean end and client disconnect.
        // If we got the full stream-end first, writeAudit already ran.
        // If not, the disconnect IS the audit event — record it as
        // failure so the operator can spot interrupted pulls.
        if (!auditWritten) writeAudit('failure');
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[backup] Snapshot/stream failed:', err.message);
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  return router;
}
