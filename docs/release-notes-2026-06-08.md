# Cardoso Release Notes — 2026-06-08

Covering **1–8 June 2026**.

A major **accounts-receivable & accounts-payable reporting** release. The
headline is a complete, **Sage-300-faithful aging system** — debtors and
creditors now age exactly the way Sage does, off the live open-item ledgers —
together with a new **Monthly Sales Figures** report, a **Monthly Reports**
module with its own access permission, an **Aged Creditors** dashboard tile, and
a polished, **branded print/PDF** experience across every report.

It builds on the **v2026.5.8** platform drop (2 June): the reporting dashboard,
the Insights feed, demand forecasting, commission archiving, and the JTI
self-heal.

---

## 📊 Aged Creditors — new report (Sage A/P method)

A brand-new **Aged Creditors** report, built to match the Sage 300 Aged
Payables trial balance exactly:

- Every open supplier document is aged **individually by its due date** and
  **distributed** across Sage's monthly periods — **Current / 1–30 / 31–60 /
  61–90 / Over 90** — so a vendor correctly spans several buckets instead of
  having its whole balance dumped into one.
- Sourced from the live **APOBL** open-item ledger (the same documents Sage
  ages), so the report reconciles to Sage to the cent.
- Full **CSV / Excel / PDF** export with per-bucket columns and a totals row.
- Reachable from **both** the Reports page (for reporting users) and the
  Creditors module (for creditor users).
- **Hub all-sites** support with a Site column and correct per-site vendor
  scoping.

Underneath it is a new **shared Sage-300 aging engine** that now powers both the
debtor and creditor reports from a single, tested code path.

---

## 📒 Aged Debtors — rebuilt on the Sage open-item ledger

The Aged Debtors report previously dumped each customer's **entire** balance
into a single bucket based on the oldest invoice — Sage's pre-aged figures
weren't present in the synced data, so per-document aging wasn't possible.

This release introduces a new **AR open-item ledger** synced from Sage
**AROBL**, and rebuilds the report on top of it:

- Every open invoice, credit note and debit note is aged **individually** into
  Sage's weekly periods — **Current / 1–7 / 8–14 / 15–21 / Over 21** — by
  document date.
