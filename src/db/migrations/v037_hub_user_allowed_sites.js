import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 37,
      name: 'hub_user_allowed_sites',
      up(db) {
        // Only create this table on the Hub — sites don't need it
        if (process.env.HUB_MODE === 'true') {
          ensureTable(db, 'hub_user_allowed_sites',
            `email TEXT NOT NULL,
             site_slug TEXT NOT NULL,
             assigned_at TEXT DEFAULT (datetime('now')),
             PRIMARY KEY (email, site_slug)`
          );
        }
      },
    };
