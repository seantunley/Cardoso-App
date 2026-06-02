import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 41,
      name: 'create_flag_snapshots_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS flag_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_number TEXT NOT NULL,
            source_table TEXT,
            flag_color TEXT,
            flag_reason TEXT,
            flag_created_by TEXT,
            flag_source TEXT,
            auto_flagged INTEGER DEFAULT 0,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_flag_snapshots_customer ON flag_snapshots (customer_number, source_table)`);
      },
    };
