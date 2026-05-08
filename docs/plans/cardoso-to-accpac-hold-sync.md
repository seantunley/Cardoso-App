# Cardoso → Accpac on-hold sync — design plan

Today the integration between Cardoso and Accpac/Sage 300 is **read-only**.
Cardoso pulls customer data into `datarecord` and operators flag customers
red/orange/green. Nothing Cardoso decides is ever written back to
`ARCUS`.

The proposal here is to extend that integration in two directions:

1. **Cardoso → Accpac**: when Cardoso flags a customer red, the customer
   should be put on credit hold in Accpac (`ARCUS.SWHOLD = 1`).
2. **Accpac → Cardoso**: when the credit controller un-holds in Accpac,
   Cardoso should reflect that — without losing the auto-flag rule's
   verdict.

This is the first feature that would have Cardoso writing to Accpac.
Done badly, it's a bulk apocalypse: a rule fires across hundreds of
accounts overnight, sales teams scream, controllers manually reverse
it, trust evaporates. This document lays out the guard rails so the
feature can ship without that being a likely outcome.

## Core principle

**Cardoso proposes, Accpac disposes.**

Every existing safety pattern in this codebase is for things that stay
inside Cardoso. Making Cardoso the unilateral writer of `ARCUS.SWHOLD`
is a brand-new failure surface. The model that survives is one where
Cardoso never writes `SWHOLD` directly when a flag goes red — it
creates a *proposed* hold action that requires explicit approval (or
auto-approval only under tight conditions the operator sets), with a
queue, a dry-run preview, and a hard cap.

The credit-logic publish-then-push flow is the same shape: hub
publishes an intermediate state, sites pull and apply
([creditLogic.js publish/push](../../src/routes/creditLogic.js)).
Reuse the pattern — except the "publish" step is now "queue a hold
action."

## What exists today

