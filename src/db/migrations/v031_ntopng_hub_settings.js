import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 31,
      name: 'ntopng_hub_settings',
      up(db) {
        // Add ntopng connection settings to hub_settings (Hub only).
        // Also drop old PowerShell-based network device tables — replaced by ntopng.
        const hubSettingsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_settings'`).get();
        if (hubSettingsExists) {
          const upsert = db.prepare(
            `INSERT OR IGNORE INTO hub_settings (key, value) VALUES (?, ?)`
          );
          upsert.run('ntopng_url', 'http://localhost:3000');
          upsert.run('ntopng_user', 'admin');
        }
        // Drop PowerShell-era tables (no longer used)
        db.exec(`
          DROP TABLE IF EXISTS network_devices;
          DROP TABLE IF EXISTS network_device_scan_runs;
          DROP TABLE IF EXISTS hub_network_devices;
        `);
      },
    };
