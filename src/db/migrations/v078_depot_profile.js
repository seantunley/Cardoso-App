import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 78,
      name: 'depot_profile',
      up(db) {
        // Customer-facing documents (price lists, statements, eventually
        // invoices) need a single source of truth for the depot's legal
        // header details. Single-row table because there's exactly one
        // depot identity per site install — no need for key-value
        // gymnastics. id is fixed at 1 by the CHECK constraint.
        db.exec(`
          CREATE TABLE IF NOT EXISTS depot_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            name TEXT,
            address_line1 TEXT,
            address_line2 TEXT,
            city TEXT,
            postal_code TEXT,
            phone TEXT,
            email TEXT,
            vat_number TEXT,
            registration_number TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
          INSERT OR IGNORE INTO depot_profile (id, name) VALUES (1, 'Cardoso Depots');
        `);
      },
    };
