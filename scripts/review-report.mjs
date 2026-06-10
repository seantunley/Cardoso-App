// Codebase review report generator.
//
// Single source of truth for the 2026-06-10 full-codebase review. Emits:
//   docs/review/2026-06-10-codebase-review.md   — the ACTIONABLE backlog
//       (checkbox per item; tick them off / add notes over time in this file)
//   docs/review/2026-06-10-codebase-review.pdf   — a readable PDF snapshot
//
// Run:  node scripts/review-report.mjs
//
// To track progress, edit the .md (check the boxes, add owner/notes). Re-run
// this script only when you want a refreshed PDF from the encoded findings.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { jsPDF } from 'jspdf';

const META = {
  title: 'Cardoso App — Codebase Review',
  subtitle: 'Full-codebase bug / security / performance / architecture review',
  date: '10 June 2026',
  slug: '2026-06-10-codebase-review',
  intro:
    'Findings from a five-area review (backend routes, services/sync, frontend, ' +
    'security, architecture) across ~94K LOC. Each item has a stable reference (e.g. ' +
    'CRIT-1) for use in commits/PRs. Severity: P0 critical, P1 high, P2 medium, P3 low. ' +
    'Status starts Open; tick the checkbox in the .md as items are actioned.',
};

// severity → label
const SEV = { P0: 'P0 critical', P1: 'P1 high', P2: 'P2 medium', P3: 'P3 low' };

