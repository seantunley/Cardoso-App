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
  contract section (further below) listing the rules every
  Accpac write must satisfy: one field only (`SWHOLD`), one row at
  a time, parameterised SQL, dedicated helper with no escape hatch,
  pre/post verify SELECTs, per-write transactions, and a build-time
  SQL-shape assertion that fails the build if the queries ever
  drift. The contract turns "don't cause a bulk apocalypse" from a
  guard rail into a structural impossibility.
- **Hold-only invariant (policy, not just default)** — Cardoso
  *never* releases a hold. Off-hold/release is always a manual
  action by the credit controller in Accpac. The schema, the
  helper, and the boot path all enforce this — `'release'` is
  stripped from the `action` enum, `setHoldStatus` rejects any
  call with `hold !== 1`, and a boot-time assertion refuses to
  start if a future config edit tries to enable it. Making this
  permanent (rather than a Phase 2 deferral) eliminates the
  Cardoso-releases → rule-re-fires → re-proposes loop entirely.
- **Alert thresholds + SLOs** — explicit numbers for when
  `failed_terminal` and reconciliation drift should fire alerts
  via the existing `alertRules.js` engine. Phase-1 baselines
  inform the calibration; placeholders captured in the plan.
- **Duplicate-proposal UX** — the unique partial index throws on
  duplicate insert; the create endpoint translates that into
  three structured 409 responses ("already queued", "already
  approved, awaiting commit", "already committed in last N hours")
  with a deep-link to the existing proposal. Not an error — the
  existing row IS the right answer, the operator just needs to
  see it.
- **Incident runbook** — a dedicated section at the end of the
  plan that an operator can find in 5 seconds when something is
  going wrong. Disable, revert, investigate.

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

12. **Hold-only invariant — Cardoso NEVER releases.**
    `setHoldStatus(connectionId, idcust, hold)` rejects any call
    with `hold !== 1`. There is no code path that can take
    `SWHOLD` from 1 back to 0; release is strictly an Accpac-side
    action by the credit controller, using information Cardoso
    doesn't have (phone calls, payment promises, manager
    overrides). The schema's `action` enum is `'hold'` only —
    `'release'` is not a valid value. A boot-time assertion
    refuses to start if anyone has flipped
    `bat_settings.accpac_writes_release_allowed` to `'true'`,
    forcing a deliberate code change rather than a config-only
    toggle. This makes the Cardoso-releases → rule-re-fires →
    re-proposes loop hazard structurally impossible, not merely
    "unlikely under current rules."

**Failure modes this contract eliminates:**

| Threat | Why it can't happen |
|---|---|
| Bulk update accidentally hits 200 customers | Rule #2 — affected_rows > 1 aborts |
| SQL injection via flag_reason or proposal note | Rule #4 — values are bound params, never concatenated |
| Future PR adds "while you're here, also update credit_limit" | Rule #9 — SQL-shape test fails the build |
| Trigger on `ARCUS` reverts the change silently | Rule #7 — post-write verify catches it |
| Caller skips the queue and writes directly via `mssql` | Rules #5 + #10 — no other code path can write |
| Dev forgets to flip `can_write_hold` and ships writes-on by default | Rule #11 — the helper itself enforces; default-off in schema |
| Future PR adds a "release via Cardoso" button or auto-release logic | Rule #12 — `setHoldStatus(hold !== 1)` throws, `action` enum has no `'release'`, boot assertion refuses to start with the release-allowed flag flipped |

If any future requirement seems to need relaxing one of these
rules, that's a strong signal the requirement should be redesigned,
not the contract weakened. The cost of these constraints is at most
a handful of extra lines of code; the cost of relaxing them is the
"bulk apocalypse" scenario this whole document exists to prevent.

## Master enable switch (Settings → Accpac integration)

In addition to the per-connection `can_write_hold` flag (rule #11
in the constraints above), the entire Accpac write functionality is
gated by a **single global on/off switch** in Settings. Default off.
A site running this build with the switch off behaves exactly like
a read-only install — no UI, no endpoints reachable, no executor
loaded, no risk.

The switch is the operator's "I have read the docs and understand
what enabling this does" gesture. Without it, none of the Phase 2+
features are accessible regardless of how the queue or per-connection
flags are configured.

### Storage

