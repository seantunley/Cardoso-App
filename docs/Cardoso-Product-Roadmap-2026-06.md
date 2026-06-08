# Cardoso — Product Roadmap

**Prepared:** 8 June 2026
**Horizon:** June – September 2026

---

## Where we are

Cardoso has grown into a single operating platform for the business: live
Sage-300 data, customer and creditor management, BAT reconciliation, JTI
reporting, inventory, sales commission, and a reporting suite — all behind
role-based access and running reliably, including on air-gapped sites.

The most recent work (June 2026) made the **financial reporting Sage-faithful**:
debtors and creditors now age exactly the way Sage does, balances reconcile to
the Sage open-item ledgers to the cent, and a new **Monthly Sales Figures**
report matches the operator's existing Sage figures exactly. Reports are now
branded and print-ready.

This roadmap sets out where we take the platform next, organised into three
horizons. Dates are planning targets and will be confirmed sprint by sprint.

---

## Guiding principles

These hold across everything below:

- **Sage is the source of truth.** Every figure must reconcile to Sage. We
  build to match Sage's own methods, not approximate them.
- **No silent failures.** If something doesn't sync or reconcile, it is surfaced
  — never hidden.
- **One number, everywhere.** A value shown on a screen, a tile, a hub summary
  and a printout must always agree.
- **Multi-site by design.** Everything is built to work for a single depot today
  and to consolidate across all depots at the Hub.

---

## Horizon 1 — Now (June – July 2026)
### Theme: Finish the reporting rollout & operational visibility

**Multi-site reporting at the Hub.**
Bring the new Sage-faithful reports — Aged Debtors, Aged Creditors and Monthly
Sales Figures — fully live at head office, with each branch's figures synced
down and presented both per-branch and consolidated. *Outcome: head office sees
every depot's receivables, payables and sales in one place, reconciled to Sage.*

**Operational visibility (Job Control Centre).**
A single screen showing every background process — Sage syncs, backups,
reconciliation, exports — with its status, last run, next run and last error,
plus one-click retry for administrators. *Outcome: the team can see at a glance
that the overnight syncs ran, and fix anything that didn't without calling
support.*

**Proactive alerts.**
Automatic notification (email first) when a critical job fails — a sync, a
backup, a reconciliation — with sensible de-duplication so the team isn't
flooded. *Outcome: problems are known within minutes, not discovered days
later.*

---

## Horizon 2 — Next (July – August 2026)
### Theme: Transparency & data quality

**Transparent access control.**
A clear "why can / can't this user see this?" view for administrators, a
preview of a user's access before saving changes, and an exportable permission
matrix. *Outcome: access questions are answered in minutes, and changes are made
with confidence.*

**Data-quality monitoring.**
Automated nightly checks that surface duplicates, missing fields and
Sage-vs-Cardoso reconciliation mismatches, with trends and a simple "issues to
review" queue. *Outcome: data problems are caught and worked proactively rather
than discovered in a report.*

**Saved views.**
Let each user save their preferred report and reconciliation filters, with
optional shared team presets. *Outcome: faster day-to-day work; everyone lands
on the view they need.*

---

## Horizon 3 — Later (August – September 2026)
### Theme: Performance, safety & scale

**Performance monitoring.**
Visibility into how fast key screens and exports respond, so slow points are
identified and improved before they affect the team.

**Configuration safety.**
A safe, secret-redacted view of the system's configuration, with warnings for
risky combinations and clear "restart required" indicators — reducing the chance
of a configuration change causing an outage.

**Incident timeline.**
A single, time-ordered view of deploys, job events, alerts and manual actions,
so any issue can be understood and reviewed quickly.

---

## What success looks like (by end of horizon)

| Measure | Target |
|---|---|
| Reporting reconciliation to Sage | To the cent, across all depots |
| Undetected failed overnight jobs (older than 4 hours) | Near zero |
| Time to know about a critical failure | Under a few minutes |
| Time to resolve an access question | Under 2 minutes |
| Reconciliation exceptions older than 7 days | Reduced by ~25% |
| Response time on key screens | Improved and monitored |

---

## Delivery approach

- Short, regular release cycles (roughly every two weeks) with a tested rollback
  path on each.
- "Done" includes automated tests and reconciliation against Sage.
- Priorities reviewed with the business each cycle — this roadmap is a living
  plan, not a fixed contract.

---

*Cardoso · Confidential — prepared for the business.*
