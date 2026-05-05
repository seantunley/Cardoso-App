# Tech Debt Register

Rolling list of work that's been *consciously deferred* — not a backlog of
everything that could ever be improved. Each entry says what it is, why
it's not done, and what would change our mind.

Last updated: 2026-05-05.

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

- **JWT verify** at `src/routes/auth.js:109` doesn't pass an explicit
  `algorithms: ['HS256']` to `jwt.verify(token, secret)`. `jsonwebtoken@9`
  defaults are safe (rejects `alg: none`, derives algorithm from key type),
  so this isn't a real exposure today. Pass `algorithms: ['HS256']`
  explicitly the next time someone touches that file.
- **CORS production config** at `server.js:94-100` allows all origins with
  `credentials: true`. Mitigated because the session cookie is
  `sameSite: 'strict'` — the browser won't send it cross-origin regardless
  of CORS. If the cookie's `sameSite` ever loosens (e.g. for an OAuth flow),
  this becomes real and needs a proper origin whitelist.

---

## Code quality

### Pre-existing TypeScript errors (~700)

`npm run typecheck` reports 700+ errors against `jsconfig.json`. This is
mostly `forwardRef` ref-attribute typing noise plus unrelated JS-checked
type drift. Typecheck is **not** a CI gate (intentional — the JS-checking
config produces too much noise to be useful as-is).

Cleanup options:
1. Make `jsconfig.json` less strict (`checkJs: false` until type debt is
   reduced) — fast, hides the problem.
2. One-by-one cleanup pass — slow, real value if we ever want typecheck
   to be a CI gate.

Not urgent. Pick this up when adding new code that benefits from real type
safety.

### `forwardRef` dev-mode warnings (React 19)

~163 components in `src/components/ui/*` use `React.forwardRef(...)`. These
keep working in React 19 but emit deprecation warnings in the dev console.
The mechanical refactor to ref-as-prop is one quiet day's work; the noise
isn't blocking.

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

## Permanent pins (not deferrals — pointers)

- `pdfjs-dist` is pinned at `4.8.69`. See `docs/plans/pdf-engine-migration.md`
  for the full story. The 5.x line was tested 2026-05-05 — no longer
  crashes on node-canvas, but renders blank pages, which is worse. Pin
  stays until we migrate to a Node-native PDF engine.
