import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 36,
      name: 'datarecord_sales_rep_and_backfill',
      up(db) {
        // Add sales_rep to datarecord (site customer table)
        try { db.prepare('ALTER TABLE datarecord ADD COLUMN sales_rep TEXT').run(); }
        catch (e) { if (!/duplicate column name/i.test(e.message)) console.error('[migration.v036.add_datarecord_sales_rep]', e.message); }

        // Backfill datarecord.sales_rep from inventoryrecord.sales_rep (by customer_number)
        // This copies the first non-null sales_rep from inventory to the customer record
        try {
          db.exec(`
            UPDATE datarecord
            SET sales_rep = (
              SELECT MIN(i.sales_rep)
              FROM inventoryrecord i
              WHERE i.customer_number = datarecord.customer_number
                AND i.sales_rep IS NOT NULL
                AND i.customer_number IS NOT NULL
            )
            WHERE datarecord.sales_rep IS NULL
              AND datarecord.customer_number IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM inventoryrecord i2
                WHERE i2.customer_number = datarecord.customer_number
                  AND i2.sales_rep IS NOT NULL
              )
          `);
        } catch (e) { console.error('[migration.v036.backfill_datarecord_sales_rep]', e.message); }

        // Add sales_rep to hub_records (Hub aggregated customer table)
        // Guard: only runs on Hub machines (hub_records only exists on Hub)
        if (process.env.HUB_MODE === 'true') {
          try { db.prepare('ALTER TABLE hub_records ADD COLUMN sales_rep TEXT').run(); }
          catch (e) { if (!/duplicate column name/i.test(e.message)) console.error('[migration.v036.add_hub_records_sales_rep]', e.message); }
        }
      },
    };
