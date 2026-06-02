import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // Reserved gap: v62 = hub_sites_accpac_freshness (PR #198),
      // v63 = hub_sites_orphan_tombstone (PR #200). Skipping to v64
      // here so this migration can land independently of those PRs;
      // the runMigrations loop checks each version individually so
      // gaps are fine.
      version: 64,
      name: 'datarecord_customer_name_lower_index',
      up(db) {
        // Customer-lookup endpoints query
        //   WHERE lower(customer_name) = lower(?)
        // which is non-sargable against the existing
        // idx_datarecord_customer_name (plain column index). Adding an
        // expression index on lower(customer_name) lets SQLite use the
        // index for this equality. At typical site sizes (5K–20K rows)
        // the difference is sub-millisecond either way; at higher row
        // counts the scan-vs-index gap matters.
        //
        // TRIM(customer_number) equality is also non-sargable today —
        // not added here because customer_number is already
        // canonicalised at sync time (no leading/trailing whitespace
        // on the rows from runConnectionImport), so the TRIM is a
        // belt-and-braces guard against historical drift rather than
        // a real performance concern. If query-plan analysis later
        // shows TRIM hurting on a large estate, mirror this pattern
        // in a follow-up migration.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_datarecord_customer_name_lower
            ON datarecord(lower(customer_name))
        `);
      },
    };
