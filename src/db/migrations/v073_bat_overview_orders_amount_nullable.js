import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // Drop the NOT NULL constraint on bat_overview_orders.order_amount
      // so the parser can persist "amount not declared yet" as a true
      // NULL instead of coercing to 0. Without this, an Overview pivot
      // row whose Sub Total Excl NC cell is blank or non-numeric got
      // stored as R 0.00 and the Missing PODs tile understated the
      // operator's exposure (showing R 0 for orders whose value is
      // actually unknown). Consumers (getReconciliation.missingPods
      // and listReconciliations.mp_stats) already use COALESCE(...,0)
      // for sums, so they remain numeric-safe.
      //
      // SQLite ALTER COLUMN can't drop NOT NULL — recreate the table.
      // Done inside an explicit transaction so a crash mid-rewrite
      // doesn't leave the schema half-applied. Indexes are recreated
      // by name to match the v72 originals exactly (idempotent CREATE
      // IF NOT EXISTS).
      version: 73,
      name: 'bat_overview_orders_amount_nullable',
      up(db) {
        // No explicit BEGIN/COMMIT — the migration runner already wraps
        // each migration in a transaction. Nesting one inside throws
        // "cannot start a transaction within a transaction".
        db.exec(`
          CREATE TABLE bat_overview_orders_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reconciliation_id INTEGER NOT NULL REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
            order_number TEXT NOT NULL,
            is_exception INTEGER NOT NULL DEFAULT 0 CHECK (is_exception IN (0, 1)),
            order_amount REAL,
            supplier_discount REAL DEFAULT 0,
            supplier_delivery REAL DEFAULT 0,
            supplier_pricing  REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(reconciliation_id, order_number)
          );
          INSERT INTO bat_overview_orders_new
            (id, reconciliation_id, order_number, is_exception, order_amount,
             supplier_discount, supplier_delivery, supplier_pricing, created_at)
            SELECT id, reconciliation_id, order_number, is_exception, order_amount,
                   supplier_discount, supplier_delivery, supplier_pricing, created_at
              FROM bat_overview_orders;
          DROP TABLE bat_overview_orders;
          ALTER TABLE bat_overview_orders_new RENAME TO bat_overview_orders;
          CREATE INDEX IF NOT EXISTS idx_bat_overview_orders_recon_exc
            ON bat_overview_orders(reconciliation_id, is_exception);
        `);
      },
    };
