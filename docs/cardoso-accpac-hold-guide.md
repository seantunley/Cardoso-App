# Cardoso → Accpac on-hold module — operator's guide

This is the plain-English explainer of how the Cardoso "put a customer on hold in Accpac" feature works. Written for operators, credit controllers, support staff, auditors, and engineers who haven't read the design doc.

For the full technical design, see [docs/plans/cardoso-to-accpac-hold-sync.md](plans/cardoso-to-accpac-hold-sync.md).

---

## What this module does, in two paragraphs

Cardoso has always been a **read-only** layer on top of Accpac/Sage 300. It pulls customer data into its own database, lets operators flag customers as red/orange/green, but never writes anything back to Accpac. Credit controllers using Accpac have always been the only people who can change anything in the actual accounting system.

This module changes that — but only in one very narrow, controlled way. When Cardoso flags a customer red, **a credit controller can choose to push that decision into Accpac as a "credit hold"** (`ARCUS.SWHOLD = 1`). That stops invoices being raised against that customer in Accpac until somebody removes the hold. The whole module exists to make that one specific write safe — to prevent a runaway rule, a typo, or a software bug from accidentally putting hundreds of customers on hold overnight.

---

## What this module CANNOT do

Read these first. If anyone tells you the module does any of these things, they are wrong.

- **It cannot release a customer from hold.** Off-hold (taking `SWHOLD` from 1 back to 0) is **always** done by the credit controller in Accpac directly. Cardoso has no code path that can release. There is no button, no API endpoint, no scheduled job. The schema, the helper function, and the boot-time check all enforce this. To re-enable trade with a held customer, you go to Accpac.
- **It cannot bulk-update.** The write to Accpac is one customer at a time, one row at a time. The SQL is hard-coded as `UPDATE ARCUS SET SWHOLD = @hold WHERE IDCUST = @idcust` — affecting exactly one row. If for any reason a single call would touch more than one row, the operation is aborted before it commits. There is no `UPDATE ALL`, no `WHERE flag_color = red`, no list-of-customers update.
- **It cannot modify any other Accpac column.** The module touches `ARCUS.SWHOLD` and nothing else. Not credit limit, not payment terms, not customer name, not contact details, not the national-account flag, not anything else. The function that does the write is hard-coded to update only `SWHOLD`. A test in the build verifies this and fails the build if anyone changes it.
- **It cannot fire automatically without human approval.** A red flag in Cardoso does NOT automatically place a hold in Accpac. It puts a *proposal* in a queue. A credit controller has to look at the queue, click approve, and only then does Cardoso attempt the write.
- **It cannot do anything if the master switch is off.** There is a single global on/off in Settings. Default is OFF. With it off, none of the above happens — no queue, no executor, no writes, period. A site running this build with the switch off behaves exactly like the previous read-only Cardoso.
- **It cannot do anything if `can_write_hold = 0` on the Accpac connection.** Per-connection flag, default 0. Even with the master switch on, a connection where this flag is 0 will not have writes happen against it. Two flags must be on for a write to be possible.
- **It cannot make changes that aren't audited.** Every proposed hold, every approval, every commit, every rejection, every disable, every enable — all written to the audit log with the user's email, IP, and timestamp. Nothing happens silently.

---

## The seven gates a write has to pass

Even with everything configured, a single attempted write has to pass seven independent checks. If any one fails, the write is refused. They are deliberately layered so that if one is misconfigured the others still hold.

1. **Master switch is ON.** Settings → Accpac integration shows ENABLED. Operator turned it on with their password.
2. **`can_write_hold` is ON for the connection.** The specific Accpac connection has been explicitly marked as write-eligible by an admin.
3. **The proposal is in `approved` status.** A credit controller has reviewed and approved it. Not `queued` (just enqueued, not yet looked at), not `rejected`.
4. **The eligibility filter still passes.** The customer is still red-flagged, the flag is still old enough, the customer isn't in the exclusion list, etc. Re-checked at commit time, not just at enqueue time, because state changes in between.
5. **Pre-flight verify: the customer exists.** A `SELECT IDCUST, SWHOLD FROM ARCUS WHERE IDCUST = @idcust` confirms there's exactly one row matching. Captures the current value for the audit's "before" snapshot.
6. **The write itself.** Single, parameterised, one-row `UPDATE`. SQL Server reports "1 row affected." Anything else (0 rows, or more than 1) is a hard abort.
7. **Post-write verify: the change actually committed.** A second `SELECT SWHOLD FROM ARCUS WHERE IDCUST = @idcust` confirms the value is what we set. Catches the case where a database trigger silently reverts the change.

That's seven independent checks for what is, technically, a single field flip. The cost is a handful of milliseconds. The benefit is that no single bug or misconfiguration can cause an unintended write.

