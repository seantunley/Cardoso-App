# Hub Postgres Migration

Move the Hub from SQLite to Postgres. This is a major architectural change.
The scaffolding is in place; the work is wiring it into the live runtime,
migrating data, and cutting over without downtime.

## Why

Hub aggregates data from N sites. As the Hub user count and site count grow,
SQLite's single-writer model becomes a bottleneck:

- Every flag change, sync run, manual override, and inventory write
  serializes through one writer thread.
- Hub backup pulls (currently 100MB+ per site, runs nightly across many
  sites) hold long write locks that stall Hub UI requests.
- Cross-site analytics (KPI dashboards, exposure reports, audit queries)
  touch every site's records and increasingly take seconds at SQLite scale.
- Backup story is "copy the file" — fine at small scale, awkward at
  multi-GB Hub-aggregate scale.

Postgres solves all of those: real concurrency, proper backup tooling
(pg_dump, WAL streaming, point-in-time recovery), and query planner that
handles cross-site aggregates well.

**Site-mode deployments (the per-store installs) stay on SQLite.** Postgres
only replaces the Hub-side storage. Sites continue to push data to the Hub
via the existing API; only the Hub's *backing store* changes.

## What's already in place (Phase 2 foundation)

The previous engineering pass laid the scaffolding. None of it is wired
into the live runtime yet — it's all opt-in, additive, behind explicit
scripts and `HUB_POSTGRES_*` env vars.

### Schema and migrations
- `src/hubPostgres/migrations/001_initial_hub_schema.sql`
  Tables: `sites`, `customers`, `customer_balances`, `flag_events`,
  `sync_runs`, `schema_migrations`.
- `src/hubPostgres/migrations/002_import_staging.sql`
  Staging tables for SQLite→Postgres data import with validation columns.
- `src/hubPostgres/migrate.js` — schema migration runner.
- `src/hubPostgres/verify.js` — post-migration verification.
- `src/hubPostgres/importValidator.js` — pre-import data validation.

### Operator scripts
- `scripts/hub-postgres-bootstrap.mjs` — first-time schema setup.
- `scripts/hub-postgres-import.js` — SQLite → Postgres data load.
- `scripts/hub-postgres-verify.mjs` — verifies migrated data integrity.
- `scripts/hub-postgres-bootstrap-notes.md` — operator runbook.

### Runtime scaffolding (NOT wired in)
- `src/hub/storage/adapter.js` — storage adapter interface. Today only
  `createSqliteHubStorageAdapter` exists; no Postgres implementation yet.
- `src/hub/storage/repository.js` — Hub-specific operations on top of the
  adapter (`upsertSites`, `getBackupSyncEnabled`, `listSitesForBackup`).
- `src/hub/storage/runtime.js` — singleton that selects the adapter.
  Currently hardcoded to SQLite.

### Documentation
- `docs/hub-postgres-schema.md` — schema reference.
- `docs/hub-phase2-compat-contract.md` — frontend compatibility contract
  (every Hub API endpoint, expected request/response shape, what must
  not break during the migration).
- `docs/hub-postgres-bootstrap-notes.md` — operator notes.

### Config
- `src/config/hubPostgres.js` — reads env vars, validates them, returns
  the config object.
- `HUB_POSTGRES_URL`, `HUB_POSTGRES_SCHEMA`, `HUB_POSTGRES_ENABLED` env
  vars defined; `HUB_POSTGRES_ENABLED` is currently unused (reserved).

## What's NOT done yet

This is the work scope.

### 1. Postgres adapter (1-2 days)

Implement `createPostgresHubStorageAdapter(pgPool, { schema })` mirroring
the SQLite adapter's interface in `src/hub/storage/adapter.js`. Key
methods to implement, all returning Postgres-flavored equivalents:

- `prepare(sql)` — Postgres's `pool.query` is parameterized by `$1, $2`
  not `?`. Either translate, or pre-rewrite all SQL strings to use
  Postgres placeholders.
- `exec(sql)` — multi-statement DDL.
- `transaction(fn)` — `BEGIN/COMMIT` with rollback on throw.
- `queryOne` / `queryAll` / `run` — same shape, different driver.

