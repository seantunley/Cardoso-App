# Cardoso Ledger

A self-hosted operations platform for Cardoso Cigarettes. Combines customer
management, accounts-receivable workflow, BAT supplier reconciliation, multi-site
hub aggregation and a printable reports module — all running on a single
Node.js + SQLite stack.

Built with **React (Vite) + Node.js / Express + better-sqlite3** and a small
amount of MSSQL connectivity for live Sage 300 lookups.

---

## What's inside

### Customer & Accounts Receivable
- **Customer Search** — fuzzy lookup against the imported Sage customer book,
  flag colour history, payment-lag charts and a credit verdict score.
- **Customer Balances** — paginated outstanding-balance browser with sales-rep,
  account-type and aging filters; resizable columns; printable.
- **Collections** — pipeline of red/orange-flagged customers with notes and a
  promised-vs-resolved tracker.
- **Records** — raw `datarecord` viewer for power users.

### BAT Reconciliation
A purpose-built module for reconciling the weekly BAT supplier credit-note
spreadsheet against actual postings in Sage 300 and the OCR-extracted POD
PDFs. Highlights:
- Per-week Supplier (BAT) vs. Credit Notes (Sage 300) variance.
- Multi-engine OCR pipeline (Google Vision → ocr.space → Tesseract) with a
  configurable worker pool, pause switch, and Server-Sent-Event status stream.
- Auto-correct of single-digit OCR mistakes against known Cardoso invoices,
  with a `manual_override` flag that protects deliberate user edits.
- Exception summary widget aggregated across all uploaded weeks.
- Cross-reference table that joins extracted invoices to Cardoso invoices by
  number and amount.

### Reports
A printable report archive (admin-gated) for handing numbers to finance:
1. **Aged Debtors** — buckets, flag mix, sortable table, A4 landscape print.
2. **Sales Rep Exposure** — per-rep totals + drillable top customers.
3. **BAT Weekly Reconciliation** — per-week variance + line chart + table.
4. **BAT YTD Fee Breakdown** — discount / delivery / pricing.
5. **BAT Exceptions Summary** — by reason and by store.
6. **Inventory Value & Composition** — top items + commodity donut.

Each report has filters, themed Recharts visuals, CSV export and a
purpose-built A4 print layout.

### Hub mode
When `HUB_MODE=true`, the same binary runs as a central hub that pulls
customer records, inventory, KPIs and BAT summaries from any number of
registered sites. Includes:
- **Hub Dashboard** — per-site KPIs, online status.
- **Hub Reconciliation** — cross-site BAT summary tiles + per-site cards.
- **Site Backups, Site Metrics, Trends, Sync Log, Hub Audit Log.**

### Connections
Configurable SQL Server / MSSQL connections per site, with a per-connection
`is_bat_only` flag so the BAT Sage connection stays isolated from the customer
search sync engine.

### Settings
- API keys for OCR services, Sage 300 connection picker, TG1 / TG2 rates.
- OCR pause toggle.
- Auto-flag rule editor + tester.
- Replicate-supplier-into-cardoso admin tool.

---

## Prerequisites

Before you begin, make sure the following are installed on your machine:

- **Node.js** (v18 or later) — https://nodejs.org
- **Python** (v3.x) — required by some native Node modules — https://www.python.org/downloads/
- **Git** — https://git-scm.com

> **Windows users:** when installing Python, tick **"Add Python to PATH"**.
> If native module compilation fails on first install, run
> `npm install --global windows-build-tools` from an elevated command prompt.

---

## Development Setup

```bash
# 1. Clone the repo into the required folder
git clone https://github.com/seantunley/Cardoso-App.git "C:\Cardoso Customer App"
cd "C:\Cardoso Customer App"

# 2. Install dependencies
npm install

# 3. Create your .env file from the example
cp .env.example .env
# Open .env and fill in: SESSION_SECRET, DB_PATH, REPORTING_TOKEN, etc.

# 4. Start the dev server (backend on :3101 + Vite frontend on :5173)
npm run dev
```