---

## How it works, step by step

### 1. Cardoso flags a customer red

Either an operator clicks "flag red" manually, or an auto-flag rule decides the customer matches its conditions (high outstanding balance, overdue invoices, etc.). This part is unchanged from how Cardoso has always worked.

### 2. A "proposed hold" gets queued

If the master switch is on AND the customer is eligible (auto-flag, red for at least 24h, not on the exclusion list, not already held in Accpac), Cardoso creates a row in the **proposal queue**. The queue is internal to Cardoso — it has not touched Accpac yet.

The proposal includes:
- Which customer (`IDCUST` + connection)
- Why (the rule name and reason, or the operator's note for manual proposals)
- Who proposed it (auto-flag rule ID, or the operator's email)
- When

### 3. The credit controller reviews the queue

A new "Holds pending" panel in the Cardoso UI shows the queued proposals. For each one the controller sees:
- Customer name + number
- Outstanding balance + last invoice
- Why Cardoso is suggesting hold
- Cardoso's flag history for this customer

The controller has three options per proposal:

- **Approve** — moves the proposal to `approved`. The next executor tick will attempt the actual Accpac write.
- **Reject** — marks the proposal `rejected`. No write happens. Audit-logged.
- **Leave it** — proposal sits in `queued` until somebody else acts on it.

### 4. The executor commits the write to Accpac

A background process picks up `approved` proposals and attempts the write. For each one, it goes through the seven gates above. If all pass, `ARCUS.SWHOLD = 1` is set for that one customer in Accpac. The proposal status flips to `committed` with a timestamp and the audit log records the before/after.

If any gate fails, the proposal flips to either:
- `failed_retryable` — a transient problem (network blip, lock timeout). The next tick will try again.
- `failed_terminal` — a real problem (login rejected, schema drift, the customer doesn't exist anymore). The proposal will NOT be retried. The operator has to look at it and decide.

### 5. Cardoso reads the new state on the next sync

The next time Cardoso pulls from Accpac (which happens on a regular schedule), it sees the customer's `SWHOLD` is now 1. The customer card shows "Accpac says: on hold." Closing the loop.

### 6. The credit controller releases the customer in Accpac when ready

This is the **only** way a hold gets removed. When the customer pays, or the controller has a reason to allow trade again, they go to Accpac and set `SWHOLD = 0`. Cardoso reads the new value on the next sync.

If at that point the customer's Cardoso flag is still red, the customer card shows a divergence indicator: "Accpac released this customer 2 days ago — Cardoso flag still red. Review." The operator decides whether to clear the Cardoso flag too. Cardoso never auto-clears, because the auto-flag rule's underlying conditions might still be true and the rule would just propose hold again, creating a loop.

---

## Who can do what

| Role | Can flag in Cardoso | Can propose hold | Can approve hold | Can release in Accpac | Can flip the master switch | Can flip `can_write_hold` |
|---|---|---|---|---|---|---|
| Regular user (non-admin) | Yes (manual flags) | Maybe (per permission) | No | No | No | No |
| Credit controller | Yes | Yes | **Yes** | **Yes (in Accpac)** | No | No |
| Cardoso admin | Yes | Yes | Yes | Yes (in Accpac) | **Yes** (with password) | **Yes** |
| Auto-flag rule (system) | Yes (via rule conditions) | Yes (queues, never approves) | No | No | No | No |

**Key separations of duty:**
- The system can propose, never approve.
- A credit controller is the only role that can approve a queued proposal.
- Releases require the controller to act in Accpac directly. There is no Cardoso UI for it.
- Only an admin can flip the master switch, and only after re-entering their own password.

---

## The master switch

This is the single most important control.

- **Where**: Settings → Accpac integration tab. Admin-only — the tab is invisible to non-admins.
- **What it does**: when OFF, the entire Accpac write functionality is inert. No queue, no executor, no writes, no UI for proposals. Site behaves exactly like the previous read-only Cardoso.
- **Default**: OFF. Always. New installs ship with it off; an upgrade from a pre-module version of Cardoso starts with it off.
- **To turn it ON**:
  1. Click "Enable Accpac writes."
  2. Read the warning prose carefully. (It explains exactly what enabling allows.)
  3. Re-type your own user password.
  4. Click the final "Enable Accpac writes" confirm button.
  5. Audit log records who enabled it, with their email, IP, and timestamp.
- **To turn it OFF**:
  1. Click "Disable Accpac writes."
  2. Done. No password, no confirmation.

The asymmetry is deliberate. **Enabling is a deliberate action with ceremony. Disabling is the emergency stop and stays frictionless.** If something looks wrong and you don't know what's happening — disable first, investigate second.

---

## What an "emergency" looks like and what to do

### "Customers are being put on hold who shouldn't be."

**30-second action:**

1. Settings → Accpac integration → **Disable**. One click.
2. Confirm the state pill shows **DISABLED**.

That's it for the immediate stop. Within seconds, no further `ARCUS.SWHOLD` writes will happen, regardless of what's in the queue.

**Then triage:**

1. Operations → Audit log, filter on "accpac_hold_committed". Each row shows the customer and the prior `SWHOLD` value.
2. In Accpac, manually set `SWHOLD = 0` for the affected customers. Do this by hand from the audit log — don't script it from the queue.
3. Settings → Auto-Flag Rules → find the rule that fired. Toggle it off (`is_active = 0`).
4. Investigate the root cause.
5. When ready, re-enable Accpac writes (with password re-entry).

### "I accidentally clicked Enable."

No data damage from enabling alone. Enabling just unlocks the queue and executor. Nothing is written to Accpac until someone explicitly approves a proposal.

1. Click Disable. Done.
2. The audit log notes that you enabled and disabled. Use the timestamps for your post-mortem if anyone asks.

### "There are way too many failed proposals."

If `failed_terminal` is piling up, an alert will fire automatically (`accpac-hold.terminal-failure-spike`). Underlying cause is almost always one of:

- The Cardoso SQL Server account's password expired or was rotated.
- A permission was revoked.
- The Accpac schema changed in a way that broke the assumption (rare).

Disable Accpac writes while you investigate. Failed terminal proposals don't auto-retry — once you fix the underlying issue you decide whether to re-propose or accept that those customers won't be held.

### "The queue is full of stale proposals after we re-enabled."

If the executor was off for a while, proposals can pile up. Once you re-enable, you don't necessarily want a flood.

1. Operations → Holds pending. Sort by `not_before` ascending (oldest first).
2. Use the bulk-expire endpoint to flip everything older than (say) 24 hours to `expired`.
3. The remaining proposals are recent enough that the controller should review them individually.

### "I don't know who turned the master switch off (or on)."

The audit log has every flip recorded with the actor's email, IP, and timestamp. There is no way to flip the switch without leaving a row. By design.

---

## Frequently asked questions

**Q: Can this module accidentally update the entire ARCUS table?**
A: No. The SQL is hard-coded to update one row by primary key. SQL Server reports the affected row count after the UPDATE; if it's not exactly 1, the operation aborts. There is no `UPDATE ARCUS SET …` without a `WHERE IDCUST = @idcust` constraint anywhere in the code.

**Q: Can a bug in an auto-flag rule bypass the approval step?**
A: No. The rule can only enqueue a proposal in `queued` status. It has no path to `approved`. Only a credit controller using the UI can approve.

**Q: What if the Cardoso → Accpac connection's user has too many permissions?**
A: Even if the SQL Server login could in principle update other tables, the code that talks to Accpac is a dedicated helper that only knows how to call `setHoldStatus(idcust, hold01)`. There is no generic SQL execution path. The principle of least privilege still says the SQL Server account should only have UPDATE permission on `ARCUS.SWHOLD` (and SELECT on the columns Cardoso reads), but the code defends against itself first.

**Q: Can SQL injection through a customer name or proposal note cause unintended writes?**
A: No. Every SQL statement uses parameterised binding — values are sent separately from the query text. There is no string concatenation of values into SQL. The build includes a test that asserts the SQL queries emitted by the helper match exact regex patterns; if anyone introduces a concatenation, the build fails.

**Q: A future PR adds another Accpac column to update. What happens?**
A: The build-time SQL-shape test fails. The PR is rejected at code review. To add a new write target, the helper has to be redesigned and the constraints document updated, which forces a deliberate design discussion.

**Q: A trigger on ARCUS reverts our change after we set SWHOLD = 1. How would we know?**
A: The post-write verify SELECT catches it. The proposal flips to `failed_terminal` with the reason "post-write verify mismatch — value reverted from 1 to 0 by external action." Alert fires. Operator investigates.

**Q: We have multiple Sage instances. Can the same customer number ID someone different across two of them?**
A: Yes, and the schema accounts for this. Every proposal is keyed on `(customer_number, connection_id)` so the same `IDCUST` text in two ledgers is two distinct proposals. The unique partial index that prevents duplicate proposals is also keyed on this composite.

**Q: Cardoso is read-only at our site. Will this module break that?**
A: Not unless someone deliberately turns on the master switch. With the master switch off (default), the module is inert. Sites can install the new build and behave exactly as before.

**Q: Does the in-flight migration affect existing Accpac data?**
A: No. The migration adds two new columns to Cardoso's local `datarecord` table (`accpac_on_hold` and `accpac_on_hold_synced_at`) and a few new tables on the Cardoso side. It does not touch Accpac.

**Q: The credit controller releases a customer in Accpac. Does the Cardoso flag clear too?**
A: No. Cardoso shows a divergence indicator ("Accpac released this customer — Cardoso flag still red, review"). The operator decides whether to clear the Cardoso flag. We deliberately don't auto-clear because the auto-flag rule's conditions might still be true and we'd loop.

**Q: How long does it take from "operator approves" to "Accpac is updated"?**
A: The executor runs on a tick (likely every few minutes — exact cadence TBD during Phase 2 implementation). So worst case, around one tick interval after approval. SLO target: median ≤ 4 business hours from `queued` to `committed` (mostly waiting on the controller to approve), with the executor adding only the tick interval.

**Q: What if the controller approves but then changes their mind?**
A: While the proposal is in `approved` but not yet `committed`, they can disable the master switch — that halts the executor before it commits. After `committed` the change is in Accpac and they have to release manually in Accpac.

**Q: Can this be used to put NEW customers on hold (before they're ever invoiced)?**
A: Yes — the constraint is just that the customer exists in `ARCUS` with that `IDCUST`. Whether they have invoices is irrelevant.

---

## Glossary

- **Accpac / Sage 300** — the accounting system Cardoso reads from and (with this module) optionally writes one specific field to.
- **`ARCUS`** — the Accpac/Sage table that holds customer master records. Has columns like `IDCUST` (customer number), `NAMECUST` (name), `AMTBALDUEH` (outstanding balance), and `SWHOLD` (the on-hold flag).
- **`SWHOLD`** — the column on `ARCUS` that determines whether a customer is on credit hold. `1` = on hold (Accpac will not allow new invoices to be raised), `0` = clear (normal trade allowed).
- **`IDCUST`** — Accpac's primary-key customer number. A short text identifier (e.g. "CUST001"), unique within an Accpac instance.
- **Hold** — `SWHOLD = 1`. The customer cannot be invoiced. New orders typically pause until the hold is released.
- **Release** — `SWHOLD = 0`. Customer is allowed to trade normally again. **Cardoso never does this.**
- **Proposal** — Cardoso's internal record that says "we think this customer should be put on hold." Lives in the `pending_hold_actions` table. Has to be approved before anything happens to Accpac.
- **Queue** — the list of pending proposals awaiting controller review.
- **Executor** — the background process that picks up `approved` proposals and tries to commit them to Accpac.
- **Master switch** — `bat_settings.accpac_write_enabled`. Global on/off. Settings → Accpac integration tab.
- **`can_write_hold`** — per-Accpac-connection flag, default off. Even with the master switch on, this has to be on for writes to that specific connection to happen.
- **Reconciliation drift** — the count of customers where Cardoso's view of "is this on hold?" disagrees with Accpac's. Shown on the Hold reconciliation panel. An alert fires if drift gets too high for too long.
- **Eligibility filter** — the set of conditions a customer must meet for a hold to be auto-proposed (red flag, flag age, not in exclusion list, etc.).
- **Exclusion list** — customers who should never be auto-held. VIPs, internal accounts, key suppliers. Can be set centrally at the hub or locally at a site.
- **`failed_retryable` / `failed_terminal`** — proposal statuses for failed commits. Retryable = transient (will try again next tick). Terminal = real problem (won't retry, operator has to investigate).

---

## Where to find things

| What | Where |
|---|---|
| The technical design plan | [docs/plans/cardoso-to-accpac-hold-sync.md](plans/cardoso-to-accpac-hold-sync.md) |
| The master switch | Settings → Accpac integration |
| The proposal queue | Operations → Holds pending |
| The reconciliation panel | Operations → Hold reconciliation |
| The audit log | Operations → Audit log |
| Per-connection write flag | Settings → Connections → (specific connection) → "Allow hold writes" checkbox |
| The exclusion list | Settings → Auto-Flag Rules → "Customer exclusions" |
| The auto-flag rules | Settings → Auto-Flag Rules |
| The site's view of Accpac on-hold state | Customer card in Cardoso → "Accpac says: on hold / clear" |

---

## Summary in one paragraph

Cardoso → Accpac hold module: a credit controller can use Cardoso's red flag system to put customers on credit hold in Accpac, by setting `ARCUS.SWHOLD = 1` for one customer at a time, after explicit approval. The whole system is gated by a master switch (off by default, requires admin password to enable, single click to disable), a per-connection flag, manual approval of every proposal, and seven independent checks at commit time. Cardoso never releases a hold — that's strictly an Accpac action. Cardoso never updates anything else in Accpac — only `SWHOLD`, only one row per write. Every action is audited. If anything looks wrong, the disable button is the universal undo.