const SECTIONS = [
  {
    id: 'Critical Bugs', items: [
      { ref: 'CRIT-1', sev: 'P0', title: 'Every MSSQL pool is secretly the same global pool',
        loc: 'syncEngine.js:183, batReconciliation.js:160, jtiPool.js:88, customerSqlPool.js:79, connections.js:57',
        detail: "All six call sql.connect(config) — mssql's GLOBAL API, which ignores config if a pool already exists. Whoever connects first wins; a site with a separate BAT-only connection can import customers from the WRONG Sage DB; pool.close()/resetSagePool() in one module aborts in-flight queries in another. Likely source of 'Connection is closed' sync failures.",
        fix: "Use new sql.ConnectionPool(config).connect() per module; never sql.connect()." },
      { ref: 'CRIT-2', sev: 'P0', title: 'set-initial-password never clears must_change_password',
        loc: 'auth.js:205; statements.js:11',
        detail: "updateUserPassword is only UPDATE \"user\" SET password_hash=?. The audit log claims the flag is cleared but nothing clears it — affected users are forced through the set-password screen on EVERY login, silently rotating their password each time.",
        fix: "Add must_change_password=0 to the password-set update (and verify hub-pushed/seeded users)." },
      { ref: 'CRIT-3', sev: 'P0', title: 'Unmatched /api GETs hang forever in production (no JSON 404)',
        loc: 'server.js:292',
        detail: "The SPA catch-all does `if (!req.path.startsWith('/api')) res.sendFile()` — for /api/* it neither responds nor calls next(), and the referenced JSON 404 handler does not exist. Stale frontends hitting renamed endpoints tie up sockets until client timeout. Related: hub-redirect login GETs a POST-only endpoint (auth.js:100) so that flow cannot complete and logs the user out of the site.",
        fix: "Add a JSON 404 for unmatched /api/* after the catch-all; add a GET handler (or fix the redirect) for hub-token-login." },
    ]
  },
  {
    id: 'Permission Gaps', items: [
      { ref: 'PERM-1', sev: 'P1', title: 'Report JSON endpoints skip the guard their exports enforce',
        loc: 'reporting.js:1617 (aged-debtors), :1914 (rep-exposure), :1948/:2036/:2093 (BAT)',
        detail: "These are requireAuth only while their /export twins require can_access_reports. Any logged-in account can read the full debt ledger / rep exposure / BAT data as JSON.",
        fix: "Apply reportsGuard (can_access_reports) to the JSON endpoints to match the exports." },
      { ref: 'PERM-2', sev: 'P1', title: 'Auto-flag mutation/test endpoints are requireAuth-only',
        loc: 'records.js:634 (test-rule), :746 (apply-auto-flags), :791 (clear-auto-flags)',
        detail: "Any user can wipe every record's flags; test-rule also returns real customer balances/invoices. The hub twin correctly requires admin.",
        fix: "Add requireAdmin (or can_manage_rules) to match the hub equivalents." },
      { ref: 'PERM-3', sev: 'P2', title: 'Hub commission archive list/download vs bundle use different permissions',
        loc: 'hub.js:2315/2342 (can_access_monthly_reports) vs :2382 (can_access_commission)',
        detail: "Same data, two different permission keys — one is wrong. Site-side equivalents both use can_access_monthly_reports.",
        fix: "Standardise all three on can_access_monthly_reports." },
    ]
  },
  {
    id: 'Sync Correctness', items: [
      { ref: 'SYNC-1', sev: 'P1', title: 'Incremental sync misses updates made during the sync window',
        loc: 'hubEtl.js:181; reporting.js:2429',
        detail: "`since` is the hub-clock timestamp from AFTER the whole 30-60s sync finished, but sites filter on site-clock updated_date. Anything updated mid-sync (or under clock skew) is never re-pulled until the next Sage import rewrites it. A plausible source of the stale-data complaints.",
        fix: "Stamp `since` from records-fetch START minus a safety margin (or track max(updated_date) received). Upserts make re-pulls harmless." },
      { ref: 'SYNC-2', sev: 'P1', title: 'Site imports rewrite every row every 30 min, defeating incremental pull',
        loc: 'syncEngine.js:301-489',
        detail: "No change detection — unchanged rows still get a full UPDATE bumping updated_date/synced_at inside one synchronous transaction. Side effect: the hub then re-downloads the ENTIRE record set on every tick after each import.",
        fix: "Hash-compare `data` and skip no-op updates. Cuts site write churn and hub traffic ~95%." },
      { ref: 'SYNC-3', sev: 'P1', title: 'Hub ETL stages fail silently while the run is logged status=ok',
        loc: 'hubEtl.js (the 9 isolated pull stanzas) + 1015',
        detail: "Isolated stanzas log-and-skip to console only; a permanently-404ing endpoint (old site version) means stale hub tiles forever with zero operator signal. Violates the no-silent-failures rule.",
        fix: "logError per stanza failure + persist a partial-error status in hub_sync_log.error." },
      { ref: 'SYNC-4', sev: 'P2', title: 'hub_inventory prune uses one SQL placeholder per item (>32,766 SKUs fails)',
        loc: 'hubEtl.js:367-371',
        detail: "DELETE ... NOT IN (one ? per item). A site above SQLite's variable cap fails its whole sync every cycle; `since` never advances. The site side already fixed this with a temp-table anti-join (syncEngine.js:550); the hub side wasn't updated. Also: hub_records is never pruned, so cleared/renumbered records linger as ghosts.",
        fix: "Use a temp-table anti-join for the prune; add hub_records pruning." },
      { ref: 'SYNC-5', sev: 'P2', title: 'Hub Aged Debtors ledgerReady gate is global, not per-site',
        loc: 'reporting.js:1441-1458',
        detail: "Once ANY site's AR open-items land, sites whose ETL hasn't landed vanish from the report instead of falling back to the snapshot. Relevant to PR #389's staged rollout — it will transiently hide branches.",
        fix: "Make the ledger-vs-snapshot decision per site_id, not a global LIMIT 1." },
      { ref: 'SYNC-6', sev: 'P2', title: 'auto-sync-cycle fires all due imports concurrently, unawaited, errors swallowed',
        loc: 'scheduler.js:762-770',
        detail: "Two different connections run concurrently (triggers CRIT-1's pool clash); job_runs records 'succeeded' before imports finish; errors land only in console.error.",
        fix: "Await sequentially (like runScheduledSyncCycle) or Promise.allSettled + logError." },
      { ref: 'SYNC-7', sev: 'P2', title: 'probeSageHealth closes the shared pool on every probe failure',
        loc: 'batReconciliation.js:253',
        detail: "One 60s probe blip calls resetSagePool() → pool.close(), aborting whatever is mid-query (compounded by CRIT-1's global pool).",
        fix: "Mark the pool stale and let the next getSagePool() recreate; don't close under in-flight work." },
      { ref: 'SYNC-8', sev: 'P3', title: 'Cancel of Cardoso invoice generation reads the wrong (global) state',
        loc: 'batReconciliation.js:3958-4128',
        detail: "Cancellation checks read the global _activeGenerate (now nulled/replaced), so a cancelled run can complete and then wipe a newer run's lock, allowing two generations to interleave writes.",
        fix: "Capture a local run object and check me.cancelled; only clear the global if it still === me." },
    ]
  },
  {
    id: 'Money / UI Bugs', items: [
      { ref: 'UI-1', sev: 'P1', title: 'SA comma-decimal amount input parsed 100x too large',
        loc: 'CustomerSearch.jsx:40/57/90; lib/format.js:8',
        detail: "The amount-search input accepts commas but the parser strips them, so 11710,66 searches for R 1 171 066. parseAmount can't round-trip its own formatAmount output either.",
        fix: "Normalise SA format (strip spaces, comma→dot) before parseFloat; fix format.js round-trip + its wrong doc comment." },
      { ref: 'UI-2', sev: 'P2', title: 'Snapshot aging off by one day on UTC+2 host',
        loc: 'reporting.js:94-123',
        detail: "UTC-midnight parse vs local-midnight 'today' → same-day invoices compute as -1 days and are dropped; every bucket boundary shifts a day late.",
        fix: "Parse invoice dates at local midnight (or compute both in UTC) so day-diff is consistent." },
      { ref: 'UI-3', sev: 'P2', title: 'Destructive/admin actions silently no-op on failure',
        loc: 'HubDashboard.jsx:896 (force-resync), Layout.jsx:589 (app-update), Reconciliation.jsx:782 (refresh-sage), :383 (BAT settings load)',
        detail: "These do fetch with no res.ok check + bare catch. The BAT-settings one silently falls back to hard-coded TG/VAT rates and posts them into ledger generation (money-affecting). Violates no-silent-failures.",
        fix: "Check res.ok, surface a toast/error on failure, and fail loudly when saved rates can't load." },
      { ref: 'UI-4', sev: 'P2', title: 'keepPreviousData is dead API under react-query v5 + undebounced search',
        loc: 'CreditorSummary.jsx:192/310, CreditorSearch.jsx:48',
        detail: "v5 removed keepPreviousData (now placeholderData: keepPreviousData), so the vendor table + AP tiles blank/flash to R 0.00 on every keystroke, one request per character.",
        fix: "placeholderData: (prev)=>prev + a 250ms debounced value in the queryKey (CustomerBalances already does this)." },
      { ref: 'UI-5', sev: 'P3', title: 'Hub renders genuine R 0.00 as "—" (hub-mirrors-site violation)',
        loc: 'HubDashboard.jsx:38-43',
        detail: "formatAmount returns '—' for 0, so a real zero balance is indistinguishable from no-data; the site UI distinguishes them, so hub and site disagree for the same customer.",
        fix: "Distinguish empty (—) from zero (R 0.00), matching CustomerLookup." },
      { ref: 'UI-6', sev: 'P3', title: 'Flag-count tiles show 0 when the KPI endpoints fail',
        loc: 'CustomerSearch.jsx:555-570; HubTrends.jsx:21',
        detail: "queryFns catch→return null and tiles render ?? 0, so a DB-locked error displays 'Critical: 0 red flagged' — an affirmative wrong statement instead of an error state.",
        fix: "Surface an error/skeleton state instead of coercing failures to 0/[]" },
    ]
  },
  {
    id: 'Security', items: [
      { ref: 'SEC-1', sev: 'P1', title: 'Sage override validator is bypassable',
        loc: 'queryRegistry.js:476; commission.js:40',
        detail: "Keyword denylist that requires a leading SELECT/WITH does NOT block SELECT…INTO, OPENROWSET/OPENQUERY/BULK, WAITFOR DELAY, or (it allows leading ;) multi-statement. Admin-only, but the guardrail's job is to keep overrides read-only even for admins; if the Sage login has write rights this mutates the ERP DB.",
        fix: "Run overrides through a least-privilege READ-ONLY Sage login (DB enforces it); strip comments + block INTO/OPENROWSET/WAITFOR/xp_/sp_/second-statement as defense in depth." },
      { ref: 'SEC-2', sev: 'P2', title: 'Auto-update trusts GitHub release contents end-to-end (no signature check)',
        loc: 'system.js:80-91, 1218, 1297, 1629',
        detail: "Installer + checksum come from the same release; the .exe is run via Task Scheduler as SYSTEM, auto-hourly. A compromised repo/account propagates fleet-wide within an hour. (Repo pinned + host allowlist + HTTPS are good controls already.)",
        fix: "Verify Authenticode signature + publisher thumbprint before launch; sign the manifest with an off-repo key; prefer operator-approved tag over auto-latest." },
      { ref: 'SEC-3', sev: 'P2', title: 'Token compares non-constant-time; /api/backup/config defaults to FULL .env off-production',
        loc: 'reporting.js:156, backup.js:51/118',
        detail: "Token gates the full-DB download and the unredacted .env (SESSION_SECRET, ENCRYPTION_KEY). !== is timing-leaky (low risk over Tailscale). getBackupConfigExportMode() returns 'full' whenever NODE_ENV !== 'production' — a footgun if the service starts without that env.",
        fix: "crypto.timingSafeEqual (length-guard first); default config export to redacted/disabled, explicit opt-in for full." },
      { ref: 'SEC-4', sev: 'P3', title: 'Production CORS reflects any Origin with credentials',
        loc: 'server.js:119-125',
        detail: "origin callback always allows; currently blunted by sameSite:'strict' so it's latent, but any future cookie relaxation makes it cross-origin readable.",
        fix: "Reflect an explicit allowlist (own origin + hub origin) instead of cb(null,true)." },
      { ref: 'SEC-5', sev: 'P3', title: 'Session cookie secure=off on default LAN-HTTP install; raw errors returned to clients',
        loc: 'server.js:189; records.js:1363, reporting.js:951/992, server.js:284',
        detail: "Default HTTP install sends the session cookie cleartext on the local LAN segment. Several handlers return raw err.message (SQL/table fragments).",
        fix: "secure:true once TLS lands; return a generic message + keep detail in logError." },
    ]
  },
  {
    id: 'Performance', items: [
      { ref: 'PERF-1', sev: 'P1', title: 'Make precomputed rollup tables THE pattern for heavy reads',
        loc: 'reporting.js top-balances/top-items-mtd/dead-stock/aged-debtors; hub.js (28 GROUP BY endpoints)',
        detail: "Synchronous better-sqlite3 aggregation on the request path is the class that caused this week's production hangs. v099 point-fixed two endpoints; ~30 more aggregate per request (some load every row + JSON.parse, some run window functions over the whole item master).",
        fix: "Generalise the v099 rollup approach: rebuild at sync-end, both UIs read the same table; add rollup_meta staleness to /api/system/health." },
      { ref: 'PERF-2', sev: 'P2', title: 'Hub full-refreshes 7 datasets every 5 min when data changes nightly',
        loc: 'hubEtl.js:417-767',
        detail: "movement/item-sales/customer-sales/AR/AP/creditor/stock-receipt staged fully in memory + delete-all+reinsert, per site, ~288x/day, blocking the hub event loop — but the source changes once nightly.",
        fix: "Move these to hourly/nightly cadence or gate on a site-reported freshness stamp; keep only records/KPIs/BAT on the 5-min loop." },
      { ref: 'PERF-3', sev: 'P2', title: 'Heavy per-search / per-request scans',
        loc: 'records.js:332 (customer-by-amount, 20K rows x2 JSON.parse), batReconciliation.js:557 (integrity report N+1), inventoryMovement.js:13 (3yr window staged in one txn)',
        detail: "Operator-triggered or polled endpoints doing full scans / per-row JSON.parse / N+1 invariant checks synchronously on the main thread.",
        fix: "Trigger-maintained side tables for amount search; cache integrity results keyed on recon last-modified; trailing 1-2 month window for nightly inventory after backfill." },
      { ref: 'PERF-4', sev: 'P3', title: 'Frontend: undebounced search, idle 2s polling, unvirtualized vendor table',
        loc: 'CreditorSummary.jsx:310/439, OcrPanel.jsx:102',
        detail: "One request per keystroke; OCR snapshot polls every 2s while idle (~45 req/min from one tab); CreditorSummary renders the full vendor table without @tanstack/react-virtual (which other tables use).",
        fix: "Debounce keys; make refetchInterval a function of running state; virtualize the table." },
    ]
  },
  {
    id: 'Architecture', items: [
      { ref: 'ARCH-1', sev: 'P1', title: 'Define the site→hub dataset contract once',
        loc: 'hubEtl.js syncSite (9 copy-pasted pull stanzas) + reporting.js (8 copy-pasted serve endpoints)',
        detail: "One logical thing written ~20 times; field drift is invisible until a hub tile goes blank (the last three incidents). New dataset costs ~300 copy-pasted lines.",
        fix: "A HUB_DATASETS config table + one pullDataset() engine + a generated site router. Add a CONTRACT TEST per dataset (site fixture → pull → assert hub table) — the single highest-value missing test." },
      { ref: 'ARCH-2', sev: 'P1', title: 'Commit to rollup tables as the pattern (retire per-request aggregation)',
        loc: 'see PERF-1',
        detail: "Structural fix for the event-loop hang class; both hub+site reading one rollup enforces hub-mirrors-site by construction.",
        fix: "reporting_rollups.js with rebuildX() called at sync-end; migrate dashboard + aged-debtors/creditors + hub trends in small PRs." },
      { ref: 'ARCH-3', sev: 'P2', title: 'One isHubMode() instead of 40 scattered env checks',
        loc: '~40 process.env.HUB_MODE===\'true\'; 4 private isHub() copies (debtors/creditors/stockReceipts/inventoryMovement)',
        detail: "config/env.js validates HUB_MODE then everyone re-reads process.env raw. 18 reporting endpoints carry full dual implementations inline.",
        fix: "Export isHubMode() + split report builders' data acquisition per mode behind a small source interface; keep compute single-pathed." },
      { ref: 'ARCH-4', sev: 'P2', title: 'Split the giants along their natural seams; extract builders to services',
        loc: 'reporting.js (2995), hub.js (3722)',
        detail: "reporting.js is 3 modules (user reports / pure builders / the token-auth machine contract); builders being inline is why none are tested.",
        fix: "Move-only PRs: builders→service (+ first unit test), /api/reporting/*→own router, hub archives + trends routers." },
      { ref: 'ARCH-5', sev: 'P2', title: 'Highest-value test gap: hubEtl + dataset contract, then builders',
        loc: 'hubEtl.js (0 tests), report builders (0 tests), React (1 test / 186 files)',
        detail: "Coverage is inverted relative to risk — every incident this week was in untested code.",
        fix: "Contract test (ARCH-1), syncSite orchestration tests with stubbed fetch, builder unit tests as extracted." },
      { ref: 'ARCH-6', sev: 'P3', title: 'Write the migration index generator the header already claims exists',
        loc: 'db/migrations/index.js (refs missing scripts/_extract-migrations.mjs)',
        detail: "99 hand-maintained imports; a file present on disk but absent from index silently never runs (the failure shape the v62 gate was written for).",
        fix: "Write _extract-migrations.mjs (readdir+emit); extend the CI gate to diff and fail on a missing index entry." },
      { ref: 'ARCH-7', sev: 'P3', title: 'Standardise the route error funnel on logError + verbose messages',
        loc: 'reporting.js (12 logError vs ~24 raw console.error); some return raw err.message',
        detail: "Error handling is bimodal — hubEtl is the house-rule exemplar; many route catches discard the message and log nothing to the System Log.",
        fix: "routeErrorHandler(scope) helper that always logErrors with context + returns a stable message + error id; sweep one file per PR." },
    ]
  },
  {
    id: 'Feature Recommendations', items: [
      { ref: 'FEAT-1', sev: 'P2', title: 'Ops alerting on sync failures / staleness',
        loc: 'new',
        detail: "Sync failures land in the System Log only; nobody reads logs until a tile looks wrong.",
        fix: "Daily digest + immediate email/webhook on 'site unreachable >30 min' or 'dataset stale >24h'. Would have caught this week's issues early." },
      { ref: 'FEAT-2', sev: 'P2', title: 'Fleet version / freshness dashboard',
        loc: 'new (hub)',
        detail: "The hub knows each site's version + last-seen + data freshness.",
        fix: "One Operations panel: version / last-seen / freshness / pending update per site — replaces the 'did 5.9.1 land everywhere?' guesswork." },
      { ref: 'FEAT-3', sev: 'P2', title: 'Automated hub↔site reconciliation check',
        loc: 'new (nightly job)',
        detail: "Mechanically enforce the hub-mirrors-site rule instead of relying on review discipline.",
        fix: "Nightly compare per-site totals (debtor balance, AP outstanding, inventory value) hub-vs-site; flag drift." },
      { ref: 'FEAT-4', sev: 'P3', title: 'Staged / canary auto-update rollout',
        loc: 'system.js auto-update',
        detail: "A bad build currently fans out fleet-wide within the hour.",
        fix: "Update one canary site, verify health + version report, then fan out. Would have contained the 5.9 hang to one branch." },
      { ref: 'FEAT-5', sev: 'P3', title: 'Aged-debtors → collections worklist bridge',
        loc: 'new',
        detail: "You already have collections worklists + per-document aging.",
        fix: "Auto-feed 'new 21+ bucket entries' into a collections worklist — a small join with real business value." },
    ]
  },
];

