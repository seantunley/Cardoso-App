import express from 'express';
import path from 'path';
import fs from 'fs';
import BetterSqlite3 from 'better-sqlite3';
import db, { dbPath } from '../db/index.js';

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
  });

  // GET /api/backup/download
  router.get('/api/backup/download', requireReportingToken, (req, res) => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');

      const resolvedDbPath = path.resolve(dbPath);
      const filename = `cardoso-backup-${process.env.SITE_ID || 'site'}-${new Date().toISOString().slice(0, 10)}.db`;

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Backup-Site', process.env.SITE_ID || 'unknown');
      res.setHeader('X-Backup-Timestamp', new Date().toISOString());

      const stream = fs.createReadStream(resolvedDbPath);
      stream.on('error', (err) => {
        console.error('[backup] Stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream database' });
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[backup] Error preparing backup:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
