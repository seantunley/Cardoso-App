import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 27,
      name: 'network_devices_tables',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS network_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT,
            site_slug TEXT,
            site_name TEXT,
            mac_address TEXT NOT NULL UNIQUE,
            ip_address TEXT,
            hostname TEXT,
            vendor TEXT,
            device_category TEXT,
            classification_label TEXT,
            classification_confidence TEXT,
            classification_rationale TEXT,
            discovery_source TEXT,
            interface_alias TEXT,
            interface_description TEXT,
            neighbor_state TEXT,
            first_seen TEXT,
            last_seen TEXT,
            last_scan_at TEXT,
            active INTEGER DEFAULT 0,
            recently_seen INTEGER DEFAULT 0,
            details_json TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_network_devices_last_seen ON network_devices(last_seen);
          CREATE INDEX IF NOT EXISTS idx_network_devices_active ON network_devices(active);
          CREATE INDEX IF NOT EXISTS idx_network_devices_category ON network_devices(device_category);

          CREATE TABLE IF NOT EXISTS network_device_scan_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            status TEXT,
            trigger_reason TEXT,
            device_count INTEGER DEFAULT 0,
            active_count INTEGER DEFAULT 0,
            message TEXT
          );
        `);

        if (process.env.HUB_MODE === 'true') {
          db.exec(`
            CREATE TABLE IF NOT EXISTS hub_network_devices (
              site_id TEXT NOT NULL,
              site_slug TEXT,
              site_name TEXT,
              mac_address TEXT NOT NULL,
              ip_address TEXT,
              hostname TEXT,
              vendor TEXT,
              device_category TEXT,
              classification_label TEXT,
              classification_confidence TEXT,
              classification_rationale TEXT,
              interface_alias TEXT,
              interface_description TEXT,
              neighbor_state TEXT,
              first_seen TEXT,
              last_seen TEXT,
              last_scan_at TEXT,
              active INTEGER DEFAULT 0,
              recently_seen INTEGER DEFAULT 0,
              details_json TEXT,
              pulled_at TEXT DEFAULT (datetime('now')),
              PRIMARY KEY (site_id, mac_address)
            );
            CREATE INDEX IF NOT EXISTS idx_hub_network_devices_site ON hub_network_devices(site_id, active);
          `);
        }
      },
    };
