import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 29,
      name: 'credit_logic_centralisation',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS credit_logic_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version INTEGER NOT NULL UNIQUE,
            schema_version INTEGER NOT NULL DEFAULT 1,
            config_json TEXT NOT NULL,
            notes TEXT,
            created_by TEXT,
            is_active INTEGER DEFAULT 0,
            published_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_credit_logic_versions_active ON credit_logic_versions(is_active, version DESC);

          CREATE TABLE IF NOT EXISTS credit_logic_state (
            scope TEXT PRIMARY KEY,
            logic_version INTEGER,
            payload_json TEXT,
            schema_version INTEGER NOT NULL DEFAULT 1,
            published_at TEXT,
            last_synced_at TEXT,
            sync_status TEXT DEFAULT 'never_synced',
            last_error TEXT,
            source TEXT DEFAULT 'default',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);

        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'logic_version', 'INTEGER');
          ensureColumn(db, 'hub_sites', 'logic_sync_status', `TEXT DEFAULT 'never_synced'`);
          ensureColumn(db, 'hub_sites', 'logic_last_error', 'TEXT');
          ensureColumn(db, 'hub_sites', 'logic_last_synced_at', 'TEXT');
          ensureColumn(db, 'hub_sites', 'logic_status_updated_at', 'TEXT');
        }
      },
    };
