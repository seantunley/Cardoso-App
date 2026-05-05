# Cardoso Release Notes — 2026-05-05

A consolidation drop. Eight streams of work landed together in
**v2026.4.18**: a security pass, a full offline-first overhaul, a
permissions bug fix, a UI-stall fix, and the React 19 + Express 5 +
Vite 8 stack upgrade.

---

## 🔒 Security

### Session store rewritten

`connect-sqlite3` is gone. Sessions now run on
**`better-sqlite3-session-store`** backed by a dedicated
`better-sqlite3` connection in its own `sessions.db` file. This drops
the entire legacy `sqlite3` → `node-gyp` → `tar` transitive chain.

`npm audit` went from **8 high-severity vulnerabilities to 1** in this
release. The remaining one is `xlsx` (SheetJS), which has no upstream
fix — see `docs/plans/tech-debt.md` for the harden-in-place plan.

> ⚠️ **Ops note:** the new store creates its own table layout. Every
> existing session is invalidated on first boot — every user has to log
> in once after deploying.

### `moment` removed

The unmaintained `moment` package is gone. The single call site
(`ConnectionStatus.fromNow`) now uses `date-fns.formatDistanceToNow`.
~70 KB out of the bundle.

### Audit-driven hardening

A two-pass code audit surfaced a handful of items worth fixing
proactively:

- **`/api/bat/refresh-sage-cache`** wrapped in try/catch with explicit
  500 + logging. A Sage pool error now returns a useful message
  instead of bouncing through the generic Express error path.
- **SSE heartbeat** in `/api/bat/extraction-status-stream/:id` got a
  30-min hard cap. Bounds the worst case if `req.on('close')` fails
  to fire on a half-open TCP connection (NAT silently dropping state,
  laptop suspended, etc.).
- **`records.js` schema-cache warmup** now `console.warn`s the table
  + reason on failure instead of swallowing silently.
- **Google Vision retry-batch path** (the main-thread "Retry with GV"
  button) — both the supplier-PDF download and the Google Vision API
  call now have `AbortController` + 30 s caps. Without these, a hung
  request blocked the event loop until the OS-level socket timeout
  (60–120 s).
- **Hub scheduler overlap guards** — `syncAllSites` and `pingAllSites`
  both wrapped so the next 5-min/15-min tick can't fire while the
  previous run is still going. Stops parallel syncs racing on the
  Hub Postgres pool when ETL is slow on one site.

---

## 🔌 Offline-first

The app must run on a fully air-gapped site. Three calls home were
killed:

- **Favicon.** Was `https://base44.com/logo_v2.svg` (scaffold leftover).
  Now a local phosphor "C" + cursor-block SVG matching the app's
  terminal aesthetic.
- **Google Fonts.** The `<link>` to `fonts.googleapis.com` plus the
  preconnects to `gstatic.com` are gone. Instrument Serif, Inter Tight,
  and JetBrains Mono now ship in `public/fonts/` (~120 KB total, latin
  subset only — covers all the South African English/Afrikaans content
  this app handles). Inter Tight and JetBrains Mono are variable fonts
  so one file each covers every weight.
- **Tesseract trained data.** `ocrWorker.js` now points `createWorker`
  at `vendor/tessdata/eng.traineddata.gz` (10.4 MB shipped with the
  app) with `cacheMethod: 'none'`. Previously tesseract.js silently
  downloaded this from `tessdata.projectnaptha.com` on first OCR — on
  a firewalled site it would just hit the 30 s "tesseract_init
  timeout" with no diagnostic. Loud-fails with a clear message if the
  file's missing.

The only remaining outbound calls are user-initiated and degrade
gracefully: cloud OCR engines (cascade falls through to local
Tesseract on failure) and the GitHub release check for in-app updates
(silent fallback to cached version).

---

## 🛂 Permissions — BAT non-admin access fixed

A non-admin user with only `can_access_reconciliation` toggled on was
landing on a **blank screen** after login. Three coordinated bugs:

- `src/routes/batReconciliation.js` route gate was still
  `[requireAuth, requireAdmin]` from the testing phase. Now uses
  `requirePermission('can_access_reconciliation')`. Two endpoints that
  mutate global state (`POST /ocr-pause`, `PUT /settings`) keep
  `requireAdmin` layered on top.
- `src/routes/auth.js` new-user `INSERT` was missing
  `can_access_reconciliation` and `can_access_hub_reconciliation` from
  both the column list and the bind values. New users were getting the
  DB column default instead of what `defaultPermissionsForRole` said.
- `server.js` was not passing `requirePermission` through to the BAT
  router factory.

Net result: a non-admin BAT-only user now lands cleanly on
`/Reconciliation`, sidebar shows only that module, can upload + extract
+ match invoices.

---

## ⚡ Performance — rapid-click recon hang

Clicking through reconciliations rapidly stalled the UI to the point
the user had to close + reopen the browser tab. Root cause: every click
fired a heavy `GET /api/bat/reconciliation/:id` (which auto-pulls Sage
credit notes for 1–5 s) plus a sequential `cardoso-match` GET. With no
`AbortController`, six rapid clicks pinned all six of Chrome's
per-origin connection slots on dead-on-arrival requests and everything
else queued.

Fixes:

- `loadReconciliation` now uses an `AbortController` that **cancels the
  previous click's fetches** when a new click arrives.
