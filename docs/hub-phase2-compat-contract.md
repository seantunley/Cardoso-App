# Hub frontend compatibility contract for Phase 2

Purpose: preserve current Hub UI behavior while Phase 2 moves Hub storage and backend internals. This is an additive, zero-behavior-change contract for backend work.

## Audited frontend consumers

- `src/pages/HubDashboard.jsx`
- `src/components/customer/FlaggedCustomersModal.jsx`
- `src/pages/HubMetrics.jsx`
- `src/pages/HubBackups.jsx`
- `src/pages/HubTrends.jsx`
- `src/pages/HubSyncLog.jsx`
- `src/pages/HubAuditLog.jsx`
- `src/pages/Inventory.jsx`
- `src/pages/Users.jsx`
- `src/components/users/HubUserManager.jsx`
- `src/components/settings/SettingsPanel.jsx` (hub sync, hub KPIs, hub rule push surface)
- `src/Layout.jsx` (backup attention badge)

## High priority compatibility rules

1. Keep endpoint URLs unchanged.
2. Keep response top-level keys unchanged, especially array keys like `sites`, `records`, `results`, `data`.
3. Preserve current sort order unless a route already documents filters only.
4. Preserve offset pagination semantics on `/api/hub/records`.
5. Preserve nullable/missing-field tolerance. Frontend often falls back, but it still expects keys to exist when data is present.
6. Preserve current date/time field formats as ISO-like strings consumable by `new Date(...)`.
7. Do not silently rename `site_id`, `site_slug`, `site_name`, `flag_color`, `updated_date`, `started_at`, `created_at`, `timestamp`.

---

## Endpoint contract checklist

### `GET /api/hub/kpis`
Consumers:
- `HubDashboard`
- `Users`
- `SettingsPanel`

Request assumptions:
- Optional `since=YYYY-MM-DD`

Response shape required:
```json
{
  "total_records": 0,
  "records_by_flag": { "none": 0, "red": 0, "orange": 0, "green": 0 },
  "sites": [
    {
      "site_id": "...",
      "site_slug": "...",
      "site_name": "...",
      "status": "ok|online|offline|...",
      "last_seen": "ISO date or null",
      "kpis": {
        "total_records": 0,
        "records_by_flag": { "red": 0, "orange": 0, "green": 0, "none": 0 }
      }
    }
  ],
  "since": "YYYY-MM-DD or null",
  "generated_at": "ISO date"
}
```
Compatibility notes:
- `sites` must stay an array.
- `site_id`, `site_slug`, `site_name`, `status`, `last_seen` must remain available per site.
- `kpis.records_by_flag.red|orange|green` power HubDashboard cards.
- `status === "ok" || status === "online"` currently renders as online.
- `sites.length > 0` is used by `Users` to infer hub mode.

### `GET /api/hub/records`
Consumers:
- `HubDashboard` search
- `FlaggedCustomersModal`

Request assumptions:
- Optional: `site_id`, `flag_color`, `search`
- Pagination: `limit`, `offset`

Response shape required:
```json
{
  "count": 20,
  "total": 123,
  "limit": 20,
  "offset": 0,
  "has_more": true,
  "records": [ { "...expanded record fields...": "..." } ]
}
```
Required behavior:
- Must remain ordered by newest updated record first, currently `updated_date DESC` with stable tie-breaker.
- Must preserve offset pagination semantics.
- `has_more` must remain boolean.
- Search must continue matching both `customer_name` and `customer_number`.

Record fields currently relied on by Hub UI:
- `record_id` or `id` for keys
- `site_id`
- `customer_number`
- `customer_name`
- `account_type`
- `flag_color`
- `flag_reason`
- `outstanding_balance`
- `updated_date`
- `synced_at`
- `last_unpaid_invoice_1..3`
- `last_unpaid_invoice_1_amount..3_amount`
- `last_unpaid_invoice_1_date..3_date`
- `last_receipt_1..3`
- `last_receipt_1_amount..3_amount`
- `last_receipt_1_date..3_date`
- `unpaid_invoices` as parsed array when present
- `receipts` as parsed array when present

### `GET /api/hub/customer-lookup`
Consumers:
- `HubDashboard` customer modal

Request assumptions:
- Required: `query`, `site_id`

Response shape required:
```json
{
  "record": { "...expanded record...": "..." } | null,
  "subAccounts": [ { "...expanded record...": "..." } ]
}
```
Required behavior:
- Must keep exact `subAccounts` camelCase key.
- If no match, return `{ record: null, subAccounts: [] }`.
- Sub-accounts must remain ordered by `customer_number ASC, id ASC` for stable display.
- Main record and sub-accounts must expose the same balance/invoice/receipt fields as `/api/hub/records`.

### `GET /api/hub/sync-log`
Consumers:
- `HubSyncLog`
- `SettingsPanel`

Request assumptions:
- Optional `limit`, capped today but UI only depends on array results.

Response shape required:
- Raw array, newest first.
- Row fields used:
  - `site_slug`
  - `status` (`success`, `error`, `partial`, or unknown)
  - `records_fetched`
  - `started_at`
  - `error_message`

