# Reconciliation module — deferred work

A 2026-05-08 external review of the BAT reconciliation stack raised seven
items. Three were actioned in PRs #215 / #216 / #217. The remaining four
are recorded here so the rationale isn't lost — none are urgent today,
but each has a trigger condition that would justify revisiting.

## Already shipped (for reference)

- **#2 Transactional refresh safety** — PR #215. `replaceSageCreditNotes`
  helper wraps DELETE + insert + sage_error clear in one transaction;
  applied at all three Sage credit-note refresh call sites.
- **#4 Tests for refresh + SSE + retry** — PR #216. 13 tests pinning
  Batch A's contract plus SSE listener hygiene + retry-extraction
  behaviour. Anchors the contract before any wider refactors.
- **#5 Bounded structured logging** — PR #217. Four worth-persisting
  console.error sites converted to logError; high-frequency operational
  chatter intentionally NOT converted (logError is sync I/O — same
  lesson the customer-lookup hot path taught us).
- **#6 Sage status pill** — PR #217. New SageStatusPill on the
  Reconciliation page consuming the existing `/api/bat/sage-health`
  endpoint. Operator can spot "Sage will fail" without clicking
  Refresh first.

## Deferred

### #1 Service decomposition

**Reviewer's idea:** `src/services/batReconciliation.js` is 3225 lines
and mixes Sage pool/health, supplier/cardoso parsing, OCR worker
orchestration, matching/aggregation queries, and cache logic. Split
into focused modules:

- `bat/sageClient.js` — pool + retries + health
- `bat/parser.js` — supplier/cardoso parsing + validation errors
- `bat/ocrEngine.js` — worker lanes/events
- `bat/reconRepository.js` — SQL reads/writes
- `bat/reconService.js` — use-case orchestration

**Status:** deferred. The split is sensible but the move is a
multi-day refactor with regression risk against behaviour that's
currently only thinly covered by tests. PR #216 added 13 tests around
the critical paths, but those don't pin the parser, the OCR worker
choreography, or the matching aggregations. Doing the split before
broader test coverage means every move is a guess.

**Revisit when:** test coverage expands to the parser internals
(beyond the parseSupplierSpreadsheet validation tests already in
`test/parseSupplierSpreadsheet.test.js`) AND the OCR worker
choreography. The split itself is the easy part once we can detect
regressions cheaply.

**Rough scope when revisited:** start with the cleanest cleavage —
`bat/sageClient.js` carving out lines 60-260 (pool, retry, probe).
That's the lowest-coupling module and a good test of the pattern.
Remaining splits follow once the first lands.

---

### #3 Centralised input validation helpers

**Reviewer's idea:** `parsePositiveInt(value, fieldName)` and consistent
400 payloads `{ error, field, received }` instead of the current
`parseInt(...)` + truthiness pattern.

**Status:** deferred — pure code-cleanliness, not a bug. The current
pattern handles the cases that matter:

- `parseInt('abc')` returns NaN; `if (!NaN)` is true (falsy) → 400.
- `parseInt('1abc')` returns 1 → passes truthiness → DB SELECT
  returns nothing → 404 from the next check.
- `parseInt('-1')` returns -1 → passes → SELECT returns nothing → 404.

The cases that "behave awkwardly" still produce sensible HTTP
responses; just not the most-precise error messages. A
`parsePositiveInt` helper would make the error responses more
consistent but doesn't fix any current security or correctness
issue.

**Revisit when:** a) we standardise error response shapes across
the whole app (a CONTRIBUTING-style decision, not a recon-specific
one), or b) a real bug surfaces from the lenient parse behaviour.

**Rough scope when revisited:** new `src/lib/parseHelpers.js` with
`parsePositiveInt(value, fieldName)` returning either a number or
throwing a tagged error caught by an Express error-handling
middleware. Roll out across all routes in one PR for consistency.

---

### #7 Match precompute / cache

**Reviewer's idea:** the frontend correctly made the cardoso match
non-blocking. Expensive matching can still be costly at higher load —
add background precompute/cache per reconciliation, invalidated on
cardoso/supplier writes.

**Status:** deferred pending metrics. The frontend non-blocking change
already addressed the user-visible symptom (recon page no longer
hangs while matching computes). Backend work to precompute the match
isn't justified without numbers — query plan, wallclock, or alert
data showing the match step is slow at production scale.

**Revisit when:** an operator complaint surfaces specifically about
match latency, OR the new structured logs from PR #217 show match
queries crossing a slow threshold (we'd need to add timing telemetry
to the match endpoint first — bundle that in if/when this trigger
fires).

**Rough scope when revisited:** materialise a per-recon
`bat_match_cache` table, populated by a debounced post-write hook
on cardoso/supplier inserts. Invalidate on schema or rule changes.
Roughly the same shape as the credit-logic publish/push pattern.

---

### Correlation IDs (mentioned in #5 but split off)

**Reviewer's idea:** add a request-ID middleware and thread it through
recon-related logs (`recon_id`, `user_id`, `route`, Sage query latency,
OCR row timings) so intermittent issues are easier to triage.

**Status:** deferred — the basic structured-logging changes from
PR #217 are the floor; correlation IDs are the ceiling. Both worthwhile,
but correlation IDs need:

1. A request-ID middleware at the Express level
2. Propagation through service-layer calls (function signatures change)
3. A logger context that picks up the current request ID automatically
4. A search/filter UI on Operations → System Log

That's a multi-PR feature, not a bolt-on. Doing it badly (generating
IDs but not threading them) is worse than not doing it.

**Revisit when:** an actual incident requires cross-log correlation
that the existing `recon_id` and `extraction_id` meta fields can't
provide. So far the `meta` shape on every `logError` call carries
enough domain identifiers for triage — operators rarely need to ask
"which user's session caused this".

**Rough scope when revisited:** new `src/middleware/requestId.js`
(uuid v7 per request, header-overridable for upstream propagation),
AsyncLocalStorage for request-scoped context, `logError` reads the
context and adds `request_id` to every meta automatically. Search
filter UI is a follow-up after the data exists.

---

## Trigger summary

| Item | Trigger to revisit |
|---|---|
| #1 Service decomposition | Test coverage expands to parser + OCR choreography |
| #3 parsePositiveInt helper | Whole-app error-response standardisation, OR a real bug from lenient parse |
| #7 Match precompute | Operator complaint about match latency, OR slow-threshold breach in PR #217's structured logs |
| Correlation IDs | An incident that the existing `meta` fields can't triage |