App runs at: http://localhost:5173

The Express API serves on `http://localhost:3101` and Vite proxies `/api/*`
requests to it.

---

## Production Deployment (Windows)

```bash
# 1. Build the frontend
npm run build

# 2. Start the production server (serves API + built frontend on one port)
npm start
```

To run as a Windows service, use the NSSM scripts in `scripts/`:
- `install-service.bat` — installs and starts the service
- `update.bat` — pulls latest changes and restarts the service
- `uninstall-service.bat` — removes the service

> ⚠️ The scripts expect the app to live at `C:\Cardoso Customer App`. Clone
> there or the paths will break.

---

## Default Credentials

On first run, a default admin account is created:

- **Username:** `admin@example.com`
- **Password:** `admin123`

⚠️ Change these immediately after first login.

---

## Environment Variables

See `.env.example` for the full list. The most important ones:

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Must be at least 32 random characters. |
| `ENCRYPTION_KEY` | 64 hex characters (32 bytes). Required for encrypted password storage. |
| `DB_PATH` | Path to the SQLite database file (default: `./database/cardoso.db`). |
| `PORT` | Express API port (default: `3101`). |
| `NODE_ENV` | Set to `production` for production deployments. |
| `REPORTING_TOKEN` | Token gating the `/api/reporting/*` endpoints (used by the hub to pull from sites). |
| `HUB_MODE` | `true` to run as a central hub. Default `false` (site mode). |
| `HUB_SITES` | JSON array of `{id, slug, name, url, token}` describing each registered site (hub-only). |
| `OCR_CONCURRENCY` | Number of parallel OCR worker lanes (default `4`). Set to `1` for sequential. |
| `SITE_NAME` / `SITE_SLUG` / `SITE_ID` | Human-friendly site identity used in reports and hub aggregation. |

---

## Stack

- **Frontend** React 18 + Vite + Tailwind + shadcn/ui + TanStack Query + Recharts.
- **Backend** Node.js + Express + better-sqlite3 (synchronous), `mssql` for Sage 300.
- **OCR** Multi-engine pipeline: Google Vision API → ocr.space → Tesseract.js fallback.
- **Auth** Session-based, admin / per-permission gates per nav item.
- **Toasts** Sonner with a custom Cardoso theme.
- **Print** Browser print + dedicated `@media print` stylesheets per report.

---

## Repository layout

```
src/
├── components/
│   ├── reports/            ← printable reports module
│   ├── reconciliation/     ← BAT reconciliation UI
│   ├── customer/           ← customer lookup, payment history
│   ├── connections/        ← SQL connection management
│   ├── settings/           ← settings panel + auto-flag rules
│   ├── ui/                 ← shadcn primitives
│   └── ...
├── pages/
│   ├── Reports.jsx         ← reports hub
│   ├── Reconciliation.jsx  ← BAT reconciliation page
│   ├── HubReconciliation.jsx
│   ├── CustomerBalances.jsx
│   ├── CustomerSearch.jsx
│   └── ...
├── routes/
│   ├── batReconciliation.js
│   ├── reporting.js        ← /api/reports/* + /api/reporting/* (token-auth)
│   ├── hub.js              ← /api/hub/* (hub-mode only)
│   └── ...
├── services/
│   ├── batReconciliation.js  ← OCR worker, Sage 300 pool, matching
│   ├── hubEtl.js             ← cross-site puller
│   └── syncEngine.js         ← per-connection import
└── db/
    ├── migrations.js       ← all schema migrations (v1–v49)
    └── ...
docs/
└── release-notes-*.md      ← per-release notes
```

---

## Release notes

Per-release notes live in [docs/](docs/). Latest:
[2026-04-30](docs/release-notes-2026-04-30.md) — Reports module + Hub
Reconciliation + performance pass + UI polish.

---

## Version

Current version: **v2026.4.6**
