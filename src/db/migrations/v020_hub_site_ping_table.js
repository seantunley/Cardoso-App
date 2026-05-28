import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 20,
      name: 'hub_site_ping_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_site_ping (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_slug TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            online INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);
      },
    };
