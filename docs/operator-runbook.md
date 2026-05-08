# Cardoso operator's runbook

This is the full end-to-end guide for operators, support staff, credit controllers, auditors, and engineers who use or maintain Cardoso. It assumes no prior knowledge of the codebase — only that you have a Cardoso install in front of you and questions about what it does, how it does it, and what to do when something looks wrong.

It is written in plain English. Where a specific number, file, or flag matters, it is named directly. Where the system has a small visual quirk that operators encounter (a red underline, an amber border, a disabled button), the cause and the meaning are explained.

If you only have time for two sections: read **What Cardoso is** and **The disable button pattern** — they cover most "what is this thing and how do I stop it doing something dumb" questions.

For any specific feature, search this document for the section heading. The **Where to find things** section near the end is a UI-to-section map.

---

## Contents

1. [What Cardoso is](#what-cardoso-is)
2. [Site mode vs hub mode](#site-mode-vs-hub-mode)
3. [The shape of the data](#the-shape-of-the-data)
4. [Logging in](#logging-in)
5. [The five things most operators do](#the-five-things-most-operators-do)
6. [Customer Management (Customer Search)](#customer-management-customer-search)
7. [Customer Balances](#customer-balances)
8. [Collections](#collections)
9. [Inventory](#inventory)
10. [Records](#records)
11. [Reports](#reports)
12. [Reconciliation (BAT)](#reconciliation-bat)
13. [The OCR pipeline (BAT)](#the-ocr-pipeline-bat)
14. [Why an invoice number gets a red underline](#why-an-invoice-number-gets-a-red-underline)
15. [Hub Dashboard](#hub-dashboard)
16. [Hub Metrics, Trends, Audit Log, Reconciliation, Backups](#hub-metrics-trends-audit-log-reconciliation-backups)
17. [Operations page](#operations-page)
18. [Settings panel](#settings-panel)
19. [Auto-flag rules](#auto-flag-rules)
20. [Credit logic versioning](#credit-logic-versioning)
21. [Connections to Sage / Accpac](#connections-to-sage--accpac)
22. [The sync engine: how Accpac data flows in](#the-sync-engine-how-accpac-data-flows-in)
23. [Auth, sessions, hub redirect](#auth-sessions-hub-redirect)
24. [Permissions matrix](#permissions-matrix)
25. [Backups: local, integrity check, hub-pulled](#backups-local-integrity-check-hub-pulled)
26. [Alerts engine](#alerts-engine)
27. [Security signals](#security-signals)
28. [Auto-update flow](#auto-update-flow)
29. [TLS, Caddy, Tailscale](#tls-caddy-tailscale)
30. [Hub URL self-heal](#hub-url-self-heal)
31. [Hub site orphans](#hub-site-orphans)
32. [The Accpac on-hold module (preview)](#the-accpac-on-hold-module-preview)
33. [Visual cues — what every colour, badge, and pill means](#visual-cues--what-every-colour-badge-and-pill-means)
34. [The disable button pattern](#the-disable-button-pattern)
35. [Common operator tasks](#common-operator-tasks)
36. [Troubleshooting](#troubleshooting)
37. [Where to find things](#where-to-find-things)
38. [Environment variables reference](#environment-variables-reference)
39. [Recent changes worth knowing](#recent-changes-worth-knowing)
40. [Glossary](#glossary)
41. [Where to escalate](#where-to-escalate)

---

## What Cardoso is

Cardoso is a customer-management overlay that sits on top of Sage 300 / Accpac (the accounting system) and gives non-accountants a faster, friendlier view of customers. It's used at branch sites and at head office. It does five main things:

- **Customer Search.** Type any part of a customer's name, code, phone number, or invoice number and find them. Live, against the Accpac SQL Server.
- **Flag customers.** Operators can mark a customer red, orange, or green. The flag is just a visual signal — Cardoso never used to write back to Accpac. (See **The Accpac on-hold module** for the upcoming change.)
- **Apply rules automatically.** Configurable auto-flag rules can say things like "if a customer has more than R 10 000 outstanding for over 30 days, flag red." The rules run on every sync.
- **Reconcile invoices (BAT module).** A specific workflow where the BAT supplier sends a weekly spreadsheet with delivery info; Cardoso OCRs the linked PDFs, matches them to Sage credit notes, and surfaces variance.
- **Aggregate across sites (hub mode).** A central head-office install pulls KPIs and records from every branch site so management can see the estate at a glance.

Cardoso has historically been **read-only against Accpac**. It pulls data in, lets operators do things in its own database, but never writes back. The new "on-hold" module is the first deliberate exception to that, and it has a separate guide ([cardoso-accpac-hold-guide.md](cardoso-accpac-hold-guide.md)).

It runs as a Windows service, with a web UI accessed via a browser. Per-site installs use HTTP on the LAN; the head-office hub uses HTTPS via Caddy + Tailscale.

---

## Site mode vs hub mode

A Cardoso install runs in one of two modes. You set the mode by setting the `HUB_MODE` environment variable to `true` (hub) or leaving it unset / `false` (site).

| | Site | Hub |
|---|---|---|
| **Where** | Each branch / store | Head office |
| **Talks to** | Its own Accpac instance | Each site, over Tailscale |
| **Has a customer DB** | Yes (its `datarecord` table is mirrored from Accpac) | Yes (its `hub_records` table is rolled up from sites) |
| **OCR / BAT recon** | Yes | No (recon happens at sites; the hub aggregates) |
| **Backups** | Makes its own; the hub also pulls them | Pulls from sites; not really backed up itself |
| **Default landing page** | Customer Search | Hub Dashboard |
| **Settings tabs visible** | Connections, Audit Log, TLS, Maintenance, Reconciliation, Updates | TLS, Sync Log, Hub Maintenance, Network, Updates |
| **Operations tabs visible** | Job Runs, System Log, Security, Updates | Job Runs, System Log, Security, Updates, Hub Sync Log |
| **Pages visible** | most non-hub pages | Hub Dashboard, Hub Metrics, Hub Trends, Hub Audit Log, Hub Backups, Hub Reconciliation, plus a few shared like Inventory + Network Devices |

A user with the `hub_redirect` flag set who logs in at a site is silently bounced to the hub via a 5-minute JWT — they never see the site UI. This is how head-office staff get to the right view automatically.

**Important rule of thumb:** site-mode features that talk to Accpac live; hub-mode features look at cached aggregated data. The hub is always at least 5 minutes behind reality (the hub-pull cadence); a site is real-time-ish.

---

## The shape of the data

Three databases at any site:

- **Accpac / Sage 300** (Microsoft SQL Server, owned by Sage). Cardoso reads from it. Tables of interest: `ARCUS` (customers), `AROBL` (open invoices), `ARTCR` / `APIBC` / `APIBH` / `APIBD` (transactions), and a few others. Cardoso's read pool (`customerSqlPool`) is wired with `SELECT`-only privileges.
- **Cardoso's own SQLite database** (file: `database/cardoso.db`). This holds the local mirror of customer data (`datarecord`), users, sessions, audit log, error log, BAT reconciliation tables, etc.
- **Sessions DB** (file: `database/sessions.db`). Separate so a session-table corruption can't take the main DB offline.

On the hub, add:

- **Aggregated data** in the same Cardoso DB but in `hub_*` tables: `hub_records`, `hub_inventory`, `hub_sites`, `hub_sync_log`, `hub_backup_integrity`, `hub_bat_summary`, `hub_settings`.

The data flow:

```
Accpac (SQL Server)
   │
   │  every 30 min weekday 06:00–17:00 (the "scheduled-sync" job)
   ▼
datarecord (site SQLite)            ←  flagging + auto-flag rules apply here
   │
   │  every 5 min (the "hub-sync" job, hub side)
   ▼
hub_records (hub SQLite)            ←  hub dashboard reads from here
```

Backups follow a similar shape: each site backs itself up nightly at 02:00, the hub pulls all sites' backups at 03:00.

---

## Logging in

Open the Cardoso URL in a browser. You land on the login page.

Type your email + password. Three things can happen:

1. **You log in normally.** Land on Customer Search (site) or Hub Dashboard (hub).
2. **First-login forced password change.** If your account was just created (or an admin reset it), the system rejects the original credentials and asks you to set a new password before continuing. Minimum 8 characters, hashed with bcrypt(12). After this, log in normally with the new password.
3. **Hub redirect.** If your account has the `hub_redirect` flag set (head-office staff with site logins), the site silently generates a JWT, destroys the local session, and redirects you to `<hub>/api/auth/hub-token-login?token=...`. You appear at the hub already logged in. Token is valid for 5 minutes.

Sessions are server-side, stored in `sessions.db`. They expire after 12 hours. Logout clears the cookie. The cookie is `httpOnly`, `secure: true` if `HTTPS=true`, `sameSite: strict`.

If something goes wrong during login the System Log will record which step failed (`phase=lookup` / `verify` / `session` / `hub_redirect`). That makes the difference between "wrong password," "DB locked," and "session store failed" obvious in triage.

The login page has a rate limiter (`loginLimiter` middleware). Repeated bad attempts get HTTP 429 — that counts toward security signals (see **Security signals**).

---

## The five things most operators do

Most days, an operator doesn't go past these:

1. **Search for a customer.** Customer Search page. Type, click, view balances + invoices + flag history.
2. **Flag a customer (manually).** From the customer popup, click red / orange / green, optionally with a reason. Audit-logged with your email.
3. **Look at the dashboard / customer balances.** See aging, see who's red, sort by outstanding.
4. **Run reconciliation (BAT operators only).** Upload the weekly BAT supplier spreadsheet, watch the OCR run, approve matches, look at variance.
5. **Sync.** If a connection's data looks stale, hit "Sync All" or "Sync this connection" in Settings → Connections. Most of the time, the scheduler handles it.

Anything beyond these is documented in the relevant section below.

---

## Customer Management (Customer Search)

The default landing page on a site (`pages.config.js` sets `mainPage: "CustomerSearch"`).

**What it shows.** A search bar at the top, a results list below. Type any part of a customer's identity or transaction history — name, account code, contact, phone, invoice number, amount — and the page queries Accpac live for matches. The list shows customer code, name, balance, last activity.

**Click a result** and a popup opens with the full customer view: open invoices, recent receipts, contact details, current flag colour, flag history, and a panel for setting / clearing flags.

**Live or cached?** Customer Search hits Accpac SQL Server live for every search. That's why it can take a second or two on a slow connection — it's not searching the local mirror. The live read happens through the connection pinned to role `customer_lookup` (or, falling back, the first active non-BAT-only `databaseconnection` row). See **Connections to Sage / Accpac**.

**The flag panel inside the popup.** Three buttons (red / orange / green) plus a "Clear flag" option. Clicking sets `datarecord.flag_color` to the chosen colour and writes a row to the audit log with the operator's email. Manual flags set `flag_source = NULL` so auto-flag rules know not to overwrite them. (Auto-flag rules respect human flags — see **Auto-flag rules**.)

**Visual cues to know:**

- **Red border** around the customer card → they have an active red flag. Critical attention required.
- **Amber border** → orange flag. Review needed.
- **Green border** → green flag. Approved / cleared.
- **No border** → no flag.
- **A small icon next to the flag colour** indicating the flag source: a person silhouette = manual; a lightning bolt = auto-flag rule. Hover for the flag's reason / rule name.

---

## Customer Balances

A summary table of every customer's outstanding position. Columns: customer code, customer name, total balance, age buckets (current, 7, 14, 21, 30, 60, 90+), terms, sales rep, account type, last unpaid invoice, last receipt.

**Where the data comes from.** This is the local mirror (`datarecord`), refreshed by the scheduled sync. It is not live — it's whatever the last sync pulled.

**Sort, filter, search.** All standard table operations. The table is heavy — uses TanStack virtualized rows. Filtering by flag colour at the top narrows quickly.

**Why a row might be missing.** Either (a) the customer hasn't been pulled in yet because the sync mapping doesn't include them, (b) the sync hasn't run since they were created in Accpac, or (c) they're filtered out by your column filters. "Sync now" in Settings → Connections forces a refresh.

**The flag colour dot.** Same colour scheme as Customer Search. Click any row to open the same customer popup.

---

## Collections

A workflow page for collections officers. Lists customers eligible for collection action, lets you record contact attempts, payment promises, and outcomes.

**Where the data comes from.** Local mirror, plus collection-specific tables.

**Permission gate.** `can_access_collections` (default 1). Site-only.

**The "call list."** Auto-generated based on aging + flag colour. You work top-to-bottom. Each entry records: who called, when, outcome (paid / promise / no-answer / dispute / etc.), follow-up date if applicable.

**Why a customer might appear here even though they paid recently.** Aging data is from the last sync. If they paid this morning and the sync hasn't run since, they'll still show as overdue. Force a sync if it matters.

---

## Inventory

A list of inventory items pulled from Accpac. Item code, description, quantity on hand, last cost, price list, current price, stocking unit, commodity code.

**Site mode.** Reads from the local `inventoryrecord` table, populated by the connection sync.

**Hub mode.** Reads from `hub_inventory` (aggregated across sites). Has a site-id column so you can filter to a specific store.

**Permission gate.** `can_access_inventory` (default 1). Both modes.

**Refresh cadence.** Updated whenever the connection sync runs (every 30 min on weekdays). Hub aggregation runs every 5 minutes against each site.

---

## Records

A direct view of the local `datarecord` table. Mostly used for diagnostics — when you want to see exactly what Cardoso has stored about a customer, in raw form.

**Permission gate.** `can_access_records` (default 0 — admins set this manually). Not normally visible.

**What it shows.** Every column in `datarecord`: customer code, name, age buckets, balance, flags, source connection, last synced timestamp, etc. Useful for "is this customer's data up to date?" questions and for verifying that a connection's field mapping is producing the expected output.

---

## Reports

A generic reporting surface. Custom reports can be defined for specific business questions (top 20 outstanding, write-off candidates, etc.).

**Permission gate.** `can_access_reports` (default 0).

**Where to add new reports.** They're typically defined as React components under `src/components/reports/`. Adding a new one is an engineering task, not an operator task.

---

## Reconciliation (BAT)

The biggest module after Customer Management. Site-only, admin-tagged for most controls.

**Why it exists.** Each week the BAT supplier issues a credit/invoice spreadsheet for that week's POD-delivered orders. The spreadsheet has order numbers, store names, fees, and links to the proof-of-delivery PDFs. The reconciliation team has to:

1. Confirm every PDF can be linked back to a Cardoso invoice.
2. Cross-check Sage credit notes against the spreadsheet.
3. Flag any invoice where the supplier's numbers disagree with Cardoso's or Sage's.

Doing this by hand for hundreds of PODs every week is impossible. The module automates the matching step.

**The page.** `Reconciliation` (left sidebar, site-only, gated by `can_access_reconciliation`). Top of the page has a list of weekly reconciliation runs (year + week number). Click a row to open it.

**A reconciliation run** is one row in `bat_reconciliations` covering one (year, week) pair. Each run has:

- A supplier upload (the BAT spreadsheet).
- A list of POD extractions (one per PDF, in `bat_invoice_extractions`).
- A list of Sage credit notes (`bat_sage_credit_notes`, snapshot per recon).
- A list of Cardoso invoices (`bat_cardoso_invoices`).
- Variance / status summary at the top.

**Phases of a run:**

1. **Upload spreadsheet.** Operator drops the BAT XLSX. The server parses it into `bat_invoice_extractions` rows, status `pending`.
2. **OCR runs.** A worker thread processes each PDF in parallel (up to `OCR_CONCURRENCY` lanes, default 2). For each extraction the status moves through `pending → in_progress → found` (with `extracted_invoice` set), `not_found` (OCR succeeded but no invoice number could be extracted), or `failed` (OCR pipeline itself errored).
3. **Match.** Found extractions are matched to Sage credit notes (by `WEEK NN` description and amount) and to Cardoso invoices (by IN-prefix invoice number). The status field `match_status` records the outcome.
4. **Variance.** Per-fee-type (delivery / discount / pricing) totals are computed and compared. Mismatches surface in the Variance tab.
5. **Operator review.** Operator can edit any extraction's `extracted_invoice` manually if the OCR got it wrong, run "Replicate Supplier" (admin-gated) to rewrite Cardoso pricing/discount values from the supplier's numbers, etc.

**Tabs inside a recon page** (the exact set evolves):

- **Overview** — top-line totals, counts, status badges.
- **Extractions** — POD list with OCR status, extracted invoice, preview of the OCR'd PDF.
- **Sage** — credit-note snapshot for that week.
- **Cardoso** — Cardoso's invoice rows for that week.
- **Variance** — fee-type totals + mismatches highlighted.

**Important controls in Settings → Reconciliation:**

- **OCR API keys** (Google Vision, ocr.space). Stored encrypted in `bat_settings`.
- **Invoice number format** — picks 8 vs 9 digits (`invoice_in_digit_length`). New sites onboarded with shorter Sage invoice numbers set this to 8 to prevent OCR-recovered numbers being padded to non-existent invoices. See PR #186 in the changelog.
- **OCR pause toggle.** Halts the OCR queue without losing in-flight work. Useful when re-running an OCR pipeline change. Persists across restarts (stored in `bat_settings.ocr_paused`). When paused, the dashboard tile shows a paused state and the worker won't auto-resume on boot.
- **Reset failed extractions.** Re-queues `not_found` and `failed` extractions back to `pending` so they OCR again on the next pass.
- **Replicate Supplier (admin password required).** Overwrites Cardoso pricing/discount values with the supplier's numbers. Idempotent (`c_overwritten` flag on `bat_cardoso_invoices` prevents double application). Used when the supplier and Cardoso disagree and the supplier is correct.

**Sage health banner.** A red banner across the top when the Sage MSSQL probe has failed for ≥5 minutes. The probe runs every 60 seconds. The banner clears the moment Sage is reachable again.

---

## The OCR pipeline (BAT)

This is where most operator confusion comes from, so it gets a section of its own.

**The job.** Take a PDF (the BAT proof-of-delivery), pull text out of it, extract the IN-prefix invoice number printed on the document.

**Why multiple engines.** No single OCR engine reads every PDF reliably. Different engines have different strengths. The pipeline tries them in order until one finds a valid invoice number.

**The cascade order:**

1. **Google Vision** — best accuracy, requires an API key, costs money per call.
2. **ocr.space E1** — free tier first, then paid.
3. **ocr.space E3** — different ocr.space engine, slightly different accuracy profile.
4. **Tesseract** — local, free, slower. The trained data ships with Cardoso under `vendor/tessdata/eng.traineddata.gz`. PR #190 fixed the build pipeline to actually include this file (it was missing from earlier installer builds — every site was silently using Google Vision + ocr.space only).
5. **ocr.space E2** — last resort.

For each engine, the worker tries the PDF at rotation 0° and 90° before moving on. If no engine produces a recognisable invoice number, the extraction is marked `not_found`.

**Concurrency.** The OCR worker runs in a Node `worker_thread` so the main API stays responsive. `OCR_CONCURRENCY` env var controls parallelism (default 2; max 16). On a Windows site with a quad-core CPU and Tesseract being CPU-bound, 2 lanes is the sweet spot.

**What the OCR pipeline returns.** A string that should look like `IN000123456` (or `IN00123456` if the site uses 8-digit invoices). The exact pattern depends on the site's `invoice_in_digit_length` setting.

**The regex.** The OCR result is then validated by a regex pattern. Currently:

- 9-digit format: `IN` followed by 6 to 9 digits with up to 3 leading zeros.
- 8-digit format: `IN` followed by 6 to 8 digits with up to 2 leading zeros.

If the OCR text contains *something that looks like* `IN<digits>` but doesn't match this pattern (e.g. `IN12` is too short, or `IN1234567890` is too long), the extraction is marked `not_found` and the regex match fails.

---

## Why an invoice number gets a red underline

This is the small UI cue that most prompts the question "what does that mean?"

In the Extractions table, each row's invoice number column is a small editable text field. The field has a thin border at the bottom — its **underline**.

The underline colour means:

- **No underline / muted grey** — the field is empty or hasn't been processed yet (`pending`).
- **Green underline** — the OCR found a valid invoice number that matches the expected pattern AND it found a corresponding row in Sage / Cardoso.
- **Amber / yellow underline** — the OCR found a number, but matching is partial or unconfirmed.
- **Red underline** — one of two things:
  1. **The OCR got a number, but it doesn't match the expected pattern** (e.g. `IN1234` — too few digits — or `IN12345ABC` — non-numeric — or just garbage). The regex rejects it.
  2. **A pattern-valid number was extracted but doesn't match anything in Sage or Cardoso.** Could be an OCR error (one digit wrong), could be a genuinely new invoice not yet in either system, could be a customer-on-the-spreadsheet-but-not-in-Sage situation.

When you see a red underline, the operator's job is:

1. Click the field to open the manual edit input.
2. Open the PDF preview (link button next to the field).
3. Read the actual invoice number on the PDF.
4. Type it correctly into the field.
5. Press Enter or click outside to save.

Manual edits set the extraction's status to `manual` and trigger the matching logic against Sage / Cardoso again. If the new number matches, the underline goes green.

**Why the system doesn't auto-correct.** Because if it could, OCR would have got it right. Red underline = "human, please look."

---

## Hub Dashboard

The default landing page on a hub install. Shows tiles for each site.

**What each tile shows:**

- Site name and online/offline status.
- Total record count.
- Critical (red) / Attention (orange) / Approved (green) flag counts. Each is clickable; opens a drill-down modal listing the customers in that flag colour at that site.
- Last hub pull timestamp ("when did the hub last pull from this site").
- Last Accpac sync timestamp ("when did the site itself last refresh from Accpac"). This is the one operators care most about — it's the "is the data actually current?" answer. Distinct from hub-pull, which can look fresh while the underlying data is stale. See PR #198 in the changelog.

**Tile colour cues:**

- **Phosphor (orange) hover border** — normal tile.
- **Amber border** — site is orphan (its id is no longer in the `HUB_SITES` env). See **Hub site orphans**.
- **Red bottom-stripe glow** — site is offline (last ping failed).
- **Green bottom-stripe glow** — site is online.

**Buttons on each tile:**

- **Resync** (top right, small icon) — forces a fresh hub-pull from that site. Clicking it wipes the cached data for the site and re-pulls everything. Can take 30–60 seconds for a busy site.
- **Sync from Accpac** (next to Resync, after PR #198 lands) — asks the site to re-pull from its own Accpac immediately, then chains a hub re-pull. Catches "the site's scheduled sync hasn't run, nobody noticed."

**Status pill (left side, prominent)** — shows ONLINE / OFFLINE / ORPHAN. After PR #200, ORPHAN replaces ONLINE on tiles whose site is no longer in `HUB_SITES`.

**The two timestamp lines at the bottom of the tile** — "Accpac sync: ..." (when the site last refreshed) and "Hub pull: ..." (when the hub last pulled). Goes amber if either is older than 24h. Goes red if the site reports an Accpac error.

---

## Hub Metrics, Trends, Audit Log, Reconciliation, Backups

Sister pages to the dashboard, each focused on one slice:

- **Hub Metrics** — flag count totals, balance totals, customer counts across the estate. Time-window slider (all / 7 / 30 / 90 days).
- **Hub Trends** — same KPIs as Metrics but over time. Weekly or monthly buckets.
- **Hub Audit Log** — every site's `auditlog` rolled up. Filterable by site, action, user.
- **Hub Reconciliation** — read-only summary of every site's BAT recon status, weeks completed, exceptions outstanding.
- **Hub Backups** — when each site last backed up, integrity-check status, file size. The sidebar **Hub Backups** dot lights up if any site has a missing or corrupt recent backup. PR-era integrity-check feature renames corrupt files with a `.corrupt.db` suffix so the next pull doesn't overwrite them; see **Backups**.

Each is gated by its own permission flag — see **Permissions matrix**.

---

## Operations page

The admin's "what is the system doing" page. Five tabs (six on hub):

- **Job Runs** — every scheduled background job's most recent run. Sortable, with resizable columns (PR #193). For each job: name, schedule, last run, status, duration, last error. Click a row to expand for context JSON.
- **System Log** — the `error_log` table. Filter by source dropdown + window (1h / 24h / 7d / 30d / 90d). Click a row to expand stack + context. Auto-refreshes every 30 seconds.
- **Security** — security signals dashboard. Eight metric cards covering 401 / 403 / 429 / login failures / login throttled / avg latency / upload volume / total requests. Each card has a short operator-language description ("401 = Unauthorized — requests with no/expired/invalid session"). Plus a threshold-alerts list at the bottom.
- **Updates** — version status (current installed, latest available), check button, install button (delta or full). Live phase indicator while installing. Sticky failure banner if last update failed.
- **Hub Sync Log** (hub only) — per-site sync events from `hub_sync_log`. Filter by site, status, time range.

Operations is admin-only. Non-admins don't see the page in the sidebar at all.

---

## Settings panel

Opens as a modal overlay from the gear icon in the sidebar. Tabs across the top.

Tabs change based on mode + permissions:

| Tab | Visible when | What it does |
|---|---|---|
| **Users** | `can_manage_users` | User CRUD — create, edit, delete, set permissions. |
| **Credit Logic** | `can_manage_rules` | Edit / publish / push the credit-scoring config. |
| **Auto-Flag Rules** | always (admin needed for some buttons) | Manage auto-flag rules; apply now; clear all. |
| **Fields** | always | Read-only view of customer + inventory field definitions. |
| **Connections** | site + permission | Manage Accpac/Sage connections. |
| **Audit Log** | site + admin | Two sub-tabs: Activity (auditlog table) and Logins (login_log). |
| **System Log** | admin | Same as Operations → System Log. Mirrored here for convenience. |
| **TLS** | admin | Live TLS / Caddy posture. Hub URL configuration on sites. |
| **Maintenance** | site + admin | Dedupe customers, clear imported SQL data. |
| **Updates** | admin | Same as Operations → Updates. |
| **Sync Log** | hub | Hub sync event list. |
| **Hub Maintenance** | hub + admin | Hub-side dedupe; site management; orphan sites + Forget. |
| **Network** | hub + admin | ntopng integration settings. |
| **Reconciliation** | admin | OCR keys, invoice digit length, OCR pause, reset queue, replicate supplier. |
| **Accounting** | admin | VAT % (default 15). Used by reconciliation variance detection. |

Each tab is documented in its own section below — but most operators only need:

- **Users** to create accounts.
- **Auto-Flag Rules** to configure how customers get flagged automatically.
- **Connections** when something looks stale and you want a manual sync.
- **Reconciliation** to manage OCR keys and the pause toggle.

---

## Auto-flag rules

Auto-flag rules are how Cardoso decides which customers to mark red, orange, or green automatically. The evaluator lives at [src/services/autoFlag.js](src/services/autoFlag.js); the same logic re-runs in the frontend at [src/lib/evalFlagRules.js](src/lib/evalFlagRules.js) so the UI can preview a rule before saving.

A rule has:

- A **name** (free text — what shows up in `flag_reason` as `Auto-flagged: <name>`).
- A **flag colour** (red / orange / green).
- A list of **conditions** joined by AND/OR.
- An **active** flag (inactive rules are skipped).

Each condition is `field` + `condition_type` + `condition_value` (and `condition_value_secondary` for ranges). The fields are the columns of the `datarecord` table — outstanding balance, days overdue, customer status text, terms code, last invoice date, and so on.

Supported condition types:

- **Text:** `contains`, `equals`, `starts_with`, `ends_with` (case-insensitive).
- **Empty:** `is_empty`, `is_not_empty`.
- **Numeric:** `greater_than`, `less_than`, `greater_or_equal`, `less_or_equal`, `range_between`. Numeric parsing strips commas and spaces, so `"R 12 345.67"` reads as `12345.67`. NaN means the condition is false (not an error).
- **Dates:** `date_older_than`, `date_newer_than` (in days from today), `before_date`, `after_date` (against an absolute date). Sage's `YYYYMMDD` integer dates are auto-parsed.

**Critical rule** — the evaluator will **never overwrite a manual flag**. If a record already has `flag_color != 'none'` AND `flag_created_by` is set AND `auto_flagged = 0`, it is skipped. This is why operators sometimes see a customer that "should" be red but isn't — someone manually set them to green at some point.

**When does auto-flag run?**

1. After every Accpac sync per connection (the records freshly imported get evaluated immediately).
2. On demand from Settings → Auto-Flag Rules → "Apply rules now" — this re-runs every active rule against every record.
3. Whenever a rule is saved (you'll see "Applied to N records" in the toast).

**Rule order matters.** Rules are evaluated in the order they appear in the list. The first one that matches wins. Drag the rule rows to reorder. If a "warn orange if balance > 5000" rule is above a "block red if balance > 10000" rule, the orange wins for the 12k customer — usually wrong. Put strictest first.

**Clear all** in the toolbar wipes every auto-flagged row's flag back to `none` (manual flags untouched). Useful before retiring a ruleset.

---

## Credit logic versioning

Credit logic is the YAML-ish JSON config that decides how Cardoso ranks customers — terms multipliers, ageing weight, priority bands, balance bucketing. Lives in `bat_settings` under `credit_logic`. The structure is documented inside Settings → Credit Logic.

The flow has three actions:

- **Save (draft).** Edits sit in your browser until you publish — staging edits do not affect any sync.
- **Publish.** The hub or site bumps `credit_logic_version` (an integer counter) and writes the new config. From this point any new sync uses the published version.
- **Push to sites** (hub only). The hub iterates over `hub_sites` and POSTs the config + version to each site's `/api/credit-logic/sync`. Each site stores it locally and tags every record processed afterwards with that version. Push respects the orphan tombstone — soft-deleted sites are skipped (PR #200).

A site can also **pull** on its own — Settings → Credit Logic → "Pull from hub" — useful after a hub-side fix. The hub URL it pulls from is the `hub_url` row in `bat_settings`, falling back to `HUB_REDIRECT_URL` env. See **Hub URL self-heal** later in this doc.

**Version drift.** The hub dashboard tile shows each site's logic version next to its name. A version older than the hub's = drift; click "Push" or have the site pull. The Hub Maintenance settings tab shows the same data in table form.

**Logic sync status** values stored on `hub_sites`: `never_synced`, `success`, `failed`. With timestamps `logic_last_synced_at` and `logic_status_updated_at`. A failed status with a non-null `logic_last_error` is an operator's first place to look when a push went wrong.

---

## Connections to Sage / Accpac

A "connection" is one configured link to a Sage / Accpac MSSQL database. Sites usually have one. The settings tab is **Connections** (visible only on sites, with `can_manage_connections`).

A connection row has:

- **Name** (free text — shows up everywhere this connection's data appears).
- **Server** (host\\instance, e.g. `CARDOSOCISERVER\\SQLEXPRESS`).
- **Database** (e.g. `BATPLBC`).
- **Auth mode** — `windows` (uses the service account, no password) or `sql` (username + password). Passwords are encrypted at rest with `ENCRYPTION_KEY` from the env.
- **Schedule** — cron-ish, when this connection auto-syncs. Defaults to every 15 min.
- **Active** flag.
- **Last sync timestamp + status + error text.**

The pool is opened lazily by [src/lib/customerSqlPool.js](src/lib/customerSqlPool.js). If a sync errors, the connection row gets `last_status = 'error'` and `last_error` populated; the tile in the UI goes red.

There is also a **separate** Sage pool used only by the BAT module (`getSagePool()` in [src/services/batReconciliation.js](src/services/batReconciliation.js)) — that one reads its config from `bat_settings.sage_connection`. The BAT module needs different credentials because it queries different tables (credit notes, week summaries) that the customer pool doesn't have permission to.

**Test connection** button: pings the SQL server with a `SELECT 1`. Errors are surfaced in plain English via `describeSqlError` ([src/lib/errorDescribe.js](src/lib/errorDescribe.js)) — "login failed for user X", "server not found", "database does not exist", and so on. Don't accept the raw mssql error if a friendlier one is offered.

---

## The sync engine: how Accpac data flows in

The core function is `runConnectionImport()` in [src/services/syncEngine.js](src/services/syncEngine.js). For each active connection, on schedule:

1. Open the SQL pool (or reuse the cached one).
2. Run the customer-listing query (joins ARCUS, AROBL, ARTRN, with optional joined invoice + receipt aggregates depending on settings).
3. For each row, upsert into `datarecord` keyed by `(connection_id, customer_number)`. Existing manual flags are preserved.
4. Run `applyAutoFlagRulesToRecord` against each new/changed record. Update `flag_color` / `flag_reason` / `auto_flagged` accordingly.
5. Update connection's `last_synced_at`, `last_status`, `last_error`. Stamp `last_accpac_synced_at` on `hub_sites` for the local site (PR #198).
6. Log the run to `error_log` if anything failed; success is silent (job_runs entry only).

**What gets pulled:** customer code, name, address, phone, terms, on-hold flag, outstanding balance, ageing buckets (current, 30, 60, 90, 120+), unpaid invoices array, recent receipts, last invoice date, salesperson code, status text. Inventory comes through a different path (see Inventory section).

**Sync cadence:** every 15 minutes by default per connection; settable per connection. A site with one connection averages ~15 sec per sync for ~5000 customers; the bottleneck is the Accpac SQL Server, not Cardoso.

**Hub backup pull** is a separate flow that runs on the hub: it reaches across to each site's `/api/reporting/kpis` and `/api/reporting/records` endpoints and aggregates into `hub_records`. Cadence: every 5 minutes. See **Hub Dashboard** earlier in this doc.

**Site-triggered Accpac sync** (PR #198): the **Sync from Accpac** button on a hub tile POSTs to the site's `/api/hub/trigger-accpac-sync`. The site runs `runConnectionImport` immediately, returns the result, and the hub then immediately re-pulls that one site's records to refresh the tile. If the site sync fails, the error is surfaced inline on the tile and the timestamp doesn't advance.

---

## Auth, sessions, hub redirect

Sessions are server-side, stored in SQLite via `better-sqlite3-session-store`. Cookie name is `cardoso.sid`, signed with `SESSION_SECRET` from env. Sessions live for 30 days idle; touched on every authenticated request.

**Login flow:**

1. POST `/api/auth/login` with username + password.
2. Server verifies bcrypt hash. On success, writes user_id into the session.
3. Login event stamped to `login_log` (success or failure, with IP + user-agent).
4. Failed logins beyond 5 in 10 min trigger the rate limiter — returns 429 for that IP.

**First login** forces a password change. The default password for new users is `DEFAULT_USER_PASSWORD` env (or `Cardoso@2026` if unset). The user is taken to a "set your password" screen and cannot proceed until they choose one.

**Hub redirect.** Users with the `hub_redirect` flag set, when they log in at a site, do not see the site UI. Instead, the server mints a 5-minute JWT (HS256, signed with `JWT_SECRET` env) containing their user_id + a one-time nonce. The frontend redirects them to `${HUB_REDIRECT_URL}/api/auth/hub-token-login?token=...`. The hub verifies the JWT, finds-or-creates the user record with the same email/permissions, and gives them a hub session.

**JWT secret pinning.** `JWT_SECRET` MUST be set on both site and hub to the same value. If they drift, hub redirect breaks with "invalid signature". The setup script at `scripts/install-hub.ps1` writes the same value to both .env files.

**Logout** clears the session cookie + destroys the server session. There is no concept of "log out everywhere" yet — each device's session stands until idle expiry or manual logout.

---

## Permissions matrix

User permissions are boolean flags on the `users` table. Set in Settings → Users → edit. Defaults are off for everything except `is_admin = false`. An admin gets all permissions implicitly.

The current set:

| Permission | What it gates |
|---|---|
| `is_admin` | Operations page, all admin-only actions, master switches, master enable, password-reset for others. |
| `is_super_admin` | Reserved for one user (set via env `SUPER_ADMIN`). Cannot be deleted; can recover everything. |
| `can_manage_users` | Settings → Users tab. |
| `can_manage_rules` | Settings → Auto-Flag Rules + Credit Logic. |
| `can_manage_connections` | Settings → Connections tab. |
| `can_view_audit` | Settings → Audit Log tab. |
| `can_run_recon` | Reconciliation page (BAT). Recon is hidden in the sidebar without this. |
| `can_manage_recon` | OCR keys, pause toggle, supplier replicate. |
| `hub_redirect` | Forces silent redirect to hub on site login. Used by head-office staff. |
| `can_release_holds` | (preview, see Accpac on-hold module) — propose holds back to Accpac. |

Permissions are checked in two places: middleware on the API route (returns 403 if missing) AND the frontend hides the link/button. The middleware is authoritative — UI hiding is convenience only.

---

## Backups: local, integrity check, hub-pulled

Three backup mechanisms, three different purposes.

**Local backup** runs on every site once a day at 03:00 (cron schedule fixed). Path: `backups/cardoso-YYYY-MM-DD.sqlite.gz`. Keeps the last 14 days; older files deleted in the same run. Implemented in [src/services/backupRunner.js](src/services/backupRunner.js).

**Backup integrity check** (`backup-verify` job, daily 03:30) opens the most recent backup, runs `PRAGMA integrity_check`, counts a few key tables, and confirms record counts are sane. If any check fails the run is logged with `status='failed'` and the alert engine fires `backup-verify-failed` (see Alerts engine). PR #178 introduced this — the success-check pattern means the job is "soft-failable" without crashing.

**Hub backup pull** — the hub once an hour pulls each site's most-recent backup file via `/api/hub/site-backup-download` and stores it under `backups/sites/<slug>/`. Why: head office wants every site's data even if a branch's hardware dies. The Hub Backups page (hub mode only) lists the most-recent pull per site, file size, age. A red age column ≥ 24h means the pull is stuck — check Hub Sync Log for the error.

**To restore:** stop the service, replace `data/cardoso.sqlite` with the unzipped backup, restart. There is no in-app restore button — restore is a deliberate, manual operation.

---

## Alerts engine

[src/lib/alertEngine.js](src/lib/alertEngine.js) + [src/lib/alertRules.js](src/lib/alertRules.js). Runs once a minute. Rules check state, call `fireAlert()` or `resolveAlerts()` with a stable `dedupKey` so re-firing the same alert is idempotent.

Current rules:

- **`sage-down`** — Sage probe failed 5 times in a row (≈ 5 min). Critical. Auto-resolves when the probe recovers.
- **`backup-verify-failed`** — latest `backup-verify` job run is `failed`. Auto-resolves on next successful run.
- **`job-failure-spike`** — three or more job failures in any 30-minute window across all jobs. Warning. Auto-resolves after 30 minutes of clean runs.
- **`security-signals`** — see next section. Three sub-alerts: `security-login-spike`, `security-401-flood`, `security-429-flood`.

**Where alerts surface:** the bell icon in the topbar. Active alerts get a red dot count. Click to open the alerts drawer — see active + recently-resolved. Each has rule, severity, message, fired-at, resolved-at, dedup_key, context JSON.

**Acknowledge** marks an alert as seen but does not resolve it. Resolution is engine-driven (the rule decides when conditions are clear). There is intentionally no "force resolve" button — if the rule keeps firing, that's information, not noise.

---

## Security signals

[src/lib/securitySignals.js](src/lib/securitySignals.js). In-memory only — restart wipes it. Use for "what's happening right now"; for forensics use `error_log` and `login_log`.

Per-minute buckets retained for 24h (rolling), windowed at 60m for the dashboard. Each bucket counts:

- `requests` — total HTTP requests in this minute.
- `latency_ms_total` — sum of req durations (avg = total / requests).
- `status_401` / `status_403` / `status_429` — response code counts.
- `login_failures` — 401s against `/api/auth/login`, `/api/auth/hub-token-login`, `/api/auth/set-initial-password` only. Other 401s (e.g. `/api/auth/me`) don't count.
- `login_throttle_events` — 429s against the same auth endpoints.
- `upload_bytes` — sum of POST body sizes for routes that accept uploads.

Captured via the `captureSecuritySignal` middleware bolted in `server.js` after the session middleware.

**Operations → Security tab** shows eight cards summarising the last 60 min, each with operator-language description ("401 = Unauthorized — requests with no/expired/invalid session"). And a threshold-alert list at the bottom.

**Thresholds (currently fixed in code, see `ruleSecuritySignals`):**

- ≥ 20 login failures in 5 min → `security-login-spike` (warning).
- ≥ 100 401s in 5 min → `security-401-flood` (warning).
- ≥ 200 429s in 5 min → `security-429-flood` (warning).

These resolve automatically once the rate falls below threshold for 5 min.

**Caveats:**

- A restart clears the metric. Right after a restart you'll see "no data" for 1 min until the first bucket fills.
- Buckets are 1-minute resolution. Sub-minute spikes are visible in `requests` but not granular.
- The 60-minute window uses real time, not bucket count (PR #194 fix).

---

## Auto-update flow

The auto-update system pulls a release zip from the GitHub releases page and deploys it in place. Code lives in [src/services/updateService.js](src/services/updateService.js).

**Stages:**

1. **Check.** Polls GitHub releases API, compares `package.json` version against latest. Cadence: every 6 hours, plus manual check. The result is cached in `bat_settings.update_check`.
2. **Download.** On user-initiated install, downloads the asset (delta or full) into `tmp/update/`.
3. **Verify.** SHA256 against the release's `.sha256.txt` companion file. Mismatch aborts.
4. **Apply.** Stops the service, swaps `dist/`, runs migrations, restarts. The whole process is gated by a 60-second timeout — past that, abort + roll back.

**UI:**

- Operations → Updates (and the duplicate Settings → Updates tab) shows: current version, latest version, "what's new" notes, two buttons — "Check now", "Install update".
- While installing: live phase indicator (downloading / verifying / applying / restarting).
- On failure: sticky red banner at the top of the page until acknowledged. The banner is suppressed once a *newer* successful update lands.

**Delta vs full.** A delta is a small zip containing only the changed files since the previous release. A full is the whole `dist/`. The system tries delta first; falls back to full if the delta server-side hash doesn't match (rare).

**Hub-coordinated updates** (preview): the hub can push "update window" instructions to each site. Not active by default. For now, each site updates on its own button-press.

---

## TLS, Caddy, Tailscale

Sites run plain HTTP on the LAN — no TLS. The hub runs HTTPS via Caddy + Tailscale + Let's Encrypt.

**Layout:**

- Tailscale provides a private network between the hub and every site. Each site has a stable Tailscale IP.
- Caddy at the hub proxies `https://<hub-tailscale-name>.tailnet.ts.net` to localhost:3001.
- Let's Encrypt issues a real cert via the Tailscale ACME flow — no DNS gymnastics required.
- Site → hub calls (e.g. credit-logic pull, hub redirect JWT) target the hub's Tailscale name and use that cert.

The setup script is `scripts/install-hub-caddy.ps1`. It installs Caddy, writes a Caddyfile pointing at the right local port, and starts the service. It is idempotent — re-run it any time to repair.

**Settings → TLS tab** shows live posture: Caddy installed (Y/N), Caddy running (Y/N), cert valid until (date), Tailscale up (Y/N). And a "Re-run setup" button that invokes the install script.

**Common gotcha:** browser sees the Let's Encrypt cert (good); Node fetch from a site sees a different self-signed cert. Cause: the site Node was hitting a different port (`:443` default vs `:8443` actual) and falling through to a non-Caddy listener. Fix: set the full URL in `HUB_REDIRECT_URL` including the port — don't rely on port defaults.

---

## Hub URL self-heal

Sites need to know the hub's URL for two things: silent hub redirect (frontend) and credit-logic pull (backend). Originally this was just `HUB_REDIRECT_URL` in `.env`. Problem: if the hub address changes, every site needs an env edit + restart.

The fix (PR #181-ish): `bat_settings.hub_url` is a database row that overrides the env. Settable via Settings → TLS → Hub URL field, with a "Probe" button that fetches `${url}/api/system/health` and confirms the response shape is right. The probe surfaces errors in plain English: "Hub responded but health check shape was wrong", "Hub unreachable: ECONNREFUSED", "Hub responded but TLS cert chain is invalid", and so on.

If the DB row is set, it wins. If not, env wins. If neither, hub redirect and credit-logic pull both fail with a clear error explaining what to set.

The hub itself stamps its own URL into `bat_settings.hub_url` on each site every time it pings — so a site freshly added gets self-healed within one hub-pull cycle.

---

## Hub site orphans

The hub knows about sites in two places: the `HUB_SITES` env JSON array AND the `hub_sites` table. They drift. Three drift cases:

1. **In env, not in table.** First sync creates the table row. No problem.
2. **In table, not in env.** This is an "orphan" — the operator removed the site from `HUB_SITES` but its history is still in `hub_sites`, `hub_records`, `hub_sync_log`.
3. **In both, but URL/token differs.** The env wins on each upsert.

PR #200 introduced a **soft-tombstone** for case 2:

- `hub_sites.in_env` (1 = currently in HUB_SITES env, 0 = no longer in env).
- `hub_sites.removed_from_env_at` (timestamp when it dropped out of env).
- `upsertSites()` does a 3-step reconcile: upsert incoming as `in_env=1`, mark missing as `in_env=0` + stamp `removed_from_env_at`, **empty-env guard** refuses to mark all rows orphan if incoming is empty AND table has rows (protects against a misconfig wiping the lot).

**Visible effects:**

- Orphan tiles on the hub dashboard show a grey "ORPHAN" status pill, no resync controls, and an inline reason ("Removed from HUB_SITES env on 2026-04-12").
- Force-resync against an orphan returns 409 with a useful error.
- `pushCreditLogicToSites` skips orphans.
- Hub backup pull skips orphans.

**Forget admin flow** — Settings → Hub Maintenance → Orphan Sites section. Each orphan has a "Forget" button. Clicking it permanently deletes the `hub_sites` row + cascades to `hub_records`, `hub_sync_log`, `hub_inventory` for that site. Confirmation modal explains exactly what gets deleted. There's no undo (the records are gone) — but the site can always re-onboard from scratch by adding it to env again.

---

## The Accpac on-hold module (preview)

This module is **the first thing Cardoso writes back to Accpac**. Historically Cardoso has been read-only against Accpac. This module is a deliberate exception, with extensive guard rails. The full design is at [docs/plans/cardoso-to-accpac-hold-sync.md](docs/plans/cardoso-to-accpac-hold-sync.md); the operator's guide is at [docs/cardoso-accpac-hold-guide.md](docs/cardoso-accpac-hold-guide.md). What follows is a summary so operators have the shape of it in their heads.

**Core principle: Cardoso proposes, Accpac disposes.** Cardoso never directly mutates an Accpac row. It writes a "proposal" to a Cardoso table. A separate, deliberately-slow worker reads pending proposals and applies them via Sage's documented API.

**Hold-only invariant.** Cardoso can ONLY put a customer ON hold. It can NEVER take one off. Off-hold release is always a manual action in Accpac. This is non-negotiable — the architecture refuses to encode an "unhold" code path.

**The seven gates a write has to pass:**

1. **Master enable switch** must be on (admin-only setting; password re-entry to enable).
2. **Per-user permission** `can_release_holds` must be set.
3. **Customer-side checks** — no recent activity, ageing thresholds met, terms profile compatible.
4. **Duplicate proposal check** — unique partial index on (customer_number, status='pending') prevents racing.
5. **Connection_id pinning** — proposals are bound to the connection they were created against.
6. **Failure-state tracking** — proposal status enum: pending / applying / applied / failed / cancelled.
7. **Bulk-block** — Cardoso refuses to enqueue more than N proposals in any one batch (currently 1).

**Master enable switch** lives at Settings → Accounting → "Enable Accpac on-hold writes". Off by default. Turning it on shows a long warning modal and requires the admin to retype their password. Turning it off cancels every pending proposal in the queue (with a record-of-cancellation row).

**Status:** module is planned, not yet shipped. Operators may see Settings entries appearing as PRs land — but until the master switch is on, no proposals are sent.

**Emergency disable:** flip the master switch off. All pending proposals are cancelled. Every applied proposal stays applied (those are real Accpac actions; we don't undo). To "undo" an applied hold, manually take the customer off-hold in Accpac.

---

## Visual cues — what every colour, badge, and pill means

A reference for every recurring visual signal across the app.

**Customer flag colours (Customer Search, Customer Balances, Records):**

- **Red dot** — flagged red. Hover shows reason. If reason starts with "Auto-flagged:" the rule that matched is named. Otherwise an operator's username appears.
- **Orange dot** — same, orange.
- **Green dot** — same, green.
- **No dot** — no flag (`flag_color = 'none'`).
- **Greyed-out dot** — the flag was cleared but the customer hasn't re-synced yet.

**Sync status pills (Connections list, hub tiles):**

- **Green** — last sync OK.
- **Amber** — last sync OK but stale (≥ 1 hour).
- **Red** — last sync failed (hover for the error).
- **Grey** — never synced.
- **Grey "ORPHAN"** — site no longer in HUB_SITES env (PR #200).

**Timestamps:**

- **Black/normal text** — fresh, within expected cadence.
- **Amber text** — stale (e.g. > 1 hour for sync; > 24 hours for backup).
- **Red text** — overdue (e.g. > 24 hours for sync; > 72 hours for backup).

**Invoice number underline (Reconciliation):**

- **Red wavy underline** — the OCR'd or typed invoice number does NOT match the configured digit-length pattern (default 9 digits; configurable to 8 in Settings → Reconciliation). See **Why an invoice number gets a red underline** earlier in this doc.
- **Green check** — invoice matched a Sage credit note for the same customer in the same week.
- **Grey** — invoice waiting to be matched (typical state after fresh OCR before recon runs).

**Disabled buttons:**

- **Greyed with tooltip** — explicitly disabled with a reason: "OCR queue paused", "Insufficient permissions", "Master enable switch is off".
- **Greyed without tooltip** — pre-condition not met (e.g. no row selected). Hover the row context to see what's missing.

**Job runs status badges (Operations → Job Runs):**

- **Green** — completed successfully.
- **Red** — failed (raised exception).
- **Amber** — soft-failed (completed but `successCheck` returned false — e.g. backup-verify ran but found a corrupt file).
- **Blue** — currently running.
- **Grey** — never run.

**Alert severity icons (bell drawer):**

- **Red triangle** — critical.
- **Amber circle** — warning.
- **Strikethrough** — resolved.

---

## The disable button pattern

A pattern repeated across the system: anything that could fire repeatedly, lock contention, or misbehave at scale has a **pause / disable** toggle. Operators should know where these live so they can stop bad behaviour fast without waiting for a service restart or a code fix.

- **OCR queue pause** — Settings → Reconciliation → "Pause OCR queue". Stops the worker thread from picking up new items. Items already in flight finish. Use when an OCR provider is misbehaving or you've blown a billing cap.
- **Auto-update disable** — Settings → Updates → "Disable auto-check". Stops the 6-hour update poll. The "Install" button still works manually.
- **Auto-flag disable per rule** — Settings → Auto-Flag Rules → toggle the "Active" switch on the rule row. Rule stops evaluating immediately.
- **Backup sync disable** — Settings → Hub Maintenance → "Backup sync from sites" toggle. Stops the hub from pulling backups. (Sites still produce their own local backups.)
- **Sage probe** — has no pause; if probe is misbehaving, fix the connection. The probe is bounded (60s cadence, 5s timeout per probe).
- **Hub redirect** — disable per-user via Settings → Users → uncheck `hub_redirect`. The user logs into the site UI directly thereafter.
- **Credit logic push** — there is no automatic credit-logic push; it is always a manual button. So no disable needed.
- **Master enable switch (Accpac on-hold)** — Settings → Accounting → "Enable Accpac on-hold writes". When off, no proposals are dispatched. Default off.

When in doubt: there is almost always a pause toggle. Look in the relevant Settings tab before SSH-ing into the box.

---

## Common operator tasks

Quick recipes for things operators do often.

**Find a customer.** Top bar search. Type any part of name / code / phone / invoice number. Live against Accpac.

**Flag a customer manually.** Customer Search → click the row → flag dropdown. Choose colour + free-text reason. Saved immediately. This flag will never be overwritten by an auto-flag rule.

**Clear a manual flag.** Same dropdown → "Clear". Auto-flag rules will re-evaluate the customer on next sync.

**Trigger a sync now (site).** Settings → Connections → click the row → "Sync now". Or wait for cron.

**Trigger a sync now (hub, single site).** Hub Dashboard → site tile → click the resync icon. Or click "Sync from Accpac" to also trigger an Accpac→site sync first.

**Trigger a sync now (hub, all sites).** Hub Dashboard → top toolbar → "Sync all". Iterates over every non-orphan site.

**Push credit logic to all sites.** Settings → Credit Logic → "Push to sites". Watch the toast for per-site results; failures are logged in Hub Sync Log.

**Apply auto-flag rules now.** Settings → Auto-Flag Rules → "Apply rules now". Re-evaluates every active rule against every record.

**Add a user.** Settings → Users → "Add". Fill name + username + email + permissions. Default password is set by env or `Cardoso@2026`. They are forced to change on first login.

**Reset a password.** Settings → Users → row → "Reset password". User gets a one-time link (or admin tells them the new default — depending on install).

**Forget an orphan site.** Settings → Hub Maintenance → Orphan Sites → "Forget". Confirm. All site-scoped rows are deleted.

**Restore a backup.** Stop the service. Replace `data/cardoso.sqlite` with the unzipped backup. Start the service. (No in-app button by design.)

**Pause OCR.** Settings → Reconciliation → "Pause OCR queue". Worker stops picking up items; in-flight finish.

**Reset OCR queue.** Same panel → "Reset queue". Marks all queued items as failed. Use only if the queue is genuinely stuck.

---

## Troubleshooting

Symptoms → likely causes.

**"Customer search returns nothing."**
- Connection error (Sage server unreachable). Check Settings → Connections → the connection's last status / error.
- Filter typo. Try just first 3 chars of customer code.
- Out of permissions. Customer Search itself needs no perm but specific tabs do — look for a 403 in the network tab.

**"Sync from Accpac returns 'site sync failed'."**
- The site couldn't reach Accpac. Site → Settings → Connections shows the underlying error.
- Connection credentials wrong. The error message will say "login failed".
- Site service is down. Hub tile will already show OFFLINE.

**"Invoice has a red wavy underline."**
- The number doesn't match the digit-length pattern. See **Why an invoice number gets a red underline**. Default is 9; sites with 8-digit Accpac numbers need Settings → Reconciliation → "Invoice digit length" set to 8.

**"OCR is not running."**
- Pause toggle is on. Settings → Reconciliation → check.
- All four OCR providers exhausted billing. Check Operations → Job Runs → `ocr-poll` job for errors.
- Tesseract subfolder missing tessdata. Site-specific install issue — manually copy `vendor/tessdata/eng.traineddata`.

**"Hub tile says 'Logic version mismatch'."**
- Push didn't reach the site. Click "Push" on the hub OR have the site click "Pull" in Settings → Credit Logic. Check Hub Sync Log for errors.

**"Login fails with 'invalid signature'."**
- `JWT_SECRET` differs between site and hub. Re-run `scripts/install-hub.ps1` or copy the hub's value to the site's .env. Restart both.

**"Backup not appearing in Hub Backups."**
- Site OFFLINE → can't pull. Resync.
- Site has no backups (newly installed). Wait until 03:00 + first run.
- Hub Maintenance → Backup sync disabled. Re-enable.

**"Updates banner stuck red after I've upgraded."**
- The banner clears only when a *newer* successful update lands. Manually clearing the failure: Operations → Updates → "Clear failure".

**"Login throttled."**
- The user hit the rate limiter (5 fails in 10 min). Wait 10 minutes or admin can reset by deleting the user's `login_log` recent rows.

**"Customer flagged red but I can see it should be green / vice versa."**
- A manual flag is in place — auto-flag rules don't overwrite manual flags. Clear it first.
- Or rule order is wrong — first matching rule wins; reorder in Settings → Auto-Flag Rules.

**"Site appears in hub list as ORPHAN."**
- The site is no longer in `HUB_SITES` env. Either re-add it to env (then the orphan flag clears on next upsert), or click Forget to delete the historical data.

---

## Where to find things

UI-to-section map. "If I'm looking at this in the UI, where do I read about it?"

- **Top bar search** → Customer Search section.
- **Sidebar Customer Management** → Customer Search.
- **Sidebar Customer Balances** → Customer Balances section.
- **Sidebar Collections** → Collections.
- **Sidebar Inventory** → Inventory.
- **Sidebar Records** → Records.
- **Sidebar Reports** → Reports.
- **Sidebar Reconciliation** → Reconciliation (BAT) + OCR pipeline.
- **Sidebar Hub Dashboard** → Hub Dashboard.
- **Sidebar Hub Metrics / Trends / Audit / Backups / Reconciliation** → Hub Metrics, Trends, Audit Log, Backups section.
- **Sidebar Operations** → Operations page.
- **Gear → Settings** → Settings panel + each tab's section.
- **Bell icon** → Alerts engine.
- **Top-right user menu** → Auth, sessions, hub redirect.
- **Red wavy underline on an invoice number** → Why an invoice number gets a red underline.
- **Grey "ORPHAN" pill** → Hub site orphans.
- **TLS / Caddy banner** → TLS, Caddy, Tailscale.

---

## Environment variables reference

Set in `.env` at the install root. Restart the service after changes.

| Variable | What it does | Default |
|---|---|---|
| `PORT` | HTTP port. | 3001 |
| `SESSION_SECRET` | Cookie signing key. **Required.** Generate: `openssl rand -hex 32`. | none |
| `ENCRYPTION_KEY` | Encrypts saved SQL passwords. **Required.** Generate: `openssl rand -hex 32`. Changing it invalidates saved connection passwords. | none |
| `JWT_SECRET` | Hub redirect JWT signing key. Must match between site and hub. | none |
| `SITE_ID` | UUID of this site. | none |
| `SITE_SLUG` | Short slug (jhb / pta / ermelo). | `local` |
| `SITE_NAME` | Display name. | `Local` |
| `REPORTING_TOKEN` | Token the hub sends in `X-Reporting-Token` to read this site's KPIs. | none |
| `HUB_MODE` | `true` runs as hub. | `false` |
| `HUB_SITES` | JSON array of `{id,slug,name,url,token}` per site. | `[]` |
| `HUB_REDIRECT_URL` | URL to redirect hub-redirect users to. Include port if non-default. Overridden by `bat_settings.hub_url`. | none |
| `DEFAULT_USER_PASSWORD` | Default password for new users. | `Cardoso@2026` |
| `SUPER_ADMIN` | Username (or user_id) of the un-deletable super-admin user. | none |
| `HUB_SHARED_SECRET` | HMAC for hub-internal endpoints (used by some hub→site control RPCs). | none |
| `HUB_POSTGRES_*` | Phase 2 hub Postgres scaffold. SQLite is still authoritative. Leave defaults. | various |
| `NTOPNG_URL` / `_USER` / `_PASSWORD` | Network monitoring (hub only). Can also be set via Hub Settings UI. | none |

---

## Recent changes worth knowing

A non-exhaustive list of behaviours that might surprise an operator who learned Cardoso a while ago.

- **PR #186** — invoice digit length is configurable (8 vs 9). Default still 9. Set per-site under Settings → Reconciliation. Affects OCR matching AND the red-underline check.
- **PR #187 / #188** — Sage credit notes WEEK matching now parses week as INT. Earlier strings like `"01"` mismatched `1`.
- **PR #192** — every error in the app now goes through `describeFetchError` / `describeSqlError` / `describeSqliteError` for plain-English surfacing. Frontend wraps API errors with `humanizeApiError`.
- **PR #193** — Operations → Security tab. Eight metric cards + descriptions. Threshold alerts at the bottom.
- **PR #194** — securitySignals window fix: 60 minutes is real time, not "60 most-recent buckets".
- **PR #197** — duplicate System Log + Updates tabs removed from Settings (still in Operations).
- **PR #198** — hub tiles show site→Accpac freshness; "Sync from Accpac" button.
- **PR #199** — Cardoso → Accpac on-hold sync design + plain-English guide.
- **PR #200** — hub_sites soft tombstone + orphan tile + Forget admin flow.

For the precise list, `git log --oneline main` and the GitHub PR list.

---

## Glossary

- **Accpac** — what most of us call Sage 300 ERP. Same product. Cardoso reads its MSSQL database.
- **Auto-flag** — rule-driven automatic colour assignment to a customer.
- **BAT** — the supplier whose weekly spreadsheet drives the Reconciliation module. Module is generic but the supplier is named.
- **Connection** — a configured link to one Accpac SQL Server database.
- **Credit logic** — the JSON config that drives customer ranking. Versioned, pushed from hub to sites.
- **dedup_key** — alert-engine field that collapses repeated firings of the same underlying issue into one active row.
- **datarecord** — main customer table on a site. Mirrored from Accpac.
- **Hub** — head-office Cardoso. Aggregates from sites. `HUB_MODE=true`.
- **hub_records / hub_sites / hub_inventory** — hub-only tables for aggregated data.
- **hub_redirect** — per-user flag that silently bounces them to the hub on site login.
- **HUB_SITES** — env JSON array of sites the hub should pull from.
- **JWT** — short-lived signed token used for hub silent login. HS256, 5 minutes.
- **Master enable switch** — admin-only toggle that gates an entire module. Currently used for the Accpac on-hold module (preview).
- **OCR** — optical character recognition for invoice numbers. Four-provider fallback chain.
- **Orphan site** — a `hub_sites` row whose ID is no longer in HUB_SITES env. Soft-tombstoned, can be Forgotten via UI.
- **Probe** — a periodic health check (Sage probe, hub probe). Drives status pills and alert engine.
- **Proposal** — a queued change Cardoso wants to make in Accpac (on-hold module).
- **Site** — a branch install. `HUB_MODE=false` (or unset).
- **Soft tombstone** — a row marked deleted (`in_env=0`) but not physically removed. Lets us preserve history while excluding from operations.
- **Successful soft-fail** — a job that completed without throwing but whose `successCheck` returned false. Logged as `failed` for alerts purposes.
- **Tessdata** — Tesseract's English language model file. Lives at `vendor/tessdata/eng.traineddata`.

---

## Where to escalate

- **Service won't start.** `data/cardoso.sqlite` corrupt, or migration broke. Check Windows Event Log → `cardoso-svc`. Restore last good backup if integrity check fails.
- **Hub redirect broken across the estate.** `JWT_SECRET` drift or hub URL change. Re-run `scripts/install-hub.ps1`. If the hub's IP changed, update `bat_settings.hub_url` on every site (or wait for the self-heal ping cycle).
- **Sage probe persistently red on a site.** Network team — Cardoso server can't reach Sage SQL. Test with `Test-NetConnection <sage-host> -Port 1433` from the Cardoso box.
- **OCR billing exhausted.** Pause queue. Top up provider keys at the relevant dashboards (Google Vision, ocr.space). Update keys in Settings → Reconciliation. Resume queue.
- **Massive data loss / corruption.** Stop service, restore latest backup from `backups/` (local) or `backups/sites/<slug>/` (hub-pulled, last 14 days). Bring back online, run `backup-verify` job manually to confirm.
- **Suspected malicious activity.** Operations → Security tab + the alert drawer. Cross-reference `login_log` for IPs. Reset compromised user passwords. Check `error_log` for unusual 500s.
- **Bug or "this should not be possible" event.** Capture the URL, screenshot, and any error message text shown to the user. Then `git log -1` for the version, paste into a bug report. Include the relevant `error_log` row(s) if you can find them — they have stack + context.

For everything else: read the relevant section above, or read the code. Most things are one or two files away from the UI.
