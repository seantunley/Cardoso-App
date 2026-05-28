import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 9,
      name: 'record_snapshots_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS record_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT,
            customer_number TEXT,
            snapshot_data TEXT,
            synced_at TEXT
          )
        `);
      },
    };