```sql
-- bat_settings is already the de-facto site-config k/v store
-- (ocr_paused, sage_connection_id, invoice_in_digit_length, ...).
-- Adding the master switch as another row keeps the surface area
-- small.
INSERT OR IGNORE INTO bat_settings (key, value)
  VALUES ('accpac_write_enabled', 'false');
```

The setting is read at the top of every write-path entry point
— the proposal-create endpoint, the approve endpoint, the executor
itself. If `'false'`, the endpoints respond `403 Forbidden` with a
specific message ("Accpac write functionality is disabled. Enable
in Settings → Accpac integration."); the executor short-circuits
to `failed_terminal` with the same reason.

### UI flow (admin-only)

The toggle lives in **Settings → Accpac integration** (a new tab,
admin-only, hub-mode-aware so it appears on sites only). Layout:

- Big red banner across the top of the section explaining what
  enabling does in plain language: *"Enabling this allows Cardoso
  to write back to Accpac. Currently the only field Cardoso writes
  is `ARCUS.SWHOLD` (credit hold), and only via the proposal queue
  with manual approval. Enabling does not auto-fire any holds —
  it just unlocks the queue + approval flow."*
- Current state pill: **DISABLED** (green/safe-looking) or
  **ENABLED — Cardoso can write to Accpac** (amber/attention).
- Last-changed line: *"Disabled by sean@…on 2026-05-08 14:32"* or
  *"Enabled by sean@… on …"* — sourced from the audit log.

### Enabling — double confirmation + password re-entry

Clicking "Enable" opens a modal with three blocking steps:

1. **Warning** — full prose:
   > Enabling Accpac writes lets Cardoso modify the `ARCUS.SWHOLD`
   > column in your Accpac database. Holds proposed by Cardoso
   > rules will be queued for credit-controller approval before
   > anything is written. No automatic writes. No other Accpac
   > columns are touched. **You can disable this at any time and
   > all queued proposals stop committing immediately.**
   >
   > A misconfigured rule, a tester forgetting to set
   > `can_write_hold = 0` on a real connection, or a bug in the
   > queue could in principle cause customer accounts to be put
   > on hold. The constraints in [docs/plans/cardoso-to-accpac-hold-sync.md](./cardoso-to-accpac-hold-sync.md)
   > make every one of those scenarios structurally hard, but
   > nothing replaces operator vigilance.
   >
   > **Type your password below to confirm you are an
   > authorised administrator and you understand the above.**

2. **Password re-entry** — the operator types their own user
   account's password into a regular password input. Server
   verifies via `bcrypt.compare` against `user.password_hash`
   (same path as `/api/auth/login`). Wrong password = no enable,
   no setting written.

3. **Final confirm button** — labelled `Enable Accpac writes` (not
   "OK" or "Confirm" — the button text restates the action).
   Click flips the bat_settings row to `'true'`.

The endpoint that flips the flag (`POST /api/system/accpac-writes/enable`)
itself requires:
- `requireAuth` + `requireAdmin` middleware.
- A re-verified password in the request body, server-checked.
- Logs an `auditlog` row with `action: 'accpac_writes_enabled'` and
  the actor's email, IP, and timestamp.

### Disabling

Disabling is a single click — no warning, no password. The whole
point is that turning it off should be friction-free:

- Operator clicks "Disable Accpac writes."
- Server sets `bat_settings.accpac_write_enabled = 'false'`.
- Audit row written.
- Any in-flight `committed → failed_terminal` transitions
  complete (the executor checks the flag before each write — so
  if the flag flipped mid-batch, subsequent writes simply don't
  happen).
- A green badge on Operations → Alerts says "Accpac writes
  disabled — N proposals still in queue, will commit when
  re-enabled" so nothing is silently lost.

The asymmetry is deliberate: enabling is a deliberate action with
ceremony; disabling is the emergency stop and stays that way.

### Defence-in-depth ordering

When a write is attempted, the gates fire in this order. Failing
any one returns `failed_terminal` with the specific reason — they
don't cascade silently:

1. **Master switch** (`bat_settings.accpac_write_enabled = 'true'`)
   — set via Settings UI with password re-entry.
2. **Per-connection flag** (`databaseconnection.can_write_hold = 1`)
   — set via the Connections settings, audit-logged.
3. **Proposal status** — must be `approved`, not `queued` or
   `rejected`.
4. **Eligibility filter** (auto-flag age, exclusion list, etc.)
   — checked at enqueue time AND at commit time, since state can
   change in between.
5. **Pre-flight verify SELECT** — the row must exist, return one
   row, with a captured before-value.
6. **Executor write** — the `UPDATE ARCUS SET SWHOLD ...` only
   runs after every gate above passes.
7. **Post-write verify SELECT** — the row's `SWHOLD` must equal
   what was set.

That's seven independent checks for what is, technically, a single
field flip. The cost is a handful of milliseconds and a few extra
lines of code. The benefit is that no plausible failure mode
results in unintended writes.

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

-- Master enable switch (see Master enable switch section).
INSERT OR IGNORE INTO bat_settings (key, value) VALUES ('accpac_write_enabled', 'false');

-- Hold-only invariant policy flag. Default 'false'. The boot path
-- asserts this stays 'false' — a future operator who edits
-- bat_settings directly to flip it gets a refused boot, not a
-- silent feature unlock. Forces the deliberate code change route.
INSERT OR IGNORE INTO bat_settings (key, value) VALUES ('accpac_writes_release_allowed', 'false');

CREATE TABLE pending_hold_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number TEXT NOT NULL,
  customer_name TEXT,
  -- Which databaseconnection (= which Accpac instance) this proposal
  -- targets. Required so the same IDCUST text in two ledgers stays
  -- distinguishable, and so writes go through the can_write_hold
  -- gate of the right connection.
  connection_id INTEGER NOT NULL,
  -- Hold-only by design. The 'release' action is INTENTIONALLY
  -- absent — see Write-path constraints rule #12. Release is
  -- always done by the controller in Accpac directly.
  action TEXT CHECK(action = 'hold') NOT NULL DEFAULT 'hold',
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

## Alert thresholds & SLOs

Wires into the existing `alertRules.js` engine — same engine that
handles `sage-down`, `backup-verify-failed`, `job-failure-spike`,
and `security-signals`. Each rule fires/resolves as a row in the
`alerts` table with a dedup key, so a single ongoing problem
produces one active alert, not a stream.

Thresholds below are **placeholders** — the right numbers depend
on what "normal" looks like once Phase 1 has been running for
a couple of weeks. The plan ships with these values; we calibrate
after baseline.

### Rule: `accpac-hold.terminal-failure-spike`

Fires when commits to `ARCUS.SWHOLD` are failing terminally at a
rate that suggests something systemic is broken (wrong credentials,
schema drift on the Accpac side, blocked SQL Server login, etc.).

| Severity | Condition (per connection, in 1h window) | Dedup key |
|---|---|---|
| `warning`  | ≥ 3 `failed_terminal` in the last hour | `accpac-hold-terminal:{connection_id}` |
| `critical` | ≥ 10 `failed_terminal` in the last hour | (same — replaces the warning) |

Resolves automatically when there are no terminal failures for
that connection in the last hour. Per-connection dedup so one
sick connection doesn't drown out signals from healthy ones.

### Rule: `accpac-hold.retryable-failure-stuck`

`failed_retryable` rows are eligible for re-evaluation on the next
executor tick. Fires when a row stays in `failed_retryable` for
longer than the retry budget — i.e. retry isn't helping.

| Severity | Condition | Dedup key |
|---|---|---|
| `warning` | Any proposal in `failed_retryable` for > 6 hours | `accpac-hold-retryable-stuck:{customer_number}:{connection_id}` |

Resolves when the row transitions to `committed` or `failed_terminal`.

### Rule: `accpac-hold.reconciliation-drift`

Reads from the new `GET /api/hold-reconciliation` endpoint.
Counts customers in either direction of divergence:

- `held_in_accpac_not_red_in_cardoso` — Accpac has them held;
  Cardoso doesn't show red. May indicate manual Accpac action
  Cardoso isn't aware of, or stale Cardoso flag data.
- `red_in_cardoso_not_held` — Cardoso shows red; Accpac isn't
  holding. Either Cardoso hasn't proposed yet, the controller
  rejected, or the controller released without un-flagging.

| Severity | Condition (sustained > 24h) | Dedup key |
|---|---|---|
| `warning` | Drift count > 5% of red-flagged customers | `accpac-hold-drift:high` |
| `critical` | Drift count > 15% of red-flagged customers | (same — replaces warning) |

The 24h sustain matters because some divergence is normal
mid-day (operator hasn't approved a queued proposal yet, controller
just released a customer this morning). Only a persistent drift
indicates a workflow problem.

### Rule: `accpac-hold.queue-backlog`

Fires when the proposal queue is filling up faster than the
controller is approving. Catches "operator went on holiday and
nobody else picked up the queue" as well as "auto-flag rules went
haywire."

| Severity | Condition | Dedup key |
|---|---|---|
| `warning` | > 50 proposals in `queued` status, oldest > 48h old | `accpac-hold-backlog:warning` |
| `critical` | > 200 proposals in `queued` status, oldest > 7 days | `accpac-hold-backlog:critical` |

Resolves when both conditions are below thresholds.

### SLO targets (once baseline is established)

These are the numbers we should be hitting in steady state. Phase
1 + early Phase 2 will tell us if they're realistic.

- **Time-to-commit** (proposal `queued` → `committed`): median ≤ 4 business hours, p99 ≤ 24 business hours.
- **Terminal failure rate**: ≤ 1% of commit attempts. Higher than that means a connection is unhealthy.
- **Reconciliation drift**: ≤ 5% of red-flagged customers, sustained.
- **Time-to-revert after disable**: ≤ 30 seconds from clicking Disable to the next executor tick refusing writes. (The executor reads the master switch on every commit attempt, not at boot.)

## Duplicate-proposal UX

The unique partial index on `pending_hold_actions(customer_number,
connection_id, action) WHERE status IN ('queued', 'approved')`
prevents duplicate active proposals at the database level — but
the create endpoint MUST translate that constraint violation into
operator-readable feedback, not a generic 500.

When a caller (UI button, auto-flag rule, programmatic API client)
tries to enqueue a proposal that would violate the index, the
endpoint returns `409 Conflict` with a structured body. The body
distinguishes three cases so the operator knows which:

```json
// Case 1 — already queued
{
  "ok": false,
  "code": "duplicate_queued",
  "message": "Hold proposal for IDCUST=12345 is already queued (proposed by jane@cardoso.local on 2026-05-08 10:14). Open the queue to review or approve it.",
  "existing_proposal": { "id": 42, "status": "queued", "proposed_by": "...", "proposed_at": "...", "queue_url": "/operations/holds#proposal-42" }
}

// Case 2 — already approved, awaiting commit
{
  "ok": false,
  "code": "duplicate_approved",
  "message": "Hold for IDCUST=12345 has been approved by mark@cardoso.local and will commit on the next executor tick (within 5 min). Disable the master switch to halt.",
  "existing_proposal": { "id": 42, "status": "approved", ... }
}

// Case 3 — already committed in last N hours (default 24h)
{
  "ok": false,
  "code": "duplicate_recently_committed",
  "message": "IDCUST=12345 was already put on hold 3 hours ago (proposal #42 by mark@cardoso.local). The controller must release in Accpac first if a new hold is needed.",
  "existing_proposal": { "id": 42, "status": "committed", "committed_at": "...", ... }
}
```

UI surfacing:
- Button click that hits a `409 duplicate_*`: toast with the message
  string and a "Go to queue" link if `queue_url` is present.
  No red destructive treatment — these aren't errors, they're
  *the existing proposal IS the right answer*.
- Auto-flag rule path that hits a 409: silent success (the rule's
  intent — "this customer should be held" — is already represented
  by the existing proposal). No log spam, but the duplicate
  attempt count is tracked so we can detect a misbehaving rule
  via the `accpac-hold.terminal-failure-spike` style rule.

The point is that duplicate suppression is a **success state**
for the system, not a failure.

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
4. ~~Whether **release-via-Cardoso** is in scope at all, or strictly
   "Cardoso never releases."~~
   **Resolved (2026-05-08):** Cardoso *never* releases. Encoded as
   the hold-only invariant (rule #12 in Write-path constraints).
   Schema, helper, and boot-time assertion all enforce it.

Once those are settled, Phase 1 is ~3-4 days. Phase 2 is ~2 weeks
including UI. Phase 3 is ~3 days on top of Phase 2. Phase 4, if
ever, is ~1 week.

## Incident runbook

When something is going wrong — operator sees customers being held
who shouldn't be, controllers complaining, queue acting weird — this
is the section to read first. Each scenario has a 30-second action
followed by triage.

### Symptom: customers are being put on hold incorrectly

**Stop the bleeding (≤ 30 seconds):**

1. **Settings → Accpac integration → Disable.** Single click.
2. Confirm the state pill flips to **DISABLED**.
3. Within 30 seconds the executor reads the flag on its next tick
   and refuses any further commits.

That's it for the immediate stop. No more `ARCUS.SWHOLD` writes
will happen until you re-enable, regardless of what the queue
contains.

**Revert the bad commits:**

1. Open Operations → Audit log, filter on `action = 'accpac_hold_committed'`.
2. Each committed proposal has a row with the customer's `IDCUST`
   and the prior `SWHOLD` value (captured by the pre-flight verify).
3. SQL on the affected Accpac to revert — manual, deliberate:
   ```sql
   UPDATE ARCUS SET SWHOLD = 0 WHERE IDCUST IN ('IDCUST1', 'IDCUST2', ...);
   ```
   …with the list pulled from the audit. **Do not script this from
   the proposal queue's `committed` list directly** — eyeball-verify
   first.
4. Cardoso sees the new `SWHOLD = 0` on the next sync and the
   reconciliation report shows the divergence ("held in Cardoso's
   record, not held in Accpac").

**Stop the offending rule from re-queueing:**

1. Settings → Auto-Flag Rules → find the rule that fired the bad
   proposals.
2. Toggle `is_active = 0`.
3. Now even if you re-enable Accpac writes, that rule won't queue
   new proposals.

**Investigate, then re-enable:**

1. Use the audit log + `pending_hold_actions.reason` to understand
   what triggered the rule.
2. Fix the rule conditions OR fix the underlying data OR add the
   affected customers to `customer_exclusions`.
3. Settings → Accpac integration → Enable (with password re-entry).

### Symptom: queue full of stale proposals after an outage

If the executor was down or `can_write_hold` was off for a while,
proposals can pile up in `queued`/`approved` but never commit.
Once you turn writes back on, you don't necessarily want a flood.

1. Operations → Holds pending. Sort by `not_before` ascending.
2. Bulk-expire endpoint: `POST /api/hold-proposals/expire-stale`
   takes a `before_iso` cutoff. Flips all `queued` rows older than
   that to `expired`. Audit-logged.
3. The remaining proposals are recent enough that the controller
   should review them individually before approve.

### Symptom: operator accidentally enabled writes

No data damage from enabling alone — enabling just unlocks the
queue + executor. Nothing fires until something is approved.

1. Settings → Accpac integration → Disable.
2. Audit log records who enabled and when (and whose password
   verified). Use that for the post-mortem.

### Symptom: too many `failed_terminal` rows

Means commits are being attempted but Accpac is rejecting them
(login failed, schema drift, table locked, blocked by a trigger,
etc.). The `accpac-hold.terminal-failure-spike` alert should fire
automatically.

1. Filter `pending_hold_actions WHERE status = 'failed_terminal'
   AND committed_at > datetime('now', '-1 hour')`.
2. Group by `failure_reason`. Almost always there's one root cause
   across the batch (a credential rotated, a permission was
   revoked).
3. Disable Accpac writes while you fix the underlying issue.
4. Once fixed, re-enable. Failed-terminal proposals don't auto-retry
   — you have to either explicitly re-propose or accept that those
   particular customers won't be held.

### Symptom: reconciliation drift growing unexplained

The `accpac-hold.reconciliation-drift` alert fires when the count
of customers in either divergence direction exceeds threshold for
> 24h.

1. Open the Hold reconciliation panel (Operations or Settings).
2. Two lists: "Held in Accpac, not red in Cardoso" and "Red in
   Cardoso, not held in Accpac."
3. Triage row by row. The point is the operator looks at each
   customer and decides — Cardoso doesn't auto-resolve either
   direction.
4. Common drivers:
   - Controller manually held in Accpac without Cardoso proposing
     → expected, no action needed in Cardoso.
   - Cardoso flagged red but proposal hasn't been approved →
     follow up with the controller.
   - Controller released in Accpac but Cardoso flag stale → operator
     decides whether to clear the Cardoso flag.

### Symptom: Master switch is off and you're not sure who turned it off

Audit log has every `accpac_writes_enabled` and
`accpac_writes_disabled` action with actor email, IP, and
timestamp. There is no way to flip the switch without leaving an
audit row — that's by design.

### When in doubt: disable

The **disable** action has no friction (no password, no warning,
no confirmation) precisely because it's the universal undo. If
something looks wrong and you're not sure what's happening:
**disable first, investigate second.**
