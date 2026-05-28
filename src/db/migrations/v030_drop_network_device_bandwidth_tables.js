import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 30,
      name: 'drop_network_device_bandwidth_tables',
      up(db) {
        // Bandwidth estimation removed from Network Devices (inventory-only).
        // Drop bandwidth sample tables created by v27 on existing installs.
        db.exec(`
          DROP TABLE IF EXISTS network_device_bandwidth_samples;
          DROP TABLE IF EXISTS hub_network_device_bandwidth_samples;
        `);
      },
    };
