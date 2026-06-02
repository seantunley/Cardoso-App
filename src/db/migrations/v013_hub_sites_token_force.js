import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 13,
      name: 'hub_sites_token_force',
      up(db) {
        // Migration v10 added hub_sites.token but may have been recorded before
        // the column was actually present (schema drift from old server.js).
        // This migration unconditionally ensures the column exists on any install
        // where hub_sites exists, regardless of prior migration history.
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'token', 'TEXT');
        }
      },
    };
