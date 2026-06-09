# Module Extraction Candidates

This note captures small, useful modules that would fit the direction the
codebase is already moving: route files should stay thin, domain logic should
move into testable services, and large UI files should split by workflow.

These are not urgent rewrites. The point is to make the next cleanup or feature
land in a better-shaped place.

## Recommended Order

### 1. `src/services/bat/reconTotals.js`

Move the BAT reconciliation total recompute logic out of `src/routes/system.js`.

Why:
- The logic is business behavior, not route glue.
- Recent work has clustered around `supplier_total`, branch uploads, backfills,
  dry-run/apply maintenance actions, and self-healing totals.
- It can be tested without Sage, OCR, workers, or React.

Likely exports:
- `findReconTotalDrift({ db })`
- `recomputeReconTotals({ db, dryRun })`

Good first extraction:
- Aggregate reconciliation totals from non-exception POD rows.
- Bucket results into matched, mismatched, and skipped-incomplete.
- Keep the route responsible only for auth, audit logging, and HTTP response
  shaping.

### 2. `src/services/bat/parser.js`

Move supplier and Cardoso spreadsheet parsing out of
`src/services/batReconciliation.js`.

Why:
- Parser behavior is already under active maintenance: unknown fee headers,
  supplier totals, `xlsx` hardening, and validation tests.
- The parser is one of the cleanest pieces to isolate because it can be tested
  from files without touching the database, Sage, or OCR.

Likely contents:
- `parseSupplierSpreadsheet`
- `parseCardosoSpreadsheet`
- amount/header normalization helpers
- parser validation error shaping

### 3. `src/services/bat/reconRepository.js`

Create a database-only module for BAT reconciliation reads and writes.

Why:
- `src/services/batReconciliation.js` is carrying parsing, Sage, OCR,
  matching, aggregation, and SQL.
- A repository module gives future service extractions a stable boundary.

Good first contents:
- reconciliation create/update queries
- extraction row insert/update queries
- duplicate invoice index queries
- supplier/Cardoso invoice storage queries

### 4. `src/services/bat/matching.js`

Extract invoice matching, fuzzy matching, duplicate annotation, and match
summary construction.

Why:
- Duplicate detection has recently expanded to cross-reconciliation behavior.
- Matching is a likely future cache/precompute target.
- Pulling it out now makes a later `bat_match_cache` safer and smaller.

Likely contents:
- global duplicate index logic
- fuzzy invoice matching
- attention-count summaries
- per-reconciliation match result shaping

### 5. `src/lib/httpParams.js`

Add small shared helpers for route parameter parsing and error response shape.

Why:
- Routes repeat `parseInt`, boolean flag, CSV list, pagination, and prefix-list
  parsing.
- The existing reconciliation future-work note already calls out
  `parsePositiveInt`.
- This should stay modest; avoid a full error-middleware rewrite until the
  app-wide response contract is deliberately standardized.

Likely exports:
- `parsePositiveInt(value, name)`
- `parseBooleanFlag(value, defaultValue)`
- `parseCsvList(value)`
- `badRequest(res, field, received, message)`

### 6. `src/services/hub/hubHealth.js`

Move hub health and KPI summarization helpers out of `src/routes/hub.js`.

Why:
- Hub work now spans backups, Accpac sync freshness, BAT reconciliation tiles,
  machine health, and missing-week calculations.
- These status summaries are domain rules and should be testable without
  Express.

Good first contents:
- SQL backup health summarization
- machine-health status summarization
- BAT missing-week calculation
- Accpac freshness/status classification

### 7. `src/components/settings/tabs/*`

Split `src/components/settings/SettingsPanel.jsx` by workflow tab.

Why:
- `SettingsPanel.jsx` is now a large coordination file mixing maintenance,
  OCR tools, TLS, hub connection settings, credit logic, users, rules, and
  database connections.
- Splitting by tab reduces merge conflicts and makes feature work less risky.

Suggested files:
- `SettingsMaintenanceTab.jsx`
- `SettingsCreditLogicTab.jsx`
- `SettingsConnectionsTab.jsx`
- `SettingsHubTab.jsx`
- `SettingsOcrTools.jsx`

## First Move

Start with `src/services/bat/reconTotals.js`.

It is small, recent, high-value, and low-risk. It also establishes the pattern
for extracting more BAT logic without touching OCR or Sage yet. After that,
`src/services/bat/parser.js` is the next best module because it pairs naturally
with the existing parser tests.