- **Flag schema**: `datarecord.flag_color`, `flag_reason`,
  `flag_created_by`, `flag_source`, `auto_flagged`. Manual flags leave
  `flag_source = NULL`; auto-flag rules set `flag_source = 'auto'`.
  ([schema.js:58-68](../../src/db/schema.js#L58-L68))
- **Auto-flag rules**: `autoflagrule` table. Evaluator
  `applyAutoFlagRulesToRecord()` runs per-record, never overwrites
  manual flags. Bulk sweep via `/api/apply-auto-flags`.
- **Auto-flags persist** until explicitly cleared via "Clear Auto
  Flags" button. They do *not* auto-clear when conditions stop
  matching. This is important — it makes the loop hazard discussed
  below tractable.
- **No write path to Accpac exists.** `customerSqlPool` is read-only
  by construction; routes only `SELECT` from `ARCUS`.
- **Audit log captures before/after** in `auditlog.changes` JSON. No
  undo, but full history.
- **No dry-run for flag operations.** The dedupe routes have a
  `dryRun` param to model from.
- **Hub→site write endpoints** that already exist:
  `/api/hub/receive-credit-logic`, `/api/hub/receive-rules`,
  `/api/hub/receive-users`, `/api/hub/trigger-accpac-sync` (PR #198).
  All are token-gated.

## Phased rollout

The phasing here is the most important guard rail. Each phase ships
on its own; the one after only starts once the previous has run a few
weeks without surprises.

### Phase 1 — read `SWHOLD` only (zero writes)

- Extend the existing customer queries to pull `ARCUS.SWHOLD`.
- Store on `datarecord` as `accpac_on_hold INTEGER`.
- Surface on the customer card: *"Accpac says: on hold"* / *"clear"*.
- Surface **divergence** as a coloured indicator: Cardoso red but
  Accpac clear → ⚠ icon "Accpac unheld — Cardoso flag still red,
  review."

This phase is purely additive and reversible. Operators get used to
seeing the two values side by side for a week or two before any
write capability turns on.

### Phase 2 — manual proposals only

- New table `pending_hold_actions(id, customer_number, proposed_by,
  proposed_at, action ('hold'|'release'), source ('manual'|'rule'),
  rule_id, reason, status ('queued'|'approved'|'rejected'|'committed'|'expired'),
  approved_by, committed_at)`.
- New UI: "Propose hold in Accpac" button on red-flagged customer
  cards. Creates a `pending_hold_actions` row with `source='manual'`.
- New "Holds pending" panel — credit controller review screen. Shows
  proposed actions with the customer's reason, balance, last invoice,
  Cardoso flag history. Approve commits to `ARCUS.SWHOLD = 1`. Reject
  marks the row rejected; no Accpac write.
- Auto-flag rules **do not** populate the queue yet.
- Every commit writes an `auditlog` row plus a `pending_hold_actions`
  status change.

This phase introduces the write path under maximum human supervision.
Bake for at least two weeks. The point is to discover edge cases
(weird `IDCUST` formats, multi-branch customers, MSSQL permission
issues, controller workflow friction) before automating anything.

### Phase 3 — auto-propose with cap

- Auto-flag rules now populate `pending_hold_actions` with
  `source='rule'`, but **never auto-commit**.
- The cap + dry-run preview means a controller still reviews the
  batch.
- Eligibility filters apply at this stage (see "Guard rails" below).

This is the steady state for most operators. Phase 4 may never
arrive.

### Phase 4 (maybe never) — auto-commit for narrow cases

Only after months of Phase 3 data showing operators always approve.
Even then, auto-commit only for explicitly-tagged "high confidence"
rules with the per-day cap still in place. The default is always
"queue, don't commit."

## Guard rails

These apply from Phase 2 onwards. Each one is independently
configurable so the operator can tune without code changes.

### 1. Eligibility filter

Only customers matching ALL of these qualify for a proposed hold:

- `flag_color = 'red'`
- `flag_source = 'auto'` (manual reds need a human to also click
  "Propose hold")
- The red flag is at least **N hours old** (default 24h). Brand-new
  reds get a chance to clear themselves on the next sync.
- `accpac_on_hold` is currently 0 (don't propose holding a customer
  who's already held).
- Customer is not on the exclusion list (see #6).

### 2. Bulk cap with explicit override

- Per-batch cap: 5 customers per UI confirmation.
- Per-day cap: 25 per site (configurable).
- If a rule change would propose more than the per-day cap, the
  excess gets `status='queued'` with a `not_before` timestamp set to
  the next day. No "fire and forget."
- Hitting the per-day cap fires a `security-signals`-style alert via
  `alertRules.js` so the operator notices.

### 3. Dry-run preview by default

- The proposal endpoint runs in `dryRun: true` mode unless explicitly
  committed — same param the dedupe routes use ([routes/hub.js dryRun](../../src/routes/hub.js)).
- UI shows: customer list, proposed before/after `SWHOLD`, the rule
  that triggered each (if `source='rule'`), the operator's last 3
  actions on this customer (so a "this is the third time we've
  held them this month" pattern is visible).
- Two-click commit. First click shows the preview, second click
  writes.

### 4. Audit linkage

Every write to `ARCUS.SWHOLD` carries a Cardoso-side audit row with:

- `actor`: the user email (or `system:rule:<rule_id>` for autocommit)
- `flag_reason` at time of action
- prior `SWHOLD` value (for reversal)
- the `pending_hold_actions.id` so the queue and the audit linelink

Audit rows are append-only — reversal is a *new* audited action, not
a silent overwrite.

### 5. Allow-list of connections

- New column `databaseconnection.can_write_hold INTEGER DEFAULT 0`.
- Writes only happen against connections explicitly tagged with this
  flag set to 1.
- A site without it set silently skips proposals for that connection.
- Setting the flag is itself an admin action with an audit row.

This means a junior install or a freshly-onboarded site doesn't
accidentally start writing. The first write requires a deliberate
operator decision.

### 6. Exclusion list

Some customers should never be auto-held — VIPs, internal accounts,
key suppliers paid via offset. Two layers:

- `datarecord.never_auto_hold INTEGER` (per-customer per-site).
  Set via UI checkbox on the customer card.
- A central `customer_exclusions` table that takes precedence (so the
  hub can manage it across sites).

Manual proposals can still target excluded customers — the operator
is making a deliberate decision. Auto-flag rules cannot.

### 7. Rate-limit on the write itself

Even after all the above passes, a hard global per-day cap on
`SWHOLD` writes per site (e.g. 50). If exceeded, fall through to
"queued for tomorrow" and fire an alert. This is the seatbelt
under the airbag — the cap should never be hit in normal operation.

## The reverse direction (Accpac → Cardoso)

Phase 1 already covers the read. The harder question is what Cardoso
does when `accpac_on_hold` flips from 1→0.

**Recommendation: do nothing automatically. Surface the divergence
loudly.**

When `accpac_on_hold = 0` but `flag_color = 'red'` is still set in
Cardoso:

- Show a divergence indicator on the customer card.
- Don't auto-clear the Cardoso flag.
- A "Reconcile" button on the card that prompts: *"Accpac unheld this
  customer 3 days ago. Clear the red flag?"* — with options for
  "Clear flag", "Keep flag, dismiss notice", or "Re-propose hold."

Why no automatic clear:
- Cardoso's red flag means *"this customer has problems we should look
  at."* Accpac removing the hold means *"credit control let them trade
  again."* Those are not the same statement.
- Auto-clearing the red flag would let the auto-flag rule fire *again*
  on the next evaluation tick if the underlying conditions still match
  (high outstanding, overdue invoices, etc.). That's a loop. Cardoso
  proposes hold → Accpac holds → controller un-holds → Cardoso clears
  flag → rule re-fires red → Cardoso proposes hold again. Hard to
  break, easy to mass-trigger.
- The auto-flag rule engine doesn't auto-clear flags today, so leaving
  this gap aligns with existing semantics.

The divergence indicator gives the operator the information; the
operator makes the call.

## Open questions to settle before any code lands

1. **Who is the SQL Server identity for hold writes?** A dedicated
   service account (`cardoso-app@<site>`) is more useful than `sa` —
   audit rows in Accpac will then say which app did it.
2. **What's the SLA for clearing a hold?** If a customer pays and the
   controller un-holds in Accpac, how soon does Cardoso need to reflect
   that? Sets the sync cadence and informs whether divergence
   indicators are necessary or just nice-to-have.
3. **Multi-site customers?** If the same `IDCUST` appears across two
   sites' Accpacs (separate ledgers), does a hold at one site imply
   hold at the other? Probably not — but worth confirming.
4. **What does "hold release" mean?** Does Cardoso ever release a
   hold (via the proposal queue), or only ever propose new holds?
   Symmetry says yes, operator preference says we'd want to keep this
   manual-only forever.
5. **Out-of-band changes?** A controller might hold in Accpac without
   Cardoso ever proposing it. The reverse-direction reconciliation
   handles this — but what's the UI surface so the operator sees that
   "Accpac is holding 5 customers Cardoso doesn't have flagged"?

## Schema changes required

Sketch only — don't act on these until each phase is approved.

```
-- Phase 1
ALTER TABLE datarecord ADD COLUMN accpac_on_hold INTEGER DEFAULT 0;
ALTER TABLE datarecord ADD COLUMN accpac_on_hold_synced_at TEXT;

-- Phase 2
ALTER TABLE databaseconnection ADD COLUMN can_write_hold INTEGER DEFAULT 0;
ALTER TABLE datarecord ADD COLUMN never_auto_hold INTEGER DEFAULT 0;

CREATE TABLE pending_hold_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number TEXT NOT NULL,
  customer_name TEXT,
  action TEXT CHECK(action IN ('hold', 'release')) NOT NULL,
  source TEXT CHECK(source IN ('manual', 'rule')) NOT NULL,
  rule_id INTEGER,
  reason TEXT,
  status TEXT CHECK(status IN ('queued','approved','rejected','committed','expired')) DEFAULT 'queued',
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  committed_at TEXT,
  not_before TEXT,
  result TEXT
);
CREATE INDEX idx_pending_hold_status ON pending_hold_actions(status, customer_number);

CREATE TABLE customer_exclusions (
  customer_number TEXT PRIMARY KEY,
  reason TEXT,
  added_by TEXT,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## Implementation surface (ordered by phase)

- **Phase 1**: `syncEngine.js` (extend ARCUS SELECT), `schema.js`/migration,
  `HubDashboard.jsx` + customer card components (display + divergence
  indicator).
- **Phase 2**: new `holdProposal.js` service, new routes
  `POST /api/hold-proposals` (create), `GET /api/hold-proposals` (list),
  `POST /api/hold-proposals/:id/approve`, `POST /api/hold-proposals/:id/reject`.
  New `pending-holds-panel` component for credit controllers.
  First MSSQL write path — needs a write-capable pool helper next to
  `customerSqlPool.js` (read-only) with explicit `can_write_hold`
  gating.
- **Phase 3**: extend `applyAutoFlagRulesToRecord` to also create
  `pending_hold_actions` rows when an eligible auto-red is set.
- **Phase 4** (if ever): config flag per rule (`auto_commit_hold`),
  scheduler job that commits queued holds nightly.

## Risk register

| Risk | Mitigation |
|---|---|
| Bulk-fire from rule change holds 200 customers overnight | Per-day cap (#2), proposals are queued not committed (Phases 2-3) |
| Auto-flag → hold → controller releases → flag re-fires loop | No auto-clear of flag on Accpac release; divergence indicator instead |
| Wrong customer held due to `IDCUST` matching bug | Two-click commit + dry-run preview; reversal is one button click |
| MSSQL permission issue on first write | Allow-list at connection level (#5); first write requires explicit operator action |
| Audit can't tell why a hold was placed | Every commit writes both `pending_hold_actions` row and `auditlog` row with `flag_reason` and rule_id |
| Hold released in Accpac out-of-band | Reverse-direction reconciliation surfaces it; operator decides |
| Customer should never be held but rule keeps proposing | `customer_exclusions` table + per-record `never_auto_hold` |

## What this plan deliberately doesn't cover

- **Releases via Cardoso.** Phase 2 is hold-only; releases stay
  manual in Accpac for now. Symmetry is appealing but the same loop
  hazard applies and the operator's mental model right now is
  "Cardoso flags, controller decides." Don't change that without a
  separate plan.
- **Notification to customers.** A held customer probably wants to
  know they're held. Out of scope here — that's a CRM/comms problem.
- **Other ARCUS columns.** Credit limit, payment terms, etc. Same
  proposal-queue architecture would work for those, but each has its
  own approval semantics. One column at a time.

## Decisions needed from Sean before implementation starts

1. Sign-off on the **proposal queue model** (Cardoso never writes
   `SWHOLD` without a queued + approved action). The alternative —
   direct write when a flag goes red — should be rejected with this
   document.
2. Initial **threshold values** for the caps: per-batch (5?), per-day
   (25?), red-flag age before eligible (24h?).
3. Which **Accpac SQL identity** the hold-writer uses. Existing
   read-only account or a new dedicated one.
4. Whether **release-via-Cardoso** is in scope at all, or strictly
   "Cardoso never releases."

Once those are settled, Phase 1 is ~3-4 days. Phase 2 is ~2 weeks
including UI. Phase 3 is ~3 days on top of Phase 2. Phase 4, if
ever, is ~1 week.