Tradeoff to settle: do we translate `?`-style placeholders inside the
adapter, or rewrite every SQL string in `repository.js` (and elsewhere) to
use both styles? Cleaner long-term to write SQL twice (SQLite/Postgres
dialects diverge anyway on things like `INSERT ... ON CONFLICT` syntax,
JSON operators, datetime functions).

### 2. Migrate all Hub-mode SQL out of routes and into the repository (3-5 days)

Right now most Hub routes call `db.prepare(...).all(...)` directly with
SQLite-flavored SQL. To swap the storage backend, every Hub-mode SQL site
needs to go through the repository abstraction.

Audit list (from `grep "db.prepare" src/routes/hub.js src/services/hubEtl.js`
and similar):

- `src/routes/hub.js` — every Hub API endpoint (kpis, records, sites,
  audit log, sync log, backups, inventory). Estimated ~40 SQL sites.
- `src/services/hubEtl.js` — sync-from-site, backup pull, KPI snapshot,
  flag-event recording. ~15 SQL sites.
- `src/services/hubBackupPull.js` (if separate) — same.
- `src/scheduler.js` — Hub schedulers that read site state.
- `src/db/schema.js` — Hub table creation block (currently runs on every
  SQLite init when HUB_MODE=true).

For each site:
- Move the SQL into `repository.js` as a named method.
- Provide both a SQLite and a Postgres implementation.
- Keep the API response shape byte-identical to satisfy
  `docs/hub-phase2-compat-contract.md`.

This is the largest chunk of the work. It's mechanical but extensive.

### 3. Schema reconciliation (1-2 days)

Phase 2's Postgres schema (`001_initial_hub_schema.sql`) doesn't perfectly
match the current SQLite schema. Reconcile:

- Postgres has `customers` and `customer_balances` as separate tables;
  SQLite has them merged into `hub_records`. Decide: split SQLite to
  match, or denormalize Postgres to match. Recommend splitting Postgres
  is the long-term right answer; keep SQLite merged for backwards-compat
  during transition (the adapter joins them on read).
- `flag_events` is a new table on Postgres only. Today flag changes are
  destructive UPDATE on `hub_records`. Need to start writing flag events
  on every flag change AND keep updating the current-state row.
- `sync_runs` exists on both with similar shape; align column names.
- `hub_inventory` and `hub_sync_log` exist on SQLite but not in the
  Postgres bootstrap migration. Add migrations 003+ to add them.

### 4. Data migration (2-3 days)

Move existing Hub SQLite data into Postgres. The
`scripts/hub-postgres-import.js` is the starting point but needs:

- **Idempotent re-runnable import.** Each row keyed by natural key
  (`site_id + record_id`), upsert on conflict. Lets you re-run if
  something goes wrong.
- **Validation pass.** Use `importValidator.js` to dry-run every row;
  collect violations into a CSV report; refuse to import if violations
  exceed threshold.
- **Counts reconciliation.** Pre-import: row counts per table on SQLite.
  Post-import: row counts per table on Postgres. Fail loudly if mismatch.
- **JSON normalization.** SQLite stores `unpaid_invoices` as TEXT;
  Postgres stores as `jsonb`. Parse-validate-stringify each row during
  import. Reject rows with invalid JSON; report and skip.

### 5. Cutover strategy (decision point + 1-2 days)

Two options:

**Option A: Cold cutover.**
- Hub goes into maintenance mode (refuse writes for ~30 min).
- Run full SQLite→Postgres import.
- Verify counts.
- Flip `HUB_POSTGRES_ENABLED=true`, restart Hub.
- Test critical paths.
- Done.

Pros: simple, predictable, easy rollback (set env var back, restart).
Cons: maintenance window required.

**Option B: Dual-write + backfill.**
- Hub writes to BOTH SQLite and Postgres for a transition period.
- Reads continue to use SQLite.
- One-time backfill of historical SQLite data into Postgres.
- Verification phase: every read also queries Postgres in shadow mode,
  diff results, log any divergence.
- When zero divergence for N days, flip reads to Postgres.
- Stop writing to SQLite.

