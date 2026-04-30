# Cardoso Release Notes — 2026-04-30

A big drop. New **Reports** module, BAT Reconciliation polish, Customer Balances upgrades, faster dashboards, smarter SQL connection isolation, and a top-to-bottom tooltip + toast refresh.

---

## 🌐 Hub Reconciliation (hub-mode only)

A new **Reconciliation** page lives in the hub-mode sidebar, giving central admins a one-screen view of BAT reconciliation health across every connected site.

**What it shows:**
- 5 network-wide tiles: sites reporting (e.g. "3/4 with 1 error"), total BAT, total Credit Notes, total Variance (with matched / mismatch / awaiting breakdown), and total Exceptions.
- A horizontal bar chart of BAT vs. Credit Notes per site so a single bad site stands out.
- A per-site card grid with status badge (Matched / Mismatch / Awaiting / Sync error), BAT / Credit Notes / Variance figures (variance colour-coded), weeks / mismatch / exception counts, last sync time, and a one-click "Open" link to the site.
- A **Refresh now** button that immediately re-runs the cross-site sync.

**How it works under the hood:**
- Each site exposes `GET /api/reporting/bat-summary` (REPORTING_TOKEN-gated) returning a single-row YTD snapshot — total BAT, total Sage credit notes, variance, week counts, exception load, last upload date.
- The hub's existing `syncSite()` job (which already pulls customer records and inventory) now also calls each site's bat-summary endpoint and upserts into the new `hub_bat_summary` table. Failures are caught per-site so one failing site doesn't break the whole sync.
- Hub UI calls `GET /api/hub/bat-summary` which joins `hub_bat_summary` with `hub_sites` and computes the network-wide rollup.
- Daily snapshot cadence by default (driven by the existing hub scheduler); the **Refresh now** button calls `POST /api/hub/bat-summary/refresh` to trigger an immediate `syncAllSites()`.

**Auth:** reuses the existing per-site `REPORTING_TOKEN` env var — no new credentials to manage.

---

## ✨ Headline: Reports module

A brand-new **Reports** page (admin-only) now lives in the left sidebar. Each report has filters, summary tiles, professional charts, a printable A4 layout, and CSV export.

**Reports shipped:**

| Group | Report | What it shows |
|---|---|---|
| Accounts Receivable | **Aged Debtors** | Customers with outstanding balances, bucketed by oldest unpaid invoice. Filter by sales rep, account type, site, min balance. |
| Accounts Receivable | **Sales Rep Exposure** | Total outstanding per rep, flag mix (red / orange / green), expand any rep to see their top 10 risk customers. |
| BAT Reconciliation | **Weekly Reconciliation** | BAT vs. Credit Notes per week with variance, OCR coverage, exception load. Year selector. |
| BAT Reconciliation | **YTD Fee Breakdown** | Discount / Delivery / Pricing for the year — BAT vs. Sage, variance % per fee type. |
| BAT Reconciliation | **Exceptions Summary** | Total flagged value & count, top reasons, top stores by exception value. |
| Inventory | **Value & Composition** | Total inventory value, donut by commodity, top-N items by value. |

**Print layout is professional**: branded header (title, period, active filters, generated-by stamp), summary tiles, sectioned tables with alternating-row striping, page-break-friendly rows, fixed footer with timestamp on every page. A4 landscape or portrait per report.

**Charts have proper axes** — currency-formatted Y-axis (`R 1.2M`), labelled X-axis, themed dark tooltip with Cardoso phosphor accent, legend, hover cursor highlight.

---

## 📊 BAT Reconciliation

- **Exceptions widget** on the Reconciliations tab — shows the rand total + count of every flagged invoice across all weeks, with a breakdown by reason. Reasons are normalised so case / word-order variants ("Incorrect Delivery Status/Quantity" vs "Incorrect delivery status/Incorrect quantity") merge into one line.
- **Weekly cards** now show "Awaiting Credit Notes" badge for weeks where BAT data exists but Sage hasn't posted yet.
- **"Hide matched" filter** on the Reconciliations tab (default on) — hides perfectly-balanced weeks so attention stays on the work that's left.
- **Resizable column widths** on the per-week invoice register table. Drag the right edge of any header to resize, double-click to reset. Widths persist per browser.
- **Tooltips everywhere** — every column header, status badge, RAG indicator, and dashboard tile now has a styled tooltip explaining what it means.
- **Renamed for clarity**: "Supplier" → "BAT" and "Sage" → "Credit Notes" in user-facing labels (column headers, tile labels, tab labels).
- **OCR pause switch** — Settings → Reconciliation now has a "Pause OCR" toggle. Stops the worker after the in-flight invoice finishes; survives server restart. Pending invoice count shown alongside.
- **Exception column header expanded matcher** — the parser now picks up any column whose header contains both "Exception" and "Reason" (covers "Cardoso Exceptions Reasons", "Exceptions Reasons", "Exception Reason", etc.). Re-upload a week to back-fill its reasons.
- **ISO 8601 week numbering fix** — "current week" now uses the ISO 8601 algorithm. The previous naive `dayOfYear / 7` math was off by one day in some weeks (the 28→29 April 2026 mid-week rollover would not happen any more). Edge case in late Dec / early Jan also handled.

