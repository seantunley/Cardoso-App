# Phase 2 kickoff, hub Postgres foundation

Date: 2026-04-10
Branch: phase2/hub-postgres-foundation

## Completed in this slice
- Added hub-only Postgres env/config scaffold, disabled by default.
- Added hub storage foundation runtime with a SQLite-backed adapter.
- Added a hub repository layer for backup settings, site registry, and backup-site listing.
- Switched hub backup settings and hub ETL bootstrap/backup-pull paths to use the new repository layer.
- Kept SQLite as the active live path for all reads and writes.
- Confirmed startup validation does not require Postgres when disabled.

## Safety notes
- Additive only, no live-path cutover.
- No frontend changes.
- No Postgres connection attempts are made in this slice.
- Invalid Postgres config only fails startup when HUB_POSTGRES_ENABLED=true on a hub instance.

## Validation results
- `npm run lint` ✅
- `npm run build` ✅
- `npm run typecheck` ⚠️ fails on broad pre-existing frontend typing issues outside this slice
- direct Node ESM import probe ⚠️ blocked in this environment because `better-sqlite3` native bindings for Node v24 are not present