- Both fetches run in **parallel** via `Promise.allSettled` (was
  sequential), halving wall time per click.
- **Stale-response guard** — a slower earlier click resolving after a
  faster later one no longer overwrites `selected` with the wrong
  recon's data.
- The 5 s adaptive polling tick had the same race; now checks
  `selectedIdRef.current === id` before `setSelected`.
- Server-side: Sage credit-notes auto-pull now de-duped via an
  in-flight Promise map. Overlapping GETs for the same recon (poll +
  click, double-click) share a single `querySageCreditNotes` call
  instead of firing N parallel MSSQL queries.

---

## ⬆️ Stack upgrades

| Package | Before | After | Notes |
|---|---|---|---|
| `react` / `react-dom` | 18.3.1 | 19.2.5 | Codebase was already structurally 19-compatible. |
| `react-day-picker` | 8.10 | 9.14 | `calendar.jsx` migrated to v9 `classNames` + `Chevron`. |
| `@hello-pangea/dnd` | 17 | 18 | Peer-blocker, no app code change. |
| `react-leaflet` | 4.2 | 5.0 | Peer-blocker, dead dep. |
| `leaflet` | (added) | 1.x | Peer of react-leaflet 5. |
| `express` | 4.22.1 | 5.2.1 | Single change: SPA catch-all `app.get('*', ...)` → `app.get('/{*splat}', ...)` for path-to-regexp v8. |
| `vite` | 6.4 | 8.0 | `vite.config.js` `manualChunks` rewritten to function form. |
| `@vitejs/plugin-react` | 4 | 6 | Paired with vite. |
| `multer` | 1.4-lts | 2.1 | Security + maintenance line. Same `dest` / `limits` / `fileFilter` API. |
| `sharp` | 0.33 | 0.34 | Memory-leak fixes. |
| `dotenv` | 16 | 17 | Quiet-by-default. |
| `cross-env` | 7 | 10 | Dev script utility. |
| `lucide-react` | 0.475 | 1.14 | Stable v1 API. |
| `react-resizable-panels` | 2 | 4 | Used in app — visual smoke tested. |
| `typescript` (dev) | 5 | 6 | Dev-only. |
| `@types/node` (dev) | 22 | 25 | Dev-only. |
| `globals` (dev) | 15 | 17 | Dev-only. |
| `eslint-plugin-react-hooks` (dev) | 5 | 7 | Dev-only. |

**Stayed on 9:** `eslint` — peer-blocked by
`eslint-plugin-react@7.37.5`. Wait for the React plugin to support
ESLint 10.

**Tested but reverted:** `pdfjs-dist` 5.7.284. Doesn't crash on
`node-canvas` anymore (the 4.10 ImageBitmap issue is gone), but
**renders blank pages** — silently produces nothing, which is worse
than crashing. Pin at `4.8.69` stays. Result documented in
`docs/plans/tech-debt.md` and `docs/plans/pdf-engine-migration.md`.

---

## 📋 Tech-debt register

New `docs/plans/tech-debt.md` captures consciously-deferred work in one
place:

- `xlsx` hardening (the only remaining `npm audit` finding).
- JWT `verify` should pass `algorithms: ['HS256']` explicitly
  (defense-in-depth, not a real exposure today).
- CORS production whitelist (defense-in-depth, mitigated by
  `sameSite: 'strict'` cookie).
- TypeScript baseline cleanup (~700 pre-existing errors).
- `forwardRef` → ref-as-prop sweep across `src/components/ui/*` (~163
  components, cosmetic React 19 warnings).
- Tier 3 stack upgrades held back: Tailwind 4, Recharts 3,
  framer-motion 12, react-router 7, tesseract.js 7, date-fns 4, zod 4,
  better-sqlite3 12.

---

## 🧪 Test plan for the morning

1. **Login + dashboard** — verify the new `sessions.db` is created.
   Every existing user has to log in once after the upgrade.
2. **Permissions** — create a non-admin user with only
   `can_access_reconciliation`, log in as them. Should land on
   `/Reconciliation`, sidebar shows only that module, upload + extract
   work, no Settings button visible.
3. **Rapid-click recon** — open the Reconciliation page, click 5–6
   recons in quick succession. UI should stay responsive.
4. **Date picker** — open the BAT Reconciliation Cardoso invoice
   generation panel ("From / To" inputs). Visual check that
   `react-day-picker` v9 still looks right.
5. **OCR pipeline** — re-OCR a known-good supplier PDF, confirm it
   completes.
6. **Hub sync** — let the 5-min `syncAllSites` tick run; should see no
   `[hub-sync] previous syncAllSites still running` warning unless one
   actually overruns.
7. **Offline check** — disconnect the network, reload the app, OCR a
   small PDF. Everything should keep working.

---

## Database

No new migrations in this release. The existing v59 (year-scoped BAT
indexes) is the latest.

The new `sessions.db` is created automatically by
`better-sqlite3-session-store` on first boot — no migration step
needed.

---

## Behind the scenes

Verified in dev: production `vite build` clean, `npm run dev` boots
clean with all bumps live, login flow works end-to-end against the new
session store, calendar.jsx renders. Bundle size unchanged (Vite 8 is
strict about chunk-count parity with our `manualChunks` config).
