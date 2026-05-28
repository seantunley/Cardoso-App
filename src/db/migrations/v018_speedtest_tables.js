import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 18,
      name: 'speedtest_tables',
      up(db) {
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
      },
    };
