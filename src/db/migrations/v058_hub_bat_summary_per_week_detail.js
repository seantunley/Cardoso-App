import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 58,
      name: 'hub_bat_summary_per_week_detail',
      up(db) {
        // Add per-week-detail fields to hub_bat_summary so the Hub
        // Reconciliation per-site card can show the same level of detail
        // the operator sees on each site's own dashboard:
        //
        //   - last_paid_week / last_paid_year: highest week with Sage
        //     credit notes posted (e.g. "W9/2026")
        //   - missing_credit_notes_weeks: JSON array of week numbers in
        //     the current ISO year where BAT was uploaded but Sage has
        //     no credit notes yet (the site's "Missing Credit Notes"
        //     tile, scoped to one site)
        //   - mismatch_weeks: JSON array of week numbers where both
        //     sides exist but the variance exceeds R0.01 — the weeks
        //     that need investigation
        //   - summary_year: ISO year the lists are scoped to (so a
        //     stale row from a prior year doesn't keep showing).
        try {
          const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='hub_bat_summary'"
          ).get();
          if (!tableExists) return;
          const cols = db.prepare("PRAGMA table_info(hub_bat_summary)").all().map(c => c.name);
          const add = (name, decl) => {
            if (!cols.includes(name)) db.exec(`ALTER TABLE hub_bat_summary ADD COLUMN ${name} ${decl}`);
          };
          add('last_paid_week', 'INTEGER');
          add('last_paid_year', 'INTEGER');
          add('last_bat_week', 'INTEGER');
          add('last_bat_year', 'INTEGER');
          add('missing_credit_notes_weeks', 'TEXT');
          add('mismatch_weeks', 'TEXT');
          add('summary_year', 'INTEGER');
        } catch (err) {
          console.error('[migration 58] hub_bat_summary per-week detail add failed:', err.message);
        }
      },
    };
