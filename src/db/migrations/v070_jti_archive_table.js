import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // JTI archive — versioned per (period_year, period_month) so the
      // operator's manual exports and the scheduled monthly job both
      // get persisted side-by-side without overwriting each other.
      // Files live on disk under uploads/jti-archive/<YYYY>-<MM>/; this
      // table stores the metadata + the hub-push state machine.
      //
      // Hub push lifecycle:
      //   pending  → never attempted (fresh row)
      //   pushed   → hub acknowledged receipt
      //   failed   → push attempted, hub returned error or unreachable;
      //              hub_push_attempts incremented; retry job picks it up
      //   skipped_no_hub → site isn't configured for hub mode (no
      //                    HUB_URL/REPORTING_TOKEN); won't be retried
      // The hub-side mirror table (hub_jti_archive) lives in a later
      // migration on the hub-mode side; keeping site-side and hub-side
      // schemas separate keeps the per-install footprint minimal.
      version: 70,
      name: 'jti_archive_table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS jti_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Calendar month this export covers
            period_year   INTEGER NOT NULL,
            period_month  INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

            -- Provenance
            generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            generated_by  TEXT,
            source        TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),

            -- File on disk
            filename      TEXT NOT NULL,
            file_path     TEXT NOT NULL,
            byte_size     INTEGER NOT NULL,
            sha256        TEXT NOT NULL,
            row_count     INTEGER NOT NULL,

            -- Snapshot of the address fields stamped into this archive,
            -- so a future "what label values did we use for April?"
            -- can be answered without re-reading the .xlsx.
            town_city     TEXT,
            region        TEXT,
            country       TEXT,
            site_label    TEXT,

            -- Hub push state machine (see migration comment)
            hub_push_status   TEXT NOT NULL DEFAULT 'pending'
              CHECK (hub_push_status IN ('pending', 'pushed', 'failed', 'skipped_no_hub')),
            hub_push_at       TEXT,
            hub_push_error    TEXT,
            hub_push_attempts INTEGER NOT NULL DEFAULT 0
          )
        `);
        // Most common read: "list archives, latest first per period"
        // — drives the JTI page's Archive panel. (DESC, DESC, DESC)
        // matches the natural display order so SQLite can serve it
        // from the index without sorting.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_jti_archive_period
          ON jti_archive(period_year DESC, period_month DESC, generated_at DESC)
        `);
        // Retry job scans rows in pending/failed state hourly; this
        // index keeps that scan cheap as the archive grows.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_jti_archive_hub_push
          ON jti_archive(hub_push_status)
        `);
      },
    };
