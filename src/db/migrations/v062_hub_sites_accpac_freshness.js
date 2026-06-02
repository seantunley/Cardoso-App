import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // Restored after the v62 entry was lost in a merge between PR #198,
      // PR #200, and PR #214 — production hubs upgrading to 2026.5.2 hit
      // "no such column: last_accpac_synced_at" on every hub.sync tick
      // because hubEtl.js / routes/hub.js / HubDashboard.jsx all reference
      // these three columns that the v62 migration was supposed to add.
      // Idempotent (ensureColumn) so re-running on installs that already
      // got the column some other way is a no-op.
      //
      // Two-channel install path (don't drop one without the other):
      //   - Existing hub installs: this migration ensureColumns the
      //     three columns onto the already-existing hub_sites table.
      //   - Fresh hub installs: runMigrations runs BEFORE schema.js's
      //     CREATE TABLE hub_sites (line 206 vs 212), so this migration
      //     no-ops and records itself as applied before hub_sites
      //     exists. The CREATE TABLE in schema.js is the canonical
      //     source — it includes the three accpac columns directly so
      //     fresh installs get them at creation time. Codex flagged
      //     this on PR #228: without the schema.js half, v62 would
      //     mark itself applied and the columns would never appear.
      version: 62,
      name: 'hub_sites_accpac_freshness',
      up(db) {
        // The hub's customer-management page used to show `last_seen` as
        // the freshness metric, but that's "when did the hub last reach
        // the site", not "when did the site last sync from Accpac". The
        // dashboard tile now surfaces the latter — the operator-relevant
        // signal for "is the data on this tile stale?".
        //
        // Three columns:
        //   - last_accpac_synced_at: most recent SUCCESSFUL Accpac sync
        //     (max of databaseconnection.last_sync across active
        //     non-BAT-only connections).
        //   - last_accpac_status: 'ok' | 'error' | 'never_synced'.
        //   - last_accpac_error: short user-facing reason via
        //     describeSqlError when status='error'.
        //
        // Gated on hub_sites table existing. On fresh installs the table
        // doesn't exist yet (schema.js creates it AFTER runMigrations) —
        // the CREATE TABLE there carries the three columns natively, so
        // this gate-skip is correct, not a bug. On existing hub installs
        // the table is present and we ensureColumn the new columns onto
        // it. Non-hub installs never have the table; the column is
        // meaningless there.
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'last_accpac_synced_at', 'TEXT');
          ensureColumn(db, 'hub_sites', 'last_accpac_status',     'TEXT');
          ensureColumn(db, 'hub_sites', 'last_accpac_error',      'TEXT');
        }
      },
    };
