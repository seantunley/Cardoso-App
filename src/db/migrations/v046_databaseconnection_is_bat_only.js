import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 46,
      name: 'databaseconnection_is_bat_only',
      up(db) {
        // Per-connection flag isolating BAT Sage connections from the general
        // sync engine. When 1, the connection is NOT swept by the scheduler /
        // auto-sync into the local datarecord table — it's only accessed via
        // the BAT module (getSagePool in batReconciliation.js). Default 0.
        const cols = db.prepare("PRAGMA table_info(databaseconnection)").all().map(c => c.name);
        if (!cols.includes('is_bat_only')) {
          db.exec(`ALTER TABLE databaseconnection ADD COLUMN is_bat_only INTEGER DEFAULT 0`);
        }
        // Auto-mark any connection currently set as the BAT Sage connection
        // (via bat_settings.sage_connection_id) so the existing setup stops
        // bleeding into customer search the moment this migration runs.
        try {
          const row = db.prepare("SELECT value FROM bat_settings WHERE key = 'sage_connection_id'").get();
          const id = row?.value ? parseInt(row.value, 10) : null;
          if (id) db.prepare("UPDATE databaseconnection SET is_bat_only = 1 WHERE id = ?").run(id);
        } catch {}
      },
    };
