import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 63,
      name: 'hub_sites_orphan_tombstone',
      up(db) {
        // hub_sites and HUB_SITES (the env-derived in-memory list) drift:
        // upsertSites writes new rows but never removes ones whose ids
        // dropped out of the env. The schedulers iterate HUB_SITES so
        // orphan rows simply stop being refreshed, but the dashboard
        // still serves them — operators see a tile that looks live but
        // is actually frozen. Worse: per-site action endpoints (trigger
        // accpac sync, force-resync, push-rules) happily forward to the
        // orphan's stored URL because they read hub_sites directly.
        //
        // Soft-tombstone fixes both gaps. upsertSites flips in_env=0 on
        // any row whose id is NOT in the incoming list (and stamps
        // removed_from_env_at the first time it does). Action endpoints
        // refuse on orphans with a clear 409. The UI shows orphans with
        // a badge but doesn't act on them, and an admin "Forget" button
        // is the only way to delete the row + cascade to hub_records /
        // hub_inventory.
        //
        // Default in_env=1 so existing rows are treated as live on
        // first boot — the next upsertSites call reconciles correctly.
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'in_env',              "INTEGER NOT NULL DEFAULT 1");
          ensureColumn(db, 'hub_sites', 'removed_from_env_at', 'TEXT');
          db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_sites_in_env ON hub_sites(in_env)`);
        }
      },
    };
