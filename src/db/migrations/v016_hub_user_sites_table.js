import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 16,
      name: 'hub_user_sites_table',
      up(db) {
        db.prepare(`
          CREATE TABLE IF NOT EXISTS hub_user_sites (
            email TEXT NOT NULL,
            site_slug TEXT NOT NULL,
            pushed_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (email, site_slug)
          )
        `).run();
      },
    };
