---
title: "Cardoso — Sage Connection Setup"
subtitle: "Wiring a freshly deployed site into Sage 300 for BAT Reconciliation"
author: "Cardoso Operations"
date: "May 2026"
---

# Cardoso — Sage Connection Setup

**Wiring a freshly deployed site into Sage 300 for BAT Reconciliation.**

This guide covers the one-time setup needed on every newly deployed Cardoso
site to give it read-only access to the customer's Sage 300 database. Without
this connection, the BAT Reconciliation module shows "no Sage" and the weekly
credit-note totals stay blank.

The whole setup takes about **5 minutes**.

---

## 1. What this does

The BAT Reconciliation module compares supplier invoice totals (extracted via
OCR) against credit-note batches posted in Sage 300. To do this it needs a
read-only SQL Server connection to the customer's Sage database.

The connection itself is just a row in Cardoso's local SQLite
`databaseconnection` table. The BAT module auto-detects it by matching
`name LIKE '%sage%' AND status = 'active'`, and runs two hard-coded queries
against it:

- **`credit_notes_by_week`** — pulls AP credit-note batches for a given week
  from `APIBC` / `APIBH` / `APIBD`, filtered to BAT vendors.
- **`posted_invoices`** — pulls posted BAT invoices from `APOBL` for matching
  against extracted invoice numbers.

Both queries are stored in
[`src/services/batReconciliation.js`](../src/services/batReconciliation.js)
and a reference copy is written into the connection row's `table_configs`
field at seed time, for audit purposes.

---

## 2. Prerequisites

Before you start, you'll need:

- The Cardoso site already installed at `C:\Cardoso Customer App` and the
  `Cardoso` Windows service running.
- The customer's Sage 300 SQL Server credentials:
  - host (e.g. `SAGE-SQL01` or an IP)
  - database name (e.g. `BATCOMPDAT`)
  - SQL username (read-only is fine)
  - SQL password
- A Cardoso admin login for the new site.

If you don't have the Sage credentials, get them from the customer's IT
contact before you start — the seed script creates the row with placeholders,
but the connection won't activate until they're filled in.

---

## 3. Run the seed script

The seed script creates (or refreshes) a row called
`Sage 300 (BAT Reconciliation)` in the local Cardoso database. It pre-populates
the BAT-specific queries and sets `is_bat_only = 1` so the row is excluded
from the generic sync engine.

Open PowerShell **as Administrator** and `cd` to the install directory:

```powershell
cd "C:\Cardoso Customer App"
```

The bundled Node binary lives at `.\node\node.exe`. Run the seed script
against it:

```powershell
.\node\node.exe scripts\seed-sage-connection.js
```

Expected output:

```
Seeded Sage connection (id 7) with credit-notes query and is_bat_only=1.

Current Sage connection row:
{
  id: 7,
  name: 'Sage 300 (BAT Reconciliation)',
  host: 'FILL_IN_SAGE_HOST',
  database_name: 'FILL_IN_SAGE_DATABASE',
  username: 'FILL_IN_SAGE_USERNAME',
  status: 'inactive'
}

Fill in these placeholders via the Connections page (Edit → save):
  host:       FILL_IN_SAGE_HOST
  database:   FILL_IN_SAGE_DATABASE
  username:   FILL_IN_SAGE_USERNAME
  password:   (blank — set via Edit modal)

Then Test → Activate. BAT module will pick it up automatically.
```

> **Note:** If a Sage row already exists, the script updates the
> `table_configs` metadata in place. It will **not** overwrite a `sync_query`
> the user has already customised. Safe to re-run.

### Common errors

- **`node : The term 'node' is not recognized...`** — `node` isn't on PATH
  for that shell. Use the full path `.\node\node.exe` as above.
- **`SqliteError: no such table: databaseconnection`** — the app hasn't run
  yet on this site, so migrations haven't created the table. Start the
  `Cardoso` service once (it'll run all pending migrations) then re-run the
  seed.

---

## 4. Fill in credentials via the UI

Open the Cardoso UI on the new site and sign in as an admin.

1. Go to **Settings → Connections**.
2. Find the row called **Sage 300 (BAT Reconciliation)** — status will say
   *Inactive*.
3. Click **Edit**.
4. Fill in:
   - **Host** — Sage SQL Server hostname or IP
   - **Port** — usually `1433`
   - **Database** — Sage company database name
   - **Username** — SQL Server login
   - **Password** — SQL Server password
   - **Use Encryption** — leave off unless the customer's SQL Server
     requires it.
5. Click **Save**.

The password is encrypted at rest using the app's encryption key — it never
appears in plain text in the database or in the UI after save.

---

## 5. Test and activate

Still in **Settings → Connections**:

1. Click **Test** on the Sage row. You should see *Connection successful* and
   a row count from the test query.
2. If the test fails, check:
   - Firewall — does the Cardoso machine have TCP 1433 access to the Sage
     SQL Server?
   - Credentials — try them in SSMS from the Cardoso machine to rule out a
     typo.
   - Encryption — some hardened SQL Server installs require
     `Use Encryption = on`. Toggle it and re-test.
3. Once the test passes, click **Activate**. Status flips to *Active*.

That's it on the connection side. The BAT Reconciliation module now sees the
connection and starts populating credit-note totals on its next refresh.

---

## 6. Verify BAT Reconciliation is using it

1. Go to **Reconciliation** in the main nav.
2. The weekly comparison panel ("H1 · Weeks 1–26" / "H2 · Weeks 27–53") should
   show `BAT` and `Credit Notes` totals side by side. If both columns have
   values, the connection is working.
3. The `LAST WEEK PAID` and `MISSING WEEKS` cards at the top of Reconciliation
   also depend on this connection. They turn green/red based on the Sage data.
4. If the page still says *Awaiting data* or the Credit Notes column is all
   dashes, click **Refresh Sage cache** (top right of the weekly panel) to
   force an immediate pull. Otherwise the cache refreshes on the scheduler
   tick.

If you see *Sage refresh failed (...)* in the cache footer, the connection is
active but a query failed — open the System Log (Settings → System Log) to
see the SQL error.

---

## 7. What lives where

For future debugging, here's the relevant surface area:

| Concern | Location |
|---|---|
| Seed script | `scripts/seed-sage-connection.js` |
| Hard-coded BAT queries | `src/services/batReconciliation.js` |
| Connection auto-detect | `name LIKE '%sage%' AND status = 'active'` |
| Connection row | SQLite table `databaseconnection` |
| Cache refresh schedule | `src/scheduler.js` (skipped on Hub mode) |
| Connections UI | Settings → Connections |
| Per-user access toggle | `can_access_reconciliation` |

The connection is **never** synced to the Hub. It's a per-site secret and the
Hub doesn't talk to Sage directly.

---

## Summary

1. `cd "C:\Cardoso Customer App"`
2. `.\node\node.exe scripts\seed-sage-connection.js`
3. Settings → Connections → Edit Sage row → fill host / db / user / pass
4. Test → Activate
5. Open Reconciliation, confirm Credit Notes column populates

If anything in step 5 doesn't work, check the System Log for the SQL error
before re-running the seed — re-seeding rarely helps once the row exists.
