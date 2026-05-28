import { ensureColumn, ensureTable } from './_helpers.js';

export default {
  // v84 — hub-side mirror of commission_archive (v83). Mirrors the
  // hub_jti_archive layout (v71): one row per (site_id, sha256), with
  // received_via to distinguish push vs pull. Lives on hub installs;
  // empty on pure-site installs.
  version: 84,
  name: 'hub_commission_archive_table',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_commission_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        site_id         TEXT NOT NULL,
        site_archive_id INTEGER,

        period_year     INTEGER NOT NULL,
        period_month    INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
        period_from     TEXT NOT NULL,
        period_to       TEXT NOT NULL,

        generated_at    TEXT NOT NULL,
        generated_by    TEXT,
        source          TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),

        filename        TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        byte_size       INTEGER NOT NULL,
        sha256          TEXT NOT NULL,

        report_json     TEXT NOT NULL,
        site_label      TEXT,

        received_at     TEXT NOT NULL DEFAULT (datetime('now')),
        received_via    TEXT NOT NULL CHECK (received_via IN ('push', 'pull'))
      )
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_commission_archive_dedup
      ON hub_commission_archive(site_id, sha256)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hub_commission_archive_period
      ON hub_commission_archive(period_year DESC, period_month DESC, received_at DESC)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hub_commission_archive_site
      ON hub_commission_archive(site_id, period_year DESC, period_month DESC)
    `);
  },
};
