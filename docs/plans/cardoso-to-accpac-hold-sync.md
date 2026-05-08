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

## Revisions (2026-05-08, after external audit)

Folded in from a code-review pass on the v1 plan:

- **Idempotency** — added a unique partial index on
  `pending_hold_actions(customer_number, connection_id)` filtered
  to `status IN ('queued', 'approved')`. Without it, a rule that
  evaluates per-record-on-sync would enqueue duplicate proposals
  every cycle and the queue would fill with noise.
- **Connection scoping** — `pending_hold_actions` now carries
  `connection_id` (and `site_id` on the hub variant). Same `IDCUST`
  text can mean different customers across two Sage instances; the
  queue keys must distinguish.
- **State-machine enforcement** — server-side `transitionStatus(from, to)`
  helper enforces the legal transitions
  (`queued → approved/rejected/expired → committed/failed_*`)
  instead of relying on a `CHECK(status IN ...)` constraint that
  would happily accept `committed → queued`.
- **Failure state taxonomy** — replaced the free-text `result`
  column with `failed_retryable` / `failed_terminal` enum values.
  Cleaner observability; alerts can fire on terminal-failure spikes
  separately from retryable ones.
- **Single-phase write gate via config** — Phase 2 ships the executor
  with `databaseconnection.can_write_hold = 0` on every connection
  by default. Going from "queue working but no writes" to "writes
  enabled on a test connection" is a config flip, not a re-release.
  Avoids two builds for one logical step.
- **Reconciliation as a real endpoint** — open question #5 (out-of-band
  Accpac changes) is now an explicit deliverable: a periodic report
  listing customers held in Accpac but not red in Cardoso (and vice
  versa). Operator triages.
- **Customer-exclusions ownership** — hub is authoritative for the
  central list (push-to-sites pattern, like `autoflagrule`). Sites
  can add local overrides flagged `source='local'`. Conflict
  resolution is the **union** of both: if either says "exclude,"
  the customer is excluded. Errs on the side of *not* taking action.
- **Write-path constraints (non-negotiable)** — added a dedicated
  contract section (further below) listing the eleven rules every
  Accpac write must satisfy: one field only (`SWHOLD`), one row at
  a time, parameterised SQL, dedicated helper with no escape hatch,
  pre/post verify SELECTs, per-write transactions, and a build-time
  SQL-shape assertion that fails the build if the queries ever
  drift. The contract turns "don't cause a bulk apocalypse" from a
  guard rail into a structural impossibility.

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

### Phase 2 — manual proposals only (executor gated by config)

- New table `pending_hold_actions(id, customer_number, connection_id,
  proposed_by, proposed_at, action, source, rule_id, reason, status,
  approved_by, committed_at, failure_reason)` — see the schema sketch
  below for the full shape including the unique partial index.
- New UI: "Propose hold in Accpac" button on red-flagged customer
  cards. Creates a `pending_hold_actions` row with `source='manual'`.
- New "Holds pending" panel — credit controller review screen. Shows
  proposed actions with the customer's reason, balance, last invoice,
  Cardoso flag history. Approve **attempts** to commit to
  `ARCUS.SWHOLD = 1`. Reject marks the row rejected; no Accpac write.
- The executor itself is **gated by `databaseconnection.can_write_hold`**.
  Default is 0 on every connection. The endpoint runs the executor,
  but every write checks the flag — when 0, the executor is a no-op
  that records `status='failed_terminal'` with reason "writes disabled
  on connection." That lets the queue + approval UX bake in
  production without any actual MSSQL writes happening, and turning
  on writes for a test connection is a config flip, not a code release.
- Auto-flag rules **do not** populate the queue yet.
- Every commit writes an `auditlog` row plus a `pending_hold_actions`
  status change. Server-side `transitionStatus(from, to)` helper
  enforces the legal state transitions
  (`queued → approved/rejected/expired → committed/failed_retryable/failed_terminal`).

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
5. ~~**Out-of-band changes?** A controller might hold in Accpac without
   Cardoso ever proposing it. The reverse-direction reconciliation
   handles this — but what's the UI surface so the operator sees that
   "Accpac is holding 5 customers Cardoso doesn't have flagged"?~~
   **Resolved (2026-05-08):** Phase 1 ships a
   `GET /api/hold-reconciliation` endpoint backing an admin panel
   that lists both directions of divergence. Operator triages from
   the panel — no automatic action either way.

## Write-path constraints (non-negotiable)

**Nothing about the Accpac write path is "guard rails." It is
structurally impossible to misuse.** A bug in the queue, a typo in
a rule, a sketchy SQL-injection attempt against the proposal API
— none of them can result in anything beyond `ARCUS.SWHOLD`
flipping on one row. There is no code path that would let it.

