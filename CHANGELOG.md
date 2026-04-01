# Changelog

## [2026.2.3] - 2026-04-01

### Features
- **Auto-flag rules** — full overhaul with support for date, number, and empty conditions on real record fields (`last_unpaid_invoice_date`, `last_receipt_date`, `outstanding_balance`, etc.)
- **Auto-flag AND/OR logic** — per-condition AND/OR operators, evaluated left-to-right
- **Auto-flag rule tester** — tests against real records, returns up to 5 flagged and 5 unflagged samples with condition breakdowns
- **Auto-flag on sync** — rules applied automatically when records sync; manual flags never overwritten
- **Apply Now / Clear Auto Flags** — server-side batch endpoints for fast bulk apply/clear in a single DB transaction
- **Flag source tracking** — records track whether a flag was set manually or by a rule (`flag_source`)
- **Auto-flag banner** — prominent color-matched banner in customer popup and record card showing triggering rule name
- **Active toggle** — enable/disable rules directly from collapsed rule row without opening editor
- **Centralized User Management** — hub can push users (roles, permissions, active status) to all sites or selected sites; passwords never overwritten; new users get a default password and must change it on first login
- **Customer Balances** — flag color dot added to outstanding balance table
- **Inventory** — inventory sync, hub ETL, and Inventory page now in main

### Fixes
- Parse `YYYYMMDD` date format correctly in rule evaluator (server + client)
- Strip spaces from numbers in rule evaluator (South African number format e.g. `1 234.56`)
- Serialize rule conditions JSON in PUT handler — rules were reverting to empty on server restart
- `const data` → `let data` crash in generic PUT handler
- Respect manual flags during auto-flag sync; clear auto-flags when rules no longer match
- `auto_flagged = 0` from SQLite rendered as `0` in React — fixed with `!!` coercion
- `flag_color = null/0` from SQLite caused crash in flag badge — falls back to "No Flag" styling
- Strip `Auto-flagged:` prefix from `flag_reason` to prevent duplication in banner
- Missing `Zap` import in `CustomerLookup.jsx` caused blank page crash
- Admin users always get `can_manage_rules = true` regardless of DB column state
- Back-fill `can_manage_rules = 1` for existing admins on startup
- Customer Balances site filter hidden on single-site installs
- Settings page removed — gear icon modal (`SettingsPanel`) is the only settings UI

### Performance
- Apply/clear auto-flags moved to server-side single-transaction endpoints — eliminates N client-side API calls

---

## [2026.2.2] - 2026-03-31

### Features
- Inventory sync, hub ETL, and Inventory page
- Customer Balances page with site filter, invoice/receipt details, stacked columns
- Hub customer search (server-side, fixes All Sites missing records)
- Hub mode lands on Hub Dashboard on login
- Sidebar: Connections moved into Settings panel as a tab
- Sidebar: compact layout, briefcase logo, user block under branding

### Fixes
- `datetime("now")` replaced with `CURRENT_TIMESTAMP` for `better-sqlite3` compatibility
- Hub customer search card max width capped

---

## [2026.2.1] - 2026-03-31

### Features
- Windows service installer (`CardosoSetup-vX.Y.Z.exe`) via NSSM
- Auto-updater — polls GitHub Releases hourly, silently installs new versions
- GitHub Actions build — manual trigger only (`workflow_dispatch`)
- GitHub branch protection on `main` — all changes via PR

### Fixes
- SQL connection password encryption/decryption
- `better-sqlite3` / `sqlite3` native binding issues in installer
- Sidebar defaults to expanded on login
- `pt-7` top padding on "Cardoso Cigarettes" heading

---

## [2026.1.x] - 2026-03-30

- Multi-site reporting API (Phase 0 + Phase 3)
- Hub ETL (Phase 4) — aggregates data from sites
- Hub Dashboard — per-site KPIs, flag breakdowns, customer modal with financial fields
- Global admin (`hub_redirect`) — redirect hub users to Head Office URL
- Pagination for reporting endpoint and Hub ETL
