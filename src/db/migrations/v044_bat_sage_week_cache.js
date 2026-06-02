import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 44,
      name: 'bat_sage_week_cache',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bat_sage_week_cache (
            year INTEGER NOT NULL,
            week_number INTEGER NOT NULL,
            delivery REAL DEFAULT 0,
            discount REAL DEFAULT 0,
            pricing REAL DEFAULT 0,
            total REAL DEFAULT 0,
            batch_count INTEGER DEFAULT 0,
            refreshed_at TEXT,
            PRIMARY KEY (year, week_number)
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS bat_sage_cache_meta (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
          )
        `);
      },
    };
