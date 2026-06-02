import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 23,
      name: 'hub_audit_log_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT,
            performed_by TEXT,
            target TEXT,
            detail TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )
        `);
      },
    };
