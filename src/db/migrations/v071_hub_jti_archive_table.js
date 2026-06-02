import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // v71 — hub_jti_archive: hub-side mirror of the per-site
      // jti_archive table (v70). Runs on hub installs only (the
      // table is created everywhere, but is empty / unused on a
      // pure site install). One row per (site_id, sha256) — sha256
      // is the natural dedup key, so a push followed by a pull-
      // fallback that targets the same archive can't double-insert.
      //
      // received_via captures whether the archive arrived via the
      // site→hub PUSH or the hub→site PULL fallback. Useful for
      // debugging "why did the hub not get last month's archive
      // until 24h after the site generated it" investigations.
      version: 71,
      name: 'hub_jti_archive_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_jti_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Which site this came from (matches HUB_SITES.id)
            site_id        TEXT NOT NULL,
            site_archive_id INTEGER,

            -- Calendar month
            period_year    INTEGER NOT NULL,
            period_month   INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

            -- Provenance copied from the site row
            generated_at   TEXT NOT NULL,
            generated_by   TEXT,
            source         TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),

            -- File on hub disk
            filename       TEXT NOT NULL,
            file_path      TEXT NOT NULL,
            byte_size      INTEGER NOT NULL,
            sha256         TEXT NOT NULL,
            row_count      INTEGER NOT NULL,

            -- Snapshot of label fields the site stamped in
            town_city      TEXT,
            region         TEXT,
            country        TEXT,
            site_label     TEXT,

            -- How / when the hub got the file
            received_at    TEXT NOT NULL DEFAULT (datetime('now')),
            received_via   TEXT NOT NULL CHECK (received_via IN ('push', 'pull'))
          )
        `);
        // Natural dedup key — a site uploading the same .xlsx twice
        // (push retry, push then pull-fallback) collapses to one row.
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_jti_archive_dedup
          ON hub_jti_archive(site_id, sha256)
        `);
        // Most common UI read: list across all sites, latest period
        // first.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_hub_jti_archive_period
          ON hub_jti_archive(period_year DESC, period_month DESC, received_at DESC)
        `);
        // Per-site filtered listing.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_hub_jti_archive_site
          ON hub_jti_archive(site_id, period_year DESC, period_month DESC)
        `);
      },
    };
