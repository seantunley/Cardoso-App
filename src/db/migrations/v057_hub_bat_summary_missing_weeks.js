import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 57,
      name: 'hub_bat_summary_missing_weeks',
      up(db) {
        // Add a missing_weeks_count column for the Hub Reconciliation page's
        // per-site card. Unlike awaiting_count (BAT uploaded, Sage hasn't
        // posted yet), this counts the inverse — weeks where Sage HAS
        // credit notes but no BAT recon has been uploaded yet. Operators
        // need this prominently because it tells them which sites are
        // behind on data entry.
        try {
          const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='hub_bat_summary'"
          ).get();
          if (!tableExists) return;
          const cols = db.prepare("PRAGMA table_info(hub_bat_summary)").all().map(c => c.name);
          if (!cols.includes('missing_weeks_count')) {
            db.exec(`ALTER TABLE hub_bat_summary ADD COLUMN missing_weeks_count INTEGER DEFAULT 0`);
          }
        } catch (err) {
          console.error('[migration 57] hub_bat_summary column add failed:', err.message);
        }
      },
    };
