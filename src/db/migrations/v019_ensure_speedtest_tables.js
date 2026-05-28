import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 19,
      name: 'ensure_speedtest_tables',
      up(db) {
        // Belt-and-suspenders: create speedtest tables if migration v18 was
        // recorded but the DDL never actually ran (e.g. partial migration failure).
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS site_speedtest (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              timestamp TEXT NOT NULL,
              download_mbps REAL,
              upload_mbps REAL,
              ping_ms REAL,
              isp TEXT,
              server_name TEXT,
              server_location TEXT,
              created_at TEXT DEFAULT (datetime('now'))
            );
          `);
        } catch (e) { /* table may already exist */ }
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS hub_speedtest (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              site_slug TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              download_mbps REAL,
              upload_mbps REAL,
              ping_ms REAL,
              isp TEXT,
              server_name TEXT,
              server_location TEXT,
              pulled_at TEXT DEFAULT (datetime('now')),
              UNIQUE(site_slug, timestamp)
            );
          `);
        } catch (e) { /* table may already exist */ }
      },
    };