- **National-account children roll up** under their national account (and
  inherit the parent's sales rep / account type), matching how Customer
  Balances rolls them up.
- The report now reconciles to the live Sage open items rather than a drifted
  master balance.

---

## 💰 Customer & Creditor Balances

- **Customer Balances rebuilt on the AR open-item ledger.** The screen now
  reconciles to the Sage open-item total to the cent, instead of tracking the
  master balance that had drifted from the underlying invoices.
- **Aging summary tiles** added to both the Customer Balances and Creditor
  Balances screens, and made **filter-aware** — the tile totals always match the
  list under any filter (account type, sales rep, site, etc.).
- **Customer pop-up cleaned up** — it now shows only **genuine open items**.
  Invoices that have been paid, and receipts that have been applied, net out and
  disappear; anything within a **R0.02 rounding tolerance** is hidden. No more
  phantom invoice/receipt rows on a zero-balance account.
- **Location and Terms** columns brought in per customer from Sage, plus a
  **National / Standard** account-type filter.
- New **Creditor Balances filter:** show only creditors that have **historically
  been paid** (blank last-payment-date excluded), on by default.

---

## 🧾 Monthly Sales Figures — new report

A new report replicating the Sage **"Sales Figures"** Crystal report:

- **Posted invoices, credit notes and debit notes by month**, with VAT shown
  separately — **Ex-VAT / VAT / Incl** for each document type — plus a **Net**
  column (Invoices + Debit notes − Credit notes) and grand totals.
- Sourced live from the Sage **ARIBH** invoice batches, document type by
  `TEXTTRX`, VAT-bearing documents only — so it matches the operator's existing
  Sage figures **to the cent**.
- The current month is highlighted; **CSV** export and **print** included.
- Available **per branch at the Hub**: each branch's figures are synced down and
  shown as a consolidated table plus one section per branch.

---

## 🛂 Monthly Reports module + permission

- A new **"Monthly Reports"** sidebar group containing **Monthly Sales Figures**
  and **Sales Commission**.
- Gated by a new, admin-toggleable **"Monthly Reports"** permission
  (`can_access_monthly_reports`). Existing administrators and anyone who already
  had Sales Commission access keep it automatically.

---

## 📈 Reporting Dashboard

- New **Aged Creditors** summary tile (total outstanding, vendor count, monthly
  buckets), filtered to vendors **with payment history**, deep-linking to the
  report.
- The **Aged Debtors** tile now shows the **positive-balance total that matches
  the Customer Balances page** (the "who owes us" figure) rather than the net
  open-item figure, and its bucket rows were corrected to the new aging periods
  (they had silently shown R0).

---

## 🖨️ Print & PDF — branded, professional

- Every report's print/PDF now carries a **branded header**: the **Cardoso
  logo**, the **depot name** (pulled from **Settings → Depot Details**), the
  report title, the selected period, and a generated timestamp.
- Fixed a long-standing bug where the branded header/footer **never rendered**
  (an inline `display:none` the print stylesheet couldn't override).
- Removed the faint **"CARDOSO LEDGER" watermark**.
- Reports now print **solid black** (the on-screen greys washed out on paper),
  **fit one landscape page** (no more clipped columns / blank second sheet), and
  the dense Sales Figures table no longer wraps.

---

## 🎨 Interface consistency

- Standardised every page heading on the app's **editorial heading style**
  (display serif, accent last word, trailing period) — Insights, the Reporting
  Dashboard, Sales Commission and Monthly Sales Figures now match the rest of
  the application.

---

## ✅ Credit analysis

- Customers that haven't transacted in over the dormancy window are now
  correctly flagged **Dormant** even when their balance is zero (previously they
  could be auto-approved).

---

## 🏗️ Platform — v2026.5.8 (2 June)

The reporting-platform release this period also delivered:

- **Reporting Dashboard** with a Sage health panel.
- **Insights** — an automatically surfaced feed of changes and risks, with
  no-code rules.
- **Demand forecasting / reorder** signals.
- **Sales Commission** archive + PDF, hardened for closed-period runs.
- **JTI** monthly-export daily self-heal.
- A **frontend performance pass** and routine dependency/security updates.

---

## 🗄️ Database

Four new migrations (apply automatically on first boot):

| Migration | Purpose |
|---|---|
| **v091** | Debtor AR open-item ledger (`debtor_ar_invoice`) + hub mirror |
| **v092** | Reporting-account column on the ledger (national-account roll-up) |
| **v093** | Hub AR Document Summary table (per-branch sync-down) |
| **v094** | `can_access_monthly_reports` permission (admins + existing commission users backfilled) |

---

## 🧪 Test plan

1. **Aged Creditors** — open from Reports; confirm vendors span buckets and the
   total reconciles to Sage APOBL. Export PDF/Excel.
2. **Aged Debtors** — confirm per-document aging and that national-account
   children roll up under the parent.
3. **Customer Balances** — confirm the grand total matches Sage open items and
   the aging tiles match the list under a filter; open a customer pop-up and
   confirm only genuine open items show.
4. **Monthly Sales Figures** — pick a month and reconcile Invoices / Credit
   Notes against the Sage Sales Figures report; print and confirm the branded
   header + one-page fit.
5. **Monthly Reports permission** — toggle "Monthly Reports" off for a test
   user; confirm the group disappears and the endpoints 403.
6. **Dashboard** — confirm the Aged Creditors tile (paid-history vendors) and
   that the Aged Debtors tile matches the Customer Balances total.
7. **Print** — print any report; confirm logo + depot name, no watermark, black
   text, single page.

---

## Behind the scenes

Verified in dev: `tsc` typecheck clean, `vite build` clean, `vitest` suite
green, and each backend change exercised against the live Sage connection where
applicable (Aged Creditors, Aged Debtors, Monthly Sales Figures all reconciled
to Sage). Hub-only paths are wired to the proven sync pattern but should be
verified on a hub install after its first ETL cycle.
