import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 59,
      name: 'bat_year_scoped_indexes',
      up(db) {
        // The /api/reporting/bat-summary endpoint and the new per-site card
        // queries all filter by year first (WHERE r.year = ?), but the
        // existing idx_bat_recon_week index is keyed on (week_number, year)
        // — leading column wrong, can't satisfy a year-only filter. SQLite
        // falls back to a full scan of bat_reconciliations / bat_sage_week_cache
        // for each year-scoped query (6 of them per /api/reporting/bat-summary
        // call, fired by the hub every 5 min per site). Invisible today
        // with sub-300-row tables, but real load by year 3.
        //
        // Add proper year-leading indexes; idempotent (CREATE INDEX IF NOT
        // EXISTS).
        try {
          db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_recon_year_week ON bat_reconciliations(year, week_number)`);
        } catch (err) {
          console.error('[migration 59] idx_bat_recon_year_week failed:', err.message);
        }
        try {
          db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_sage_cache_year_week ON bat_sage_week_cache(year, week_number)`);
        } catch (err) {
          console.error('[migration 59] idx_bat_sage_cache_year_week failed:', err.message);
        }
        try {
          // Partial index for the exceptions count — typically <1% of
          // extractions are flagged so a partial index is much smaller
          // than a regular one and serves the bat-summary query directly.
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_bat_extractions_exception
              ON bat_invoice_extractions(is_exception)
              WHERE is_exception = 1
          `);
        } catch (err) {
          console.error('[migration 59] idx_bat_extractions_exception failed:', err.message);
        }
      },
    };