Required behavior:
- Preserve newest-first ordering.
- Preserve status vocabulary above for icon rendering.

### `POST /api/hub/sync`
Consumers:
- `HubDashboard`
- `HubSyncLog`
- `SettingsPanel`

Required behavior:
- Keep endpoint and `POST` verb.
- Keep returning a success status quickly, before long-running sync completes.
- Current frontend does not inspect body, but async acceptance behavior is important.

### `POST /api/hub/force-resync`
### `POST /api/hub/force-resync/:siteId`
Consumers:
- `HubDashboard`

Required behavior:
- Keep both endpoints and `POST` verb.
- Whole-hub endpoint must remain destructive/full refresh.
- Per-site endpoint must accept `siteId` path param and return success without waiting for full completion.
- Per-site response is currently read for `error` only on failure.

### `GET /api/hub/audit-log`
Consumers:
- `HubAuditLog`

Request assumptions:
- Optional `limit`

Response shape required:
- Raw array, newest first.
- Row fields used:
  - `id`
  - `created_at`
  - `action`
  - `performed_by`
  - `target`
  - `detail`

Required behavior:
- Preserve newest-first ordering.
- Preserve `action` values used for tooltips where possible: `push_users`, `resync`, `force_resync`, `pull_backups`, `sync`, `delete_backup`, `push_flag_rules`, `update_settings`.

### `GET /api/hub/trends`
Consumers:
- `HubTrends`

Request assumptions:
- Required by UI: `period=weekly|monthly`
- Optional `since=YYYY-MM-DD`

Response shape required:
```json
{
  "period": "weekly|monthly",
  "since": "YYYY-MM-DD",
  "data": [
    {
      "period": "2026-W14 or 2026-04",
      "site_id": "...",
      "site_name": "...",
      "total_records": 0,
      "flagged_records": 0,
      "flag_rate": 0
    }
  ]
}
```
Required behavior:
- Keep `data` as a flat row array.
- Preserve ascending order by bucket then site for stable chart generation.
- Keep `period` string values stable because chart X axis uses them directly.
- Keep `site_name` populated, charts group by it.

### `GET /api/hub/speedtest`
Consumers:
- `HubMetrics`

Response shape required:
```json
{ "results": [ ... ] }
```
Fields used per row:
- `id`
- `site_slug`
- `timestamp`
- `download_mbps`
- `upload_mbps`
- `ping_ms`
- `server_name`
- `isp`

Required behavior:
- Preserve order `site_slug`, then newest `timestamp` first inside each site grouping.
- Empty state should remain `{ results: [] }`, not `null`.

### `GET /api/hub/ping-status`
Consumers:
- `HubMetrics`

Response shape required:
```json
{ "sites": [ { "site_slug": "...", "online": true, "latency_ms": 12, "timestamp": "..." } ] }
```
Required behavior:
- Exactly one latest row per site slug.
- `site_slug` is the join key used by frontend.

### `GET /api/hub/machine-health`
Consumers:
- `HubMetrics`

Response shape required:
```json
{
  "sites": [
    {
      "site_id": "...",
      "site_slug": "...",
      "site_name": "...",
      "url": "...",
      "ok": true,
      "message": null,
      "checked_at": "ISO date or null",
      "app_version": "... or null",
      "machine": {
        "hostname": "...",
        "os_version": "...",
        "uptime_seconds": 0,
        "last_boot_at": "ISO date or null",
        "local_ips": []
      },
      "cpu": { "usage_percent": 0, "sample_seconds": 3, "sampled": true },
      "memory": { "total_bytes": 0, "used_bytes": 0, "free_bytes": 0, "used_percent": 0 },
      "disks": [],
      "cardoso_service": { "present": true, "status": "Running", "start_type": "Automatic" },
      "health": { "status": "ok|warning|critical|unavailable", "needs_attention": false, "reasons": [] }
    }
  ],
  "attention": false
}
```
Required behavior:
- `site_slug` must remain the join key for ping badges.
- `health.status` vocabulary must stay `ok|warning|critical|unavailable`.
- Fallback objects for unavailable sites are important, because UI reads nested keys directly.

### `POST /api/hub/speedtest/pull`
### `POST /api/hub/speedtest/run-site`
Consumers:
- `HubMetrics`

Required behavior:
- Keep both endpoints and `POST` verb.
- `/run-site` request body must continue accepting `{ slug }`.
- `/pull` response should keep `{ pulled }`.
- Error responses should continue returning JSON with `error` when possible.

### `GET /api/hub/backup-settings`
### `POST /api/hub/backup-settings`
Consumers:
- `HubBackups`

Required behavior:
- GET must return `{ backup_sync_enabled: boolean }`.
- POST must accept and return `backup_sync_enabled` boolean.

### `GET /api/hub/backup-status`
Consumers:
- `HubBackups`
- `Layout`

