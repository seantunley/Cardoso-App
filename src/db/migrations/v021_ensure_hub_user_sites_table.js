import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 21,
      name: 'ensure_hub_user_sites_table',
      up(db) {
        // Belt-and-suspenders: v16 may have been recorded without the DDL
        // actually running on some installs. Force-create here.
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS hub_user_sites (
              email TEXT NOT NULL,
              site_slug TEXT NOT NULL,
              pushed_at TEXT DEFAULT (datetime('now')),
              PRIMARY KEY (email, site_slug)
            );
          `);
        } catch (e) { /* already exists, no-op */ }
      },
    };