These rules are bake-in conditions. None of them are optional. Any
PR that touches the Accpac write surface gets reviewed against this
list and rejected if it weakens any of them.

1. **One field. Only `ARCUS.SWHOLD`.** No other column ever
   touched. The write helper takes a customer number and a hold
   value (1 or 0) — that's it. No "while we're at it" updates to
   `IDNATACCT`, `AMTCRLIMT`, or anything else, ever.

2. **One row at a time.** No `WHERE status = …`, no
   `WHERE IDCUST IN (...)`, no JOINs. Every commit is
   `WHERE IDCUST = @idcust` matching exactly one row. SQL Server's
   affected-row count must come back as 0 or 1 — anything else
   (impossible without code corruption, but checked anyway) is a
   hard abort recorded as `failed_terminal`, no retry.

3. **No rollups, no SELECT-then-UPDATE patterns.** The write is a
   single parameterised
   `UPDATE ARCUS SET SWHOLD = @hold WHERE IDCUST = @idcust`
   and nothing else. The pre/post verify SELECTs (rule #6 below) are
   separate statements, not part of a chained query.

4. **Static SQL string.** No string concatenation, no template-literal
   interpolation of values. Parameterised binding only. The SQL is
   a compile-time constant in the source file.

5. **Dedicated write-pool helper** (`customerSqlWritePool.js`)
   exposing exactly one function: `setHoldStatus(connectionId, idcust, hold01)`.
   No generic `query()`, no `executeRaw()`, no escape hatch. Misuse-
   resistant by API design — there is no other operation a caller
   could invoke even if they wanted to.

6. **Pre-flight verify.** Before the `UPDATE`, the helper runs
   `SELECT IDCUST, SWHOLD FROM ARCUS WHERE IDCUST = @idcust`.
   - 0 rows: abort, `failed_terminal`, no write.
   - >1 rows: abort, `failed_terminal`, no write. (Theoretically
     impossible since `IDCUST` is the PK, but checking is free.)
   - 1 row: capture the current `SWHOLD` value for the audit
     before/after.

7. **Post-write verify.** After the `UPDATE`, a second
   `SELECT SWHOLD FROM ARCUS WHERE IDCUST = @idcust` confirms the
   value committed correctly. Mismatch = `failed_terminal`, alert,
   no retry. (Catches the kind of trigger / replication weirdness
   that would otherwise silently revert the change.)

8. **Per-write transaction.** Each commit is its own transaction.
   No batching across proposals. If the operator approves 5
   proposals from a list, that's 5 independent transactions, one
   row each, in sequence — not one transaction touching 5 rows.
   Failures don't cascade; a single bad row doesn't abort the
   others.

9. **Build-time SQL-shape assertion.** A unit test that loads
   `customerSqlWritePool.js`, captures every SQL string the helper
   would emit, and asserts they match exactly:
   ```
   ^SELECT IDCUST, SWHOLD FROM ARCUS WHERE IDCUST = @idcust$
   ^UPDATE ARCUS SET SWHOLD = @hold WHERE IDCUST = @idcust$
   ^SELECT SWHOLD FROM ARCUS WHERE IDCUST = @idcust$
   ```
   The build fails if any string ever differs, even by whitespace.
   Catches an accidental "let's also update X" refactor at PR
   review time, not at production-incident time.

10. **No code path skips the helper.** Every call into MSSQL that
    might end up writing has to go through `setHoldStatus`. Direct
    use of `mssql` from anywhere else in the codebase to write to
    `ARCUS` is an automatic block at code-review. The write-pool
    helper is the only sanctioned door, full stop.

11. **`can_write_hold` checked inside the helper.** The flag is
    enforced at the lowest level — even if a caller bypasses the
    proposal queue and calls `setHoldStatus` directly,
    `can_write_hold = 0` returns `failed_terminal` without
    touching MSSQL. Defence in depth.

**Failure modes this contract eliminates:**

| Threat | Why it can't happen |
|---|---|
| Bulk update accidentally hits 200 customers | Rule #2 — affected_rows > 1 aborts |
| SQL injection via flag_reason or proposal note | Rule #4 — values are bound params, never concatenated |
| Future PR adds "while you're here, also update credit_limit" | Rule #9 — SQL-shape test fails the build |
| Trigger on `ARCUS` reverts the change silently | Rule #7 — post-write verify catches it |
| Caller skips the queue and writes directly via `mssql` | Rules #5 + #10 — no other code path can write |
| Dev forgets to flip `can_write_hold` and ships writes-on by default | Rule #11 — the helper itself enforces; default-off in schema |

If any future requirement seems to need relaxing one of these
rules, that's a strong signal the requirement should be redesigned,
not the contract weakened. The cost of these constraints is at most
a handful of extra lines of code; the cost of relaxing them is the
"bulk apocalypse" scenario this whole document exists to prevent.

## Schema changes required

Sketch only — don't act on these until each phase is approved. The
shape below incorporates the audit revisions (connection scoping,
unique partial index, failure-state enum, exclusions ownership).

```sql
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
  -- Which databaseconnection (= which Accpac instance) this proposal
  -- targets. Required so the same IDCUST text in two ledgers stays
  -- distinguishable, and so writes go through the can_write_hold
  -- gate of the right connection.
  connection_id INTEGER NOT NULL,
  action TEXT CHECK(action IN ('hold', 'release')) NOT NULL,
  source TEXT CHECK(source IN ('manual', 'rule')) NOT NULL,
  rule_id INTEGER,
  reason TEXT,
  status TEXT CHECK(status IN (
    'queued',
    'approved',
    'rejected',
    'committed',
    'expired',
    'failed_retryable',
    'failed_terminal'
  )) DEFAULT 'queued',
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  committed_at TEXT,
  not_before TEXT,
  -- failure_reason captures the describeSqlError-shaped message when
  -- status flips to failed_*. Operator-readable, no free-text result
  -- mixed in with success cases.
  failure_reason TEXT
);

-- Idempotency: at most one queued OR approved proposal per
-- (customer, connection, action) at a time. Without this, a rule
-- evaluating per-record-on-sync would enqueue duplicates every cycle.
CREATE UNIQUE INDEX idx_pending_hold_unique_active
  ON pending_hold_actions(customer_number, connection_id, action)
  WHERE status IN ('queued', 'approved');

CREATE INDEX idx_pending_hold_status ON pending_hold_actions(status, customer_number);

CREATE TABLE customer_exclusions (
  customer_number TEXT NOT NULL,
  -- 'hub' = pushed from the central list (read-only at sites);
  -- 'local' = added at the site as a local override. Both apply
  -- (exclusion union — if either says exclude, the customer is excluded).
  source TEXT CHECK(source IN ('hub', 'local')) NOT NULL,
  reason TEXT,
  added_by TEXT,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_number, source)
);
```

## Implementation surface (ordered by phase)

- **Phase 1**: `syncEngine.js` (extend ARCUS SELECT to include
  `SWHOLD`), `schema.js` + migration, `HubDashboard.jsx` + customer
  card components (display + divergence indicator). Add
  reconciliation report endpoint
  `GET /api/hold-reconciliation` returning two arrays:
  `held_in_accpac_not_red_in_cardoso[]` and `red_in_cardoso_not_held[]`.
  Backs an admin "Hold reconciliation" panel.
- **Phase 2**: new `holdProposal.js` service with the
  `transitionStatus(from, to)` state-machine helper and the
  `enqueueProposal(customer, connection, …)` helper that respects
  the unique partial index (returns the existing row instead of
  failing on duplicate). New routes
  `POST /api/hold-proposals` (create), `GET /api/hold-proposals` (list),
  `POST /api/hold-proposals/:id/approve`, `POST /api/hold-proposals/:id/reject`.
  New `pending-holds-panel` component for credit controllers.
  First MSSQL write path — new write-capable pool helper next to
  `customerSqlPool.js` (read-only), with the executor checking
  `databaseconnection.can_write_hold = 1` and recording
  `failed_terminal` when the flag is off. The flag is the gate that
  separates "queue working in production" from "writes happening to
  Accpac" — flipping it for one test connection is the live-fire
  test, not a separate code release.
- **Phase 3**: extend `applyAutoFlagRulesToRecord` to also create
  `pending_hold_actions` rows when an eligible auto-red is set.
  `enqueueProposal` makes this safe — duplicate-suppressing by
  construction.
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
| Customer should never be held but rule keeps proposing | `customer_exclusions` (hub-pushed + site-local, exclusion-union) + per-record `never_auto_hold` |
| Rule re-evaluation enqueues duplicate proposals | Unique partial index on `(customer_number, connection_id, action) WHERE status IN ('queued','approved')` — `enqueueProposal` returns the existing row instead of inserting a duplicate |
| Write fails mid-batch and operator can't tell why | `failed_retryable` / `failed_terminal` enum + `failure_reason` text + per-state alert thresholds; terminal failures fire alerts via `alertRules.js` |
| Multi-Sage site has same `IDCUST` across ledgers | `connection_id` mandatory on every queue + audit row; UI shows the connection name next to each proposal |

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
