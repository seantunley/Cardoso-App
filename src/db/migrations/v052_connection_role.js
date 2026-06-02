import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 52,
      name: 'connection_role',
      up(db) {
        // Explicit module-to-connection routing. Replaces the implicit "first
        // active non-BAT connection" auto-pick in customerSqlPool, which broke
        // when sites had multiple non-BAT connections (customer module ended up
        // hitting the inventory connection by id order). Each row maps a known
        // module identifier to the connection it should use; loaders fall back
        // to the legacy auto-pick when a role is unset.
        db.exec(`
          CREATE TABLE IF NOT EXISTS connection_role (
            role TEXT PRIMARY KEY,
            connection_id INTEGER NOT NULL REFERENCES databaseconnection(id) ON DELETE CASCADE,
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `);
        // Migrate the existing BAT/Sage pick into the new table so operators
        // don't lose their saved selection on upgrade.
        try {
          const row = db.prepare("SELECT value FROM bat_settings WHERE key = 'sage_connection_id'").get();
          const id = row?.value ? parseInt(row.value, 10) : null;
          if (Number.isFinite(id) && id > 0) {
            const exists = db.prepare('SELECT 1 FROM databaseconnection WHERE id = ?').get(id);
            if (exists) {
              db.prepare(`
                INSERT OR REPLACE INTO connection_role (role, connection_id, updated_at)
                VALUES ('bat_sage', ?, datetime('now'))
              `).run(id);
            }
          }
        } catch { /* bat_settings may not exist yet on a fresh install */ }
      },
    };
