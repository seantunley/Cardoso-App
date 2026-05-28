import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 24,
      name: 'hub_backup_integrity_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_backup_integrity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT,
            filename TEXT,
            result TEXT,
            checked_at TEXT DEFAULT (datetime('now'))
          )
        `);
      },
    };