Pros: zero downtime, observable cutover, easy rollback at any phase.
Cons: more code complexity, longer total project.

Recommend **Option A** for our use case. The Hub is internal, off-hours
maintenance windows are acceptable, and the simpler path leaves less code
debt.

### 6. Rollback path (0.5 day)

If Postgres migration causes problems on the live Hub:

- Set `HUB_POSTGRES_ENABLED=false`.
- Restart Hub service.
- SQLite resumes serving (it was never deleted).
- Postgres state from the gap is lost — accept this as the cost of
  rollback.

For Option A this is trivial. For Option B it's already designed in.

### 7. Operational changes (1 day)

- **Backup story**: Postgres `pg_dump` cron, document recovery procedure.
- **Connection pooling**: tune `pg.Pool` size for Hub load. Default 10
  is probably fine but verify.
- **Monitoring**: Hub now has an external dependency (Postgres). If
  Postgres goes down, Hub goes down. Decide if we want a circuit breaker
  or just rely on health checks.
- **Local dev**: developers need a local Postgres or a Postgres-in-Docker
  setup. Document in README.

### 8. Performance verification (1 day)

Before declaring done:

- Hub KPI dashboard load time (was ~Xms on SQLite, should be ≤Xms on
  Postgres).
- Cross-site audit log query (single SELECT scanning all sites' records)
  — this is where Postgres should outperform SQLite by 2-5x.
- Backup pull throughput — should be unaffected (the bottleneck is
  network, not storage).
- Concurrent writes — fire 50 simultaneous flag changes from a load
  test, confirm no SQLITE_BUSY-style errors.

## Total estimate

**8-12 focused engineering days.** Real-time elapsed: 2-3 weeks if it's
the only work in flight, 4-6 weeks if interleaved with other features
and bug fixes.

Critical-path order:
1. Schema reconciliation (decisions need to be made before anything else)
2. Postgres adapter
3. Repository abstraction (the 40+ SQL site refactor)
4. Data migration script + dry-run testing
5. Cutover prep + rollback documentation
6. Live cutover (one specific maintenance window)
7. Performance verification + monitoring tuning

## Risks

- **Site-mode deployments must remain unaffected.** Sites use SQLite for
  their own customer database. Nothing in this migration should touch
  per-site DB code paths. Audit at the end.
- **Frontend compat is non-negotiable.**
  `docs/hub-phase2-compat-contract.md` is the contract. Every endpoint's
  response shape is locked. The repository abstraction must produce
  byte-identical JSON to today.
- **Postgres operational expertise.** Whoever runs the cutover needs to
  know how to recover from common Postgres incidents (lock contention,
  bloat, slow queries). Run a fire-drill scenario before cutover.
- **Cost.** Hub now needs a Postgres instance. Managed Postgres (RDS,
  Supabase, Neon) is reasonable. Self-hosted is fine but adds ops load.
- **Partial failures during cutover.** Option A's maintenance window is
  predictable but if validation fails at the verify step, you're either
  rolling back the whole window or extending downtime to investigate.
  Have a clear "halt and roll back" trigger defined ahead of time.

## When to do this

**Not in parallel with the PDF engine migration** (`docs/plans/pdf-engine-migration.md`).
Both are major changes. Doing them simultaneously triples the surface
area to verify and makes blame attribution impossible if something
regresses.

Sequence:
1. Park PDF engine migration where it sits today (pinned + CI guard +
   plan documented).
2. Pick Hub Postgres OR PDF engine as the next major.
3. Finish that one cleanly with regression validation.
4. Then start the other.

Hub Postgres is more impactful but bigger scope. PDF engine is smaller
but gates a future pdfjs upgrade. Pick based on which problem is biting
hardest — right now neither is, so the choice can wait for a calm
window.

## Open questions

- Which Postgres host? Self-hosted, RDS, Supabase, Neon? Affects backup
  story and connection-string management.
- Should we do this on dedicated hardware or a managed service?
- Schema name — `hub` is the default. Does the operations team have a
  naming convention?
- Are flag-event records expected to be append-only (audit) or are they
  a current-state snapshot? Affects how aggressively we prune old events.
