# Tech Debt Register

Rolling list of work that's been *consciously deferred* — not a backlog of
everything that could ever be improved. Each entry says what it is, why
it's not done, and what would change our mind.

Last updated: 2026-05-10 (OCR memory mitigations completed via PR #206 + #237; merge-loss CI guard and schema-CHECK audit added; pdfjs pin note updated with the mitigation context).

---

## Security hardening

### `xlsx` (SheetJS) prototype-pollution + ReDoS

**Status:** known, mitigated by trust boundary, not patched in dep.

`npm audit` flags two high-severity issues in `xlsx` (GHSA-4r6h-8v6p-xvw6
and GHSA-5pgg-2g8v-p4x9). SheetJS upstream has no fix; the package is
maintained out-of-band from npm.

We use `xlsx` to parse BAT supplier spreadsheets and Cardoso-format
spreadsheets. Both upload paths are gated behind `can_access_reconciliation`,
so only trusted operators can supply input. That bounds the realistic
attack surface to "operator uploads a malicious file from a supplier."

**Two paths forward:**

1. **Harden in place** (cheaper, ~2 hours):
   - Move parse into a `worker_thread` with a SIGTERM hard-cap (~10s) so
     ReDoS can't stall the main loop.
   - `Object.freeze(Object.prototype)` inside that worker after parse so
     prototype pollution can't escape.
   - File-size + cell-count caps before handing to `xlsx`.
2. **Migrate to `exceljs`** (~1 week including regression testing):
   - Different API; both `parseSupplierSpreadsheet` and
     `parseCardosoSpreadsheet` get rewritten.
   - `exceljs` is stricter about format — supplier sheets that xlsx
     silently fixed may need manual cleanup. De-risk with a
     parse-both-and-compare flag in production for one cycle.

Recommended: the harden-in-place path. Migrate only if SheetJS is
end-of-lifed or a more serious CVE lands.

---

### Defense-in-depth items (no real exposure today)

- **CORS production config** at `server.js:94-100` allows all origins with
  `credentials: true`. Mitigated because the session cookie is
  `sameSite: 'strict'` — the browser won't send it cross-origin regardless
  of CORS. If the cookie's `sameSite` ever loosens (e.g. for an OAuth flow),
  this becomes real and needs a proper origin whitelist.

---

## Code quality

### Legacy broad TypeScript errors (~1800)

`npm run typecheck` is now a scoped CI gate backed by
`tsconfig.typecheck.json`. The broad legacy JS-checking baseline is still
measurable with `npm run typecheck:legacy`; after the React 19 ref-as-prop
codemod it sits at roughly 1800 errors.

The checked surface (grows with each ratchet PR):

- `src/lib/app-params.js`
- `src/lib/clientLog.js`
- `src/lib/creditLogic.js`
- `src/lib/dates.js`
- `src/lib/evalFlagRules.js`
- `src/lib/errorDescribe.js`
- `src/lib/humanizeApiError.js`
- `src/lib/isoWeek.js`
- `src/lib/manualFlagMessages.js`
- `src/lib/permissions.js`
- `src/lib/query-client.js`
- `src/lib/useColorScheme.js`
- `src/lib/useColumnWidths.js`
- `src/lib/utils.js`
- `src/utils/index.ts`

Cleanup path:
1. Keep `npm run typecheck` green in CI.
2. When a source file is cleaned, add it to `tsconfig.typecheck.json`.
3. Periodically run `npm run typecheck:legacy -- --pretty false` to choose
   the next highest-value bucket.

Pricier but still bounded:
- `src/lib/errorLog.js` (43)
- `src/lib/retention.js` (47)

Heavy lift (skip until the cheap wins are gone):
- `src/lib/alertRules.js` (373)
- `src/components/settings/SettingsPanel.jsx` (235)
- `src/pages/Reconciliation.jsx` (174)

---

## Stack upgrades held in Tier 3

These all have known migration costs that outweigh the benefit *right now*.
Re-evaluate when one of them gains a feature we actively need.

| Package          | Current → Latest | Why deferred                                                           |
|------------------|------------------|------------------------------------------------------------------------|
| `tailwindcss`    | 3.4 → 4.x        | CSS-first config rewrite, big migration, mature design has no need.    |
| `recharts`       | 2.15 → 3.x       | Breaking chart API; we have many charts.                               |
| `framer-motion`  | 11 → 12          | Renamed to `motion`, breaking imports.                                 |
| `react-router-dom` | 6 → 7          | Major rewrite for marginal value in a SPA.                             |
| `tesseract.js`   | 5 → 7            | OCR pipeline just stabilised; don't poke it.                           |
| `date-fns`       | 3 → 4            | We just migrated *off* moment to `date-fns@3`. Defer one cycle.        |
| `zod`            | 3 → 4            | Schema API churn; needs review of every usage.                         |
| `better-sqlite3` | 11 → 12          | Native rebuild on Windows = AV-scanner risk; no compelling perf reason.|
| `eslint`         | 9 → 10           | Peer-blocked by `eslint-plugin-react@7.37.5`. Wait for the plugin.     |

---

## Operational hardening (deferred from May 5 plan)

These came out of the "what would I actually do" review of a generic
upgrade plan. The four highest-leverage items are landing now (CI,
backup verification, Sage health, parser tests). The rest sit here.

### Hub sync overlap-guard alerting

The overlap guard in `src/scheduler.js` (added 2026-05-05) skips a
`syncAllSites` tick if the previous run is still going and `console.warn`s
the skip. That's fine for a single skip — if it fires repeatedly, ETL
is degrading and someone needs to know without grepping logs. Surface
this in the admin UI as a banner ("Hub sync overruns: N in last hour")
once we have a counter to drive it.

### Structured JSON logging + request IDs

Worth doing **only** once we have a central log aggregator to ship to.
Until then the existing `[bat-...]` / `[hub-...]` / `[auto-sync]`
prefixes give grep-friendly logs that work fine. Pinned here so we
remember to revisit when the deployment story changes.

### TypeScript migration in `src/lib/*` utilities

A staged migration: add `// @ts-check` per file in `src/lib/`, fix the
typecheck errors as they surface, expand outward only when those
modules are clean. Do **not** flip `checkJs: true` repo-wide until the
700-error baseline is dealt with. Dependent on the typecheck-cleanup
item above.

### Generic plan items rejected for this codebase

For the record, the May 5 generic upgrade plan included the following
items that were considered and rejected:

- **Stricter CSP across all modes** — rejected. Production LAN-only
  mode intentionally turns CSP off; TLS-fronted mode already has a
  real CSP via `helmet`. Tightening LAN mode without a reason just
  breaks things.
- **Route-level code splitting** — already done. Every page in
  `src/pages.config.js` is `React.lazy(...)` and `vite.config.js`
  has explicit `manualChunks` for vendor-react / vendor-query /
  vendor-ui / vendor-charts.
- **Pagination/virtualization on heavy tables** — already done on
  records, customer balances, BAT extractions.
- **Repo-wide JS → TS migration** — see staged plan above. The 700
  pre-existing typecheck errors mean a repo-wide flip adds friction
  without value.
- **Monthly dependency update cadence** — too slow for security.
  Dependabot runs weekly, auto-merges patch.

---

## Permanent pins (not deferrals — pointers)

- `pdfjs-dist` is pinned at `4.8.69`. See `docs/plans/pdf-engine-migration.md`
  for the full story. The 5.x line was tested 2026-05-05 — no longer
  crashes on node-canvas, but renders blank pages, which is worse. Pin
  stays until we migrate to a Node-native PDF engine.

  Production hit a worse failure mode in 2026.5.3: `page.render()` blocks
  the worker thread synchronously inside node-canvas's native code on
  certain large/banner PDFs. The in-worker 30s timeout cannot fire
  because JS isn't running; only the parent-side 120s `PDF_TIMEOUT`
  recovers via `worker.terminate()`. PR #237 added five mitigations
  (megapixel/height caps, preflight reject, per-URL skip after a
  render-stage wedge, lower recycle threshold, hard `process.exit()`
  at 3 GB RSS) that bound the blast radius to a single row plus a
  bounded RSS window — but the underlying wedge can't be fixed in JS.
  The pdf-engine-migration is now load-bearing; promote it from
  Tier-3 to active when bandwidth allows.

---

## Process / merge-hygiene

### CI guard for migration version contiguity

The week of 2026-05-08 hit four merge-loss-class bugs in production
(PR #221, #223, #228, #235): a feature PR shipped with its supporting
infrastructure (migration / import / schema CHECK), then a parallel
merge silently dropped one half during conflict resolution. The
runtime contract broke; nobody noticed until a downstream operation
hit the missing piece in production.

Concrete fix: a tiny CI check that asserts every committed migration
version is contiguous (no gaps between `v1` and `vN`). Would have
caught the missing v62 immediately at PR open time instead of after
production deploy. ~30 lines of script in the existing
`build-windows.yml` workflow.

Lower-effort variant: assert the migrations array length equals
`max(version)` — same signal, simpler check.

### Audit other CHECK-constraint whitelists for the same merge-loss risk

PR #235 dropped the `auditlog.resource_type` CHECK constraint
because adding a new resource type without coordinating a schema
migration silently dropped audit rows (PR #198 added `'site'`
without updating the CHECK list, so every Sync from Accpac click
hit `SQLITE_CONSTRAINT_CHECK` and the audit row was lost).

The same pattern likely lives in other tables. CHECK constraints on
text columns whose value set is application-controlled (not a true
foreign-key-style invariant) are landmines: every new value needs
a coordinated migration that's easy to forget. Worth a one-pass
audit of `src/db/schema.js` to identify which CHECKs are genuine
domain invariants (status enums) vs. which are descriptive-metadata
whitelists that should be dropped. Candidates to review (not
exhaustive):

- `databaseconnection.status` — finite domain, keep.
- `datarecord.flag_color` — finite domain, keep.
- `autoflagrule.logic` — finite domain, keep.
- `autoflagrule.flag_color` — finite domain, keep.
- `user.role` — finite domain, keep.
- Anything else that looks like a "type" or "kind" column added by a
  feature — likely a candidate to drop.

Do this opportunistically when next touching `src/db/schema.js`, not
as a standalone effort.