---

## 💰 Customer Balances

- **Aging filter rewritten** — "All / 7-13 / 14-20 / 21+" buckets now match a customer if **any** of their unpaid invoices falls in that range (previously only the customer's oldest invoice was considered, which made the 7-13 bucket effectively empty).
- **Filter now applies across the entire dataset**, not just the current page of 50. Pagination works correctly under filters.
- **Sales rep filter** added next to the existing site filter, populated from the full record set.
- **Sort by Customer ID** — click the column header to sort numerically.
- **Resizable columns** with drag handles on every column header. Double-click to reset.
- **Account type pill** moved before the customer name (was on the right, now on the left for cleaner scanning).

---

## 🔌 SQL connection isolation

The BAT Sage SQL connection used to bleed into the customer-search sync cycle (the scheduler pulled all active connections into the local `datarecord` table). Now there's a clean separation:

- New **"BAT-only"** checkbox on each connection in the Connections page.
- Marked connections are skipped by the sync scheduler, the auto-sync interval, AND a manual "Import" button — defence in depth.
- The migration auto-marks any connection currently pinned via `bat_settings.sage_connection_id`, so existing setups got the fix on the first restart.
- Customer Search no longer offers BAT-only connections in its connection picker / status banner.

---

## ⚡ Performance

The Reconciliations tab (and any page using `getDashboardData` / `listReconciliations`) was loading in 3–5 seconds. After this release it loads in under 100 ms.

Root cause: SQL `EXISTS` subqueries with `UPPER(REPLACE(invoice_number, ' ', ''))` — that string-normalisation can't use any index, so SQLite scanned the full Cardoso invoice table for every extraction row. Replaced with a one-shot JS `Set/Map` lookup.

| Endpoint | Before | After |
|---|---|---|
| `/api/bat/dashboard` | 1.5–1.7 s | ~12 ms |
| `/api/bat/reconciliations` | ~700 ms | ~10 ms |

The big `/api/bat/cardoso-match` query (the cross-reference fuzzy matcher) is also no longer fired on initial Reconciliations page load — it now lazy-loads only when you open the cross-reference sub-tab.

`[bat-perf]` log lines remain in place so future regressions are easy to spot.

### Second pass (this release)

A follow-up audit surfaced three more wins:

- **Cardoso lookup cached** — `buildCardosoLookup()` (used by `listReconciliations`, `getDashboardData`, and `buildExtractionStats`) is now memoised with a 60s safety TTL. It's invalidated on every Cardoso write path (upload, generate-from-Sage, replicate). Saves a full Cardoso table scan + JS normalisation on every dashboard poll.
- **`buildExtractionStats` rewritten** — the per-week detail view used to fire two more correlated `EXISTS` subqueries with non-sargable `UPPER(REPLACE(...))` to compute matched / exact-matched. Now uses the same JS lookup map. Per-week page should feel instant.
- **Sage week-totals memoised in memory** — the dashboard / week-status endpoints poll `getCachedSageWeekTotals()` every few seconds; previously each poll hit SQLite. Now served from a module-level cache, invalidated only on `refreshSageWeekTotalsCache()`.

Other items from the audit (OCR worker pool, push-based extraction status updates, code-splitting Recharts, collections column normalisation) are noted for later — none of them blocking, all worth doing in a maintenance pass.

### Third pass (this release)

All four medium-impact items from the audit shipped:

- **Recharts code-split.** Recharts is now a separate `vendor-charts` chunk, and the `PaymentHistoryCharts` component used inside `CustomerLookup` is `React.lazy`-loaded. Pages that don't render charts (Customer Search, Records, Connections, etc.) no longer pay the ~100 KB Recharts download / parse cost on initial load.
- **Numeric balance column.** New `outstanding_balance_num REAL` column on `datarecord` and `hub_records`, indexed, auto-maintained via SQLite triggers (no app-code changes in the sync engine). `/api/top-balances`, `/api/reports/aged-debtors`, `/api/reports/rep-exposure` and the Collections route all switched to it. Index can now be used for `WHERE > ?` and `ORDER BY DESC` instead of casting `outstanding_balance` text → number on every row.
- **Push-based extraction status.** New `GET /api/bat/extraction-status-stream/:id` SSE endpoint. The OCR worker emits an event after every invoice processed and at completion; the browser opens an `EventSource` for instant updates. Polling endpoint kept as automatic fallback if SSE fails. Eliminates the every-2-second poll cycle for the per-week detail view.
- **OCR worker pool.** Replaces the single sequential Tesseract worker with a configurable pool (default 4 lanes, override with `OCR_CONCURRENCY` env var). Each lane owns its own Tesseract worker, with crash recovery per lane. In-memory in-flight Set prevents lanes double-claiming. Set `OCR_CONCURRENCY=1` to revert to sequential behaviour. Effective when OCR is resumed — currently still paused.

---

## 🎨 Visual polish

### Tooltips
Every existing tooltip in the codebase now uses a Cardoso terminal-style design: dark card background, 2px phosphor amber border-left, soft amber-tinted shadow, sharp 2px corners, smooth slide-in animation. No new dependencies — just a single restyle of the shared `<TooltipContent>` component, so every existing tooltip in the app inherits the new look automatically.

### Toasts
The Sonner toast notifications are now properly themed. Each type (success / error / warning / info) gets its own deep-tinted background and matching border-left in the corresponding RAG colour, mono-font headings, uppercase tracked descriptions, soft phosphor glow, and a subtle backdrop blur. Type colours: green for success, red for error, phosphor for warning, cyan for info.

### Sidebar
- New **Reports** entry in the left navigation with a custom multi-coloured bar-chart icon (no generic Lucide grey).
- Reconciliation icon got a more legible phosphor-pulse-through-ledger refresh earlier in the sprint.

---

## 🔧 Connections

- New `databaseconnection.is_bat_only` column (default 0). Settable via the Connections form.
- Manual `runConnectionImport` refuses BAT-only connections with a clear error message.

---

## Database

| Migration | Name | Effect |
|---|---|---|
| v44 | `bat_sage_week_cache` | Local cache of Sage week totals for offline dashboards. |
| v45 | `bat_reconciliation_perf_indexes` | Two new indexes — `bat_cardoso_invoices(c_overwritten)` and partial `bat_invoice_extractions(extracted_invoice)`. |
| v46 | `databaseconnection_is_bat_only` | New column + auto-flags the existing BAT Sage connection. |
| v47 | `datarecord_outstanding_balance_num` | New REAL column on `datarecord` + `hub_records`, indexed, auto-maintained via triggers. Lets balance sorts/filters use an index instead of casting on every row. |
| v48 | `hub_bat_summary` | New per-site BAT reconciliation snapshot table (PK `site_id`), populated by the daily hub puller. Backs the new Hub Reconciliation page. |

---

## Known limitations / next up

- **Aged Debtors 7-13 bucket may still look light** — even under the new "any" semantics, some of your customer accounts have only old debt, so newer-bucket views can have small counts. That's data, not bug.
- **Reports CSV exports** are basic — no column headers reformatting / no Excel formula injection guard. Open in any spreadsheet, won't blow up, no flair.
- **Print** uses the browser's print dialog (File → Print → Save as PDF works well). For batch PDF export I'd add jsPDF / Puppeteer in a future drop.
- **Cross-reference table** lazy-loads on tab open — the heavy fuzzy match is intentionally deferred.

---

## Behind the scenes

- All BAT-module performance traced via `[bat-perf]` log lines — keep them on for now to catch regressions.
- A second performance audit pass was run today; results are in a separate engineering note.
- Server restarts: most changes hot-reload through Vite. The schema migration (v46) and any backend route additions need a single `node server.js` restart.

Have a good test — ping me with anything that doesn't behave as advertised.

---

## 🧪 Suggested test plan for the morning

Quick run-through (~15 min):

1. **Sidebar** → click the new **Reports** entry. Cycle through all 6 reports.
2. For **Aged Debtors**: pick a sales rep, change the min balance, **Print Preview** (Ctrl+P) — confirm landscape A4 with header + summary + table + footer.
3. For **Sales Rep Exposure**: click a rep row to expand top customers.
4. For **BAT Weekly**: switch year, hover the variance line chart, **Print Preview**.
5. For **BAT YTD**: switch year, check the bar comparison.
6. For **BAT Exceptions**: switch year filter to "All".
7. For **Inventory Value**: switch top-N (10 → 100).
8. **Customer Balances** → set Aging filter to "7-13 days" and "21+ days" — confirm each shows different sets, page count updates correctly.
9. **Customer Balances** → pick a sales rep from the new dropdown.
10. **Customer Balances** → drag the right edge of the **Customer Name** header to resize.
11. **Settings → Reconciliation** → click **Resume OCR** if you want OCR running again, otherwise leave paused.
12. **Trigger any toast** (try a failed action) → confirm it has the new tinted look.

Report endpoints all responding `401` to unauthenticated curl (= registered + gated correctly). Vite is hot-reloading all frontend changes; the Express server has been restarted so all new routes / migrations are live.
