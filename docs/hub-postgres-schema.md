# Hub Postgres Schema Bootstrap

## Purpose
This is an additive Phase 2 foundation for Hub-side Postgres storage.
It does **not** replace or rewire the current SQLite-backed Hub flow.
The new schema is opt-in and isolated behind explicit scripts plus dedicated `HUB_POSTGRES_*` environment variables.

## Environment
- `HUB_POSTGRES_URL`: Postgres connection string used only by the bootstrap and verification scripts
- `HUB_POSTGRES_SCHEMA`: optional schema name, defaults to `hub`
- `HUB_POSTGRES_ENABLED`: reserved feature flag for later application wiring, defaults to off

## Commands
```bash
npm run hub:postgres:bootstrap -- --dry-run
npm run hub:postgres:bootstrap
npm run hub:postgres:verify
```

## Tables
### `sites`
Hub site registry and hub-only operational status fields.

### `customers`
One row per Hub customer record, unique on `(site_id, source_record_id)`.
This keeps the current Hub record identity model intact while separating customer identity from balance state.

### `customer_balances`
Current balance snapshot keyed by `customer_id`.
Balances stay lossless for now via `outstanding_balance_text` rather than forcing numeric parsing during the foundation phase.
JSON payloads for `unpaid_invoices` and `receipts` are stored as `jsonb`.

### `flag_events`
Append-friendly event store for flag snapshots and later flag-change auditing.
This is intentionally separate from `customer_balances` so history can evolve without mutating the current-state row design.

### `sync_runs`
Hub sync run ledger for future Postgres ETL work.
Tracks scope, status, counts, and structured details JSON.

### `schema_migrations`
Per-schema migration ledger managed by the bootstrap runner.

## Isolation guarantees
- No existing SQLite tables are touched.
- No Hub route, ETL, or sync path is rewired to Postgres in this iteration.
- No site-mode code path reads or writes the new schema.
- The bootstrap only runs when explicitly invoked.

## Verification
`npm run hub:postgres:verify` re-runs migrations safely, then checks that the required tables and indexes exist in the target schema.

## Known risks / follow-up
- `token` remains stored as plain text for parity with current Hub SQLite behavior. Hardening can happen in a later iteration.
- Balance amounts remain text to avoid unsafe coercion during schema foundation work.
- Future ETL work will need explicit upsert rules to keep `customers.site_id` and `customer_balances.site_id` aligned.
