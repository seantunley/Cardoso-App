import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 79,
      name: 'price_list_exclusions',
      up(db) {
        // Item-code patterns to exclude from the customer-facing price
        // list. Pattern uses `*` as a wildcard (converted to SQL LIKE %
        // at filter time). Examples: "4000*", "JT*", "9999" (exact).
        // Stored once globally — applies to every price list.
        db.exec(`
          CREATE TABLE IF NOT EXISTS price_list_exclusions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL UNIQUE,
            note TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_by TEXT
          );
        `);
      },
    };
