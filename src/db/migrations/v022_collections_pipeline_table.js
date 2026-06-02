import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 22,
      name: 'collections_pipeline_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id TEXT NOT NULL UNIQUE,
            status TEXT DEFAULT 'pending',
            contacted_at TEXT,
            notes TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_collections_status ON collections(status);
          CREATE INDEX IF NOT EXISTS idx_collections_customer_id ON collections(customer_id);
        `);
      },
    };
