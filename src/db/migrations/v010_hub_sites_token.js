import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 10,
      name: 'hub_sites_token',
      up(db) {
        // Add token column to hub_sites if table exists (covers all installs — hub and sites with legacy hub_sites table)
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'token', 'TEXT');
        }
      },
    };