// ---------------------------------------------------------------------------
// Markdown (the actionable backlog)
// ---------------------------------------------------------------------------
function toMarkdown() {
  const L = [];
  L.push(`# ${META.title}`);
  L.push('');
  L.push(`_${META.subtitle} — ${META.date}_`);
  L.push('');
  L.push(META.intro);
  L.push('');
  L.push('**How to use this file:** it is the live tracker. Tick the checkbox, add an owner and a `→ done in #PR` note as items are actioned. Reference items by their ref (e.g. `CRIT-1`) in commits/PRs.');
  L.push('');
  // summary table
  const counts = {};
  for (const s of SECTIONS) for (const it of s.items) counts[it.sev] = (counts[it.sev] || 0) + 1;
  const total = SECTIONS.reduce((n, s) => n + s.items.length, 0);
  L.push(`**${total} items** — ` + ['P0', 'P1', 'P2', 'P3'].map(k => `${counts[k] || 0} ${SEV[k]}`).join(' · '));
  L.push('');
  for (const s of SECTIONS) {
    L.push(`## ${s.id}`);
    L.push('');
    for (const it of s.items) {
      L.push(`- [ ] **${it.ref}** \`${it.sev}\` — **${it.title}**`);
      L.push(`  - **Where:** \`${it.loc}\``);
      L.push(`  - **What:** ${it.detail}`);
      L.push(`  - **Fix:** ${it.fix}`);
      L.push(`  - **Status:** Open · Owner: _—_ · Notes: _—_`);
      L.push('');
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// PDF (readable snapshot)
// ---------------------------------------------------------------------------
const sevColor = { P0: [185, 28, 28], P1: [194, 65, 12], P2: [161, 98, 7], P3: [55, 65, 81] };

function toPdf() {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const CW = W - M * 2;
  let y = M;

  const ensure = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
  const text = (s, opts = {}) => {
    const { size = 10, style = 'normal', color = [17, 24, 39], indent = 0, gap = 4, lead = 1.35 } = opts;
    doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(s, CW - indent);
    for (const ln of lines) { ensure(size * lead); doc.text(ln, M + indent, y); y += size * lead; }
    y += gap;
  };

  // Cover header
  doc.setFillColor(17, 24, 39); doc.rect(0, 0, W, 96, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(255, 255, 255);
  doc.text(META.title, M, 50);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(203, 213, 225);
  doc.text(`${META.subtitle}`, M, 70);
  doc.text(META.date, M, 86);
  y = 120;
  text(META.intro, { size: 10, color: [55, 65, 81], gap: 8 });

  const counts = {};
  for (const s of SECTIONS) for (const it of s.items) counts[it.sev] = (counts[it.sev] || 0) + 1;
  const total = SECTIONS.reduce((n, s) => n + s.items.length, 0);
  text(`${total} items:  ` + ['P0', 'P1', 'P2', 'P3'].map(k => `${counts[k] || 0} ${SEV[k]}`).join('    '),
    { size: 10, style: 'bold', gap: 12 });

  for (const s of SECTIONS) {
    ensure(40);
    // section bar
    doc.setFillColor(243, 244, 246); doc.rect(M - 6, y - 12, CW + 12, 22, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(17, 24, 39);
    doc.text(`${s.id}  (${s.items.length})`, M, y + 3); y += 22;

    for (const it of s.items) {
      ensure(60);
      // ref + severity chip + title
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...(sevColor[it.sev] || [0, 0, 0]));
      doc.text(`${it.ref}  [${it.sev}]`, M, y);
      doc.setTextColor(17, 24, 39);
      const titleLines = doc.splitTextToSize(it.title, CW - 96);
      doc.text(titleLines, M + 96, y);
      y += titleLines.length * 13 + 2;
      text(`Where: ${it.loc}`, { size: 8.5, style: 'italic', color: [107, 114, 128], indent: 10, gap: 2 });
      text(`What: ${it.detail}`, { size: 9.2, color: [31, 41, 55], indent: 10, gap: 2 });
      text(`Fix: ${it.fix}`, { size: 9.2, color: [21, 94, 117], indent: 10, gap: 9 });
    }
    y += 4;
  }

  // footer page numbers
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(156, 163, 175);
    doc.text(`Cardoso App — Codebase Review · ${META.date}`, M, H - 24);
    doc.text(`${p} / ${pages}`, W - M, H - 24, { align: 'right' });
  }
  return doc;
}

const outDir = path.join(process.cwd(), 'docs', 'review');
mkdirSync(outDir, { recursive: true });
const mdPath = path.join(outDir, `${META.slug}.md`);
const pdfPath = path.join(outDir, `${META.slug}.pdf`);
writeFileSync(mdPath, toMarkdown(), 'utf8');
writeFileSync(pdfPath, Buffer.from(toPdf().output('arraybuffer')));
console.log('Wrote:', path.relative(process.cwd(), mdPath));
console.log('Wrote:', path.relative(process.cwd(), pdfPath));
