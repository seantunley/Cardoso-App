import { ensureColumn, ensureTable } from './_helpers.js';

export default {
  version: 81,
  name: 'commission_settings_and_permission',
  up(db) {
    // Sales-commission report — replicates the legacy "Commission Sales Report"
    // spreadsheet (docs/Commission Report -April 24th 2022 to May 23rd 2022 -
    // Complete.xlsx). Settings live in a single-row table so an admin can
    // adjust rates without a code deploy.
    db.exec(`
      CREATE TABLE IF NOT EXISTS commission_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sweets_rate REAL NOT NULL DEFAULT 0.015,
        cigtob_rate REAL NOT NULL DEFAULT 0.0017,
        reference_rate REAL NOT NULL DEFAULT 0.01,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL
      );
    `);
    // Seed the single row if missing.
    db.exec(`
      INSERT INTO commission_settings (id, sweets_rate, cigtob_rate, reference_rate)
      SELECT 1, 0.015, 0.0017, 0.01
      WHERE NOT EXISTS (SELECT 1 FROM commission_settings WHERE id = 1);
    `);

    ensureColumn(db, 'user', 'can_access_commission', 'INTEGER NOT NULL DEFAULT 0');

    // Backfill: admins keep access automatically (matches the convention used
    // by every other can_access_* permission on the user table).
    db.exec(`UPDATE "user" SET can_access_commission = 1 WHERE role = 'admin'`);
  },
};
