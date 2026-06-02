import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 48,
      name: 'hub_bat_summary',
      up(db) {
        // Per-site BAT reconciliation summary, populated by the daily hub puller.
        // One row per site (site_id is PK). Hub UI aggregates these into the
        // cross-site Reconciliation page.
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_bat_summary (
            site_id TEXT PRIMARY KEY,
            total_supplier REAL DEFAULT 0,
            total_sage REAL DEFAULT 0,
            total_variance REAL DEFAULT 0,
            weeks_count INTEGER DEFAULT 0,
            matched_count INTEGER DEFAULT 0,
            mismatch_count INTEGER DEFAULT 0,
            awaiting_count INTEGER DEFAULT 0,
            total_exceptions INTEGER DEFAULT 0,
            total_exception_amount REAL DEFAULT 0,
            last_upload_at TEXT,
            synced_at TEXT,
            last_error TEXT
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_bat_summary_synced ON hub_bat_summary(synced_at)`);
      },
    };
