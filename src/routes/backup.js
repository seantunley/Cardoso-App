import express from 'express';
import path from 'path';
import fs from 'fs';
import db, { dbPath } from '../db/index.js';

export function createBackupRouter() {
  const router = express.Router();

  // GET /api/backup/status
  router.get('/api/backup/status', (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const backupDir = path.resolve(path.dirname(dbPath), 'backups');

    let lastBackup = null;
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.db'))
        .map(f => {
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

  // GET /api/backup/config
  // Returns the site .env file for disaster recovery. Token-protected.
  router.get('/api/backup/config', (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized: valid x-reporting-token required' });
    }

    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return res.status(404).json({ error: '.env file not found' });
    }

    const filename = `cardoso-config-${process.env.SITE_ID || 'site'}-${new Date().toISOString().slice(0,10)}.env`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Backup-Site', process.env.SITE_ID || 'unknown');
    res.setHeader('X-Backup-Timestamp', new Date().toISOString());
    fs.createReadStream(envPath).pipe(res);
  });

  // GET /api/backup/download
  router.get('/api/backup/download', (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;

    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized: valid x-reporting-token required' });
    }

    try {
      // Flush WAL to main DB file so the file on disk is complete
      db.pragma('wal_checkpoint(TRUNCATE)');

      const resolvedDbPath = path.resolve(dbPath);
      const filename = `cardoso-backup-${process.env.SITE_ID || 'site'}-${new Date().toISOString().slice(0,10)}.db`;

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