Response shape required:
```json
{
  "sites": [ ... ],
  "sql_attention": true
}
```
Fields used per site:
- `site_id`, `site_name`, `url`
- `status`
- `error`
- `db_size`
- `last_backup` with `mtime`, `size`, `total_backups`
- `sql_backup.health.status`
- `sql_backup.health.needs_attention`
- `sql_backup.health.last_success_at`
- `sql_backup.lastJob.size`
- `sql_backup.lastJob.archiveSize`
- `sql_backup.databases[]` with `name`, `backupAt`, `objectStatus`, `isSuccess`
- `sql_backup.ok`
- `sql_backup.message`

Required behavior:
- Keep `sql_attention` boolean for the nav badge.
- Keep site `status` vocabulary: `ok`, `warning`, `stale`, `never`, `error`, `unreachable`, `unknown`.
- Keep `sql_backup.health.status` vocabulary: `ok`, `stale`, `failed`, `unavailable`.

### `GET /api/hub/hub-backup-status`
Consumers:
- `HubBackups`

Response shape required:
```json
{
  "sites": [
    {
      "site_id": "...",
      "hub_backup_count": 0,
      "hub_last_backup": "ISO date or null",
      "hub_last_size": 0,
      "hub_last_filename": "...",
      "integrity": "ok|corrupt|unchecked"
    }
  ]
}
```
Required behavior:
- Keep `sites` array keyed by `site_id` compatibility.
- Keep `integrity` values stable for badge mapping.

### `POST /api/hub/pull-backups-now`
### `GET /api/hub/proxy-backup`
### `GET /api/hub/proxy-config`
Consumers:
- `HubBackups`

Required behavior:
- `pull-backups-now` should return quickly after starting work.
- `proxy-backup` and `proxy-config` must continue accepting `site_id` query param.
- Download endpoints must keep non-JSON blob/text responses on success.
- Failures should keep JSON `{ error }` when possible.

### `GET /api/hub/my-sites`
Consumers:
- `Inventory`

Response shape required:
- Array of sites, each with at least: `id`, `site_id`, `slug`, `name`, `last_seen`, `status`

Required behavior:
- Empty array means no visible sites.
- `Inventory` currently uses `id` and `name || slug || id`.

### `GET /api/hub/inventory`
Consumers:
- `Inventory`

Request assumptions:
- Optional `site_id`, `search`, `commodity`

Response shape required:
```json
{ "count": 0, "records": [ ... ] }
```
Fields used per record:
- `site_id`
- `site_name`
- `item_number`
- `item_description`
- `qty_on_hand`
- `last_cost`
- `price`
- `price_list`
- `stocking_uom`
- `commodity`

Required behavior:
- `records` must remain an array.
- Search must continue matching item number and description.

### `GET /api/hub/users`
Consumers:
- `HubUserManager`

Response shape required:
- Raw array of users.
- Fields used:
  - `id`, `email`, `full_name`, `role`, `is_active`
  - `sites[]` with `slug`, `pushed_at`
  - `allowed_sites[]` with `slug` or direct slug values

Required behavior:
- Keep `allowed_sites` key and nested `slug` support.
- Keep `sites` key and `pushed_at` date field.

### `PUT /api/hub/users/:id/allowed-sites`
Consumers:
- `HubUserManager`

Request assumptions:
```json
{ "site_slugs": ["slug-a", "slug-b"] }
```
Required behavior:
- Keep endpoint and body key `site_slugs`.
- Empty array must continue meaning unrestricted/all sites.

### `POST /api/hub/push-users`
Consumers:
- `HubUserManager`

Request assumptions:
```json
{ "user_ids": [1,2], "site_ids": ["site-a"] | null }
```
Response shape required:
```json
{ "results": [ { "site": "...", "slug": "...", "ok": true, "error": null } ] }
```
Required behavior:
- `site_ids: null` must continue meaning all sites.
- Partial success should keep per-site result rows.

### `POST /api/hub/clear-auto-flags`
### `POST /api/hub/push-rules`
Consumers:
- `SettingsPanel`

Required behavior:
- `/clear-auto-flags` should keep `{ cleared }`.
- `/push-rules` should keep `{ pushed, results }`, where each result has `site` and `status`.

## Known frontend assumptions that backend should not break

- Arrays should stay arrays even when empty. Avoid `null` for `sites`, `records`, `results`, `data`, `subAccounts`, `databases`, `local_ips`, `reasons`.
- Numeric display fields may arrive as numbers or numeric strings today. That flexibility is safe to preserve.
- Frontend tolerates some missing nested data, but not top-level schema swaps.
- Site identity is inconsistent by design across routes (`site_id` vs `site_slug` vs `site_name`); Phase 2 should preserve all three where currently returned.
- Several pages infer hub availability from non-empty `/api/hub/kpis.sites`, so avoid changing that route to omit `sites` or return a non-array sentinel.

## Safe additive work completed in this audit

- Added this compatibility contract document only.
- No frontend behavior changes were made.
- No helper was added because the current best zero-risk move is documentation, not reshaping runtime code during backend prep.

## Suggested backend verification before merge

- Diff current JSON responses vs Phase 2 responses for all routes above.
- Specifically snapshot-check field names, array/object top-level keys, sort order, and empty-state payloads.
- Re-test Hub pages: dashboard, metrics, backups, trends, sync log, audit log, inventory, users.
