import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 14,
      name: 'force_add_missing_columns',
      up(db) {
        // Force-add columns that may have been silently missed on older installs.
        // Uses raw ALTER TABLE: SQLite throws "duplicate column name" when the
        // column already exists, which is the expected/idempotent case here.
        // Any other error (table missing, constraint failure) is real and must surface.
        const forceAdd = (table, col, def) => {
          try { db.exec(`ALTER TABLE "${table}" ADD COLUMN ${col} ${def}`); }
          catch (e) {
            if (!/duplicate column name/i.test(e.message)) {
              console.error(`[migration-14] forceAdd failed on ${table}.${col}: ${e.message}`);
              throw e;
            }
          }
        };
        forceAdd('inventoryrecord', 'stocking_uom', 'TEXT');
        forceAdd('inventoryrecord', 'commodity', 'TEXT');
        forceAdd('inventoryrecord', 'inventory_value', 'TEXT');
        const hubInvExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_inventory'`).get();
        if (hubInvExists) {
          forceAdd('hub_inventory', 'stocking_uom', 'TEXT');
          forceAdd('hub_inventory', 'commodity', 'TEXT');
          forceAdd('hub_inventory', 'inventory_value', 'TEXT');
        }
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          forceAdd('hub_sites', 'token', 'TEXT');
        }
      },
    };
