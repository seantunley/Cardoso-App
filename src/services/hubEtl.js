/**
 * Hub ETL — extracted from server.js (US-010).
 *
 * Hub-mode table creation, site registry, sync-all-sites ETL,
 * and scheduled backup pull logic.
 */

import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, writeFileSync, renameSync, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import { getHubStorageRuntime } from '../hub/storage/runtime.js';
import { logError } from '../lib/errorLog.js';
import { trackOp } from '../lib/mainThreadWatch.js';
import { describeFetchError } from '../lib/errorDescribe.js';
import { siteBackupDirName, reconcileHubBackupDirs } from '../hub/siteBackupDir.js';

const { sqliteDb: db, repository: hubRepository } = getHubStorageRuntime();

// The records pull is incremental: the site returns datarecords whose
// updated_date is greater than `since`. `since` must come from the PREVIOUS
// run's START minus a safety margin — NOT its completed_at. completed_at is
// stamped 30-60s after records were fetched, so a record the site updates DURING
// the sync window (or one whose site clock trails the hub clock) has an
// updated_date below completed_at and would never be re-pulled until some later
// Sage import happened to rewrite it (SYNC-1, a source of stale hub tiles).
// started_at is before the fetch; the margin absorbs clock skew. Re-pulling the
// small overlap is harmless — the hub upserts.
const SINCE_SAFETY_MS = 5 * 60 * 1000;

/**
 * Build the `?since=...` query fragment for the incremental records pull from
 * the previous run's started_at (ISO), or '' for a first/full pull. Exported for
 * testing.
 */
export function incrementalSinceParam(lastStartedAtIso, marginMs = SINCE_SAFETY_MS) {
  if (!lastStartedAtIso) return '';
  const t = new Date(lastStartedAtIso).getTime();
  if (Number.isNaN(t)) return '';
  return `?since=${encodeURIComponent(new Date(t - marginMs).toISOString())}`;
}

async function checkBackupIntegrity(siteId, filePath) {
  let finalPath = filePath;
  let resultText = 'unchecked';
  let needsCorruptRename = false;

  // Open + integrity-check + close in a tight scope. The previous version
  // attempted renameSync(filePath, '...corrupt') while the SQLite handle
  // was STILL OPEN inside the same try block (close only happened in
  // finally), so on Windows the rename failed with EBUSY for every
  // corrupt-or-failing snapshot — the backup got recorded as
  // "EBUSY: resource busy or locked, rename ..." instead of the actual
  // integrity result, and the operator couldn't tell whether the file
  // was corrupt, locked, or both.
  let backupDb = null;
  try {
    backupDb = new BetterSqlite3(filePath, { readonly: true, fileMustExist: true });
    const rows = backupDb.prepare('PRAGMA integrity_check').all();
    const values = rows.map((row) => String(Object.values(row)[0] ?? '').trim()).filter(Boolean);
    const ok = values.length > 0 && values.every((value) => value.toLowerCase() === 'ok');
    resultText = ok ? 'ok' : JSON.stringify(values);
    needsCorruptRename = !ok;
  } catch (err) {
    resultText = err.message || 'integrity_check_failed';
    needsCorruptRename = true;
  } finally {
    try { backupDb?.close(); } catch (e) { console.warn('[hubEtl.integrity_check.close]', { filePath }, e.message); }
    backupDb = null;
  }

  // Rename AFTER close. If the rename still fails (antivirus / search
  // indexer briefly holding a handle on the just-closed file), retry with
  // exponential backoff — most Windows file-lock races resolve within ~1s.
  if (needsCorruptRename) {
    const corruptPath = `${filePath}.corrupt`;
    let renamed = false;
    for (let attempt = 1; attempt <= 5 && !renamed; attempt++) {
      try {
        renameSync(filePath, corruptPath);
        renamed = true;
        finalPath = corruptPath;
        console.warn(`[HUB BACKUP] ${siteId}: integrity check failed (${resultText}), renamed to ${path.basename(corruptPath)}`);
      } catch (err) {
        if (attempt === 5) {
          resultText = `${resultText} | rename_failed: ${err.message || 'unknown'}`;
          console.warn(`[HUB BACKUP] ${siteId}: rename to .corrupt failed after retries: ${err.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt - 1)));
        }
      }
    }
  }

  try {
    db.prepare(`
      INSERT INTO hub_backup_integrity (site_id, filename, result)
      VALUES (?, ?, ?)
    `).run(siteId, path.basename(finalPath), resultText);
  } catch (err) {
    console.warn(`[HUB BACKUP] ${siteId}: failed to record integrity result: ${err.message}`);
  }

  return { finalPath, integrity: resultText === 'ok' ? 'ok' : 'corrupt' };
}

// --- Hub table creation (only called when HUB_MODE === 'true') ---
function initHubTables() {
  hubRepository.ensureHubTables();
}

// --- Site registry from env ---
// HUB_SITES is parsed lazily inside initHubSiteRegistry() to avoid ES module
// import-hoisting race where dotenv hasn't run yet at module load time.
let HUB_SITES = [];

function isAllowedSiteUrl(url) {
  try {
    const u = new URL(url);
    // Only allow HTTP(S) to private/internal Tailscale IP ranges or localhost
    const host = u.hostname;
    const isPrivate = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(host);
    const isTailscale = host.endsWith('.ts.net') || /^(100\.([0-9]{1,3}\.){2})/.test(host);
    const isLocalhost = /^(localhost|127\.|::1)$/.test(host);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (isPrivate || isTailscale || isLocalhost);
  } catch (_) {
    return false;
  }
}

function initHubSiteRegistry() {
  try {
    HUB_SITES = JSON.parse(process.env.HUB_SITES || '[]');
  } catch (e) {
    console.error('[HUB] Invalid HUB_SITES JSON:', e.message);
    HUB_SITES = [];
  }

  // Validate every site URL before upserting — reject any site pointing outside allowed range
  const allowed = [];
  for (const site of HUB_SITES) {
    if (site.url && !isAllowedSiteUrl(site.url)) {
      console.warn(`[HUB] Site "${site.slug}" blocked: URL "${site.url}" is not in an allowed private range`);
      continue;
    }
    allowed.push(site);
  }
  HUB_SITES = allowed;
  hubRepository.upsertSites(HUB_SITES);
}

// Prune hub_inventory rows a site no longer returns (upsert-then-prune keeps the
// hub copy live). Stages the synced item numbers into a TEMP TABLE and anti-joins,
// rather than a `NOT IN (?, ?, …)` list: a site above SQLite's ~32,766 variable
// cap would otherwise throw on every cycle, failing the whole sync so `since`
// never advances (SYNC-4). Mirrors the site-side prune in syncEngine.js. Takes the
// db handle so it's unit-testable against an in-memory DB.
export function pruneHubInventory(database, siteId, itemNumbers) {
  if (!itemNumbers || itemNumbers.length === 0) return;
  const prune = database.transaction((items) => {
    database.exec('CREATE TEMP TABLE IF NOT EXISTS _hub_prune_inventory(item_number TEXT PRIMARY KEY)');
    database.exec('DELETE FROM _hub_prune_inventory');
    const insertTemp = database.prepare('INSERT OR IGNORE INTO _hub_prune_inventory(item_number) VALUES (?)');
    for (const item of items) insertTemp.run(item);
    database.prepare(`
      DELETE FROM hub_inventory
      WHERE site_id = ?
        AND item_number NOT IN (SELECT item_number FROM _hub_prune_inventory)
    `).run(siteId);
  });
  prune(itemNumbers);
}

// ── Yielding staged loads ──────────────────────────────────────────────
//
// better-sqlite3 transactions run synchronously ON THE MAIN THREAD — every
// API request and page in the whole app waits while one runs. Refreshing a
// big site's full AR/AP open-item set (tens of thousands of documents) in a
// single transaction with a JS upsert loop froze the entire app for seconds
// at a time, every ETL cycle (operator report: "the whole application
// hangs… a lot"; confirmed by the main-thread freeze forensics naming
// hub-etl ops). The fix is stage-and-swap:
//   1. chunkedStageLoad: INSERT the rows into a per-connection TEMP stage
//      table in chunks of STAGE_CHUNK, yielding to the event loop between
//      chunks so pending requests interleave;
//   2. the caller then runs ONE small transaction: DELETE the site's live
//      rows + INSERT … SELECT from the stage — a native bulk copy with no
//      JS loop inside, milliseconds even for huge sets;
//   3. and clears its stage rows inside that same transaction.
// Requests that run between chunks still see the OLD live rows, so the
// visible update stays exactly as atomic as the old single-transaction
// version. TEMP tables are per-connection (the app has one), so sites
// syncing concurrently just interleave rows keyed by site_id.
const STAGE_CHUNK = 800;
const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Takes the db handle (like pruneHubInventory) so it's unit-testable
// against an in-memory database.
export async function chunkedStageLoad(database, { ddl, clearSql, insertSql, rows, mapRow, siteId }) {
  database.exec(ddl);
  database.prepare(clearSql).run(siteId);
  const ins = database.prepare(insertSql);
  const insertChunk = database.transaction((chunk) => {
    for (const r of chunk) ins.run(...mapRow(r));
  });
  for (let i = 0; i < rows.length; i += STAGE_CHUNK) {
    insertChunk(rows.slice(i, i + STAGE_CHUNK));
    if (i + STAGE_CHUNK < rows.length) await yieldEventLoop();
  }
}

// --- ETL function ---
// ── ETL change-detection gate ─────────────────────────────────────────────
// The hub re-pulls each site's heavy datasets (inventory + the sales caches)
// every 5 minutes, but a site's inventory/sales only change ~once a day (after
// its nightly Sage sync). makeEtlGate lets syncSite skip the full re-pull of a
// dataset whose freshness token is byte-identical to the one stored from the
// last SUCCESSFUL pull. Safe by construction:
//   • A token is committed only AFTER its stage succeeds, so a failed/partial
//     pull never marks a dataset "current".
//   • shouldRun() refreshes unless BOTH a freshly-fetched token AND a stored
//     token exist and are equal — so a missing endpoint (old site version), an
//     errored/absent token, or a first-ever pull all refresh.
//   • Killable with HUB_ETL_CHANGE_GATE=0 (or off/false/no) → always refresh.
// Evaluated at CALL time, not module load: some entrypoints (node server.js via
// npm run server / install-service.bat) import this module before server.js
// runs dotenv.config(), so a module-level constant would miss a .env kill-switch
// (Codex review on PR #481). Reading process.env per call also lets the switch
// take effect without a restart.
function etlGateEnabled() {
  return !['0', 'off', 'false', 'no'].includes(
    String(process.env.HUB_ETL_CHANGE_GATE ?? '').trim().toLowerCase(),
  );
}

// Fetch a site's per-dataset freshness tokens. Returns {} on ANY failure
// (timeout, old-site 404, bad JSON) so the caller refreshes everything — the
// gate must never skip on uncertainty.
async function fetchEtlFreshness(site, headers) {
  if (!etlGateEnabled()) return {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${site.url}/api/reporting/etl-freshness`, { headers, signal: ctrl.signal });
    if (!res.ok) return {};
    const data = await res.json();
    return (data && typeof data.tokens === 'object' && data.tokens) ? data.tokens : {};
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}

// freshTokens: the dataset→token map fetched from the site this cycle ({} if the
// fetch failed → every shouldRun() returns true). storageKey lets stages that
// share one source token (the three sales stages all key off 'inventory_sales')
// still be skipped/committed independently, so one stage failing doesn't mark
// the others current.
function makeEtlGate(database, siteId, freshTokens) {
  const stored = {};
  try {
    for (const row of database.prepare('SELECT dataset, token FROM hub_site_etl_state WHERE site_id = ?').all(siteId)) {
      stored[row.dataset] = row.token;
    }
  } catch { /* table absent on a partial schema → no stored tokens → refresh all */ }

  const commitStmt = database.prepare(`
    INSERT INTO hub_site_etl_state (site_id, dataset, token, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(site_id, dataset) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at
  `);

  return {
    shouldRun(storageKey, tokenName) {
      if (!etlGateEnabled()) return true;
      const fresh = freshTokens[tokenName];
      if (fresh == null || fresh === '') return true;     // token unknown → refresh
      const prev = stored[storageKey];
      if (prev == null || prev === '') return true;       // never pulled → refresh
      return prev !== fresh;                               // changed → refresh
    },
    commit(storageKey, tokenName) {
      const fresh = freshTokens[tokenName];
      if (fresh == null || fresh === '') return;          // nothing reliable to store
      try { commitStmt.run(siteId, storageKey, fresh, new Date().toISOString()); }
      catch (e) { console.warn(`[hub-etl] ${siteId} could not store ETL token ${storageKey}: ${e.message}`); }
    },
    logSkip(label, tokenName) {
      console.log(`[hub-etl] ${siteId} ${label}: unchanged (token ${freshTokens[tokenName]}) — skipped full refresh`);
    },
  };
}

async function syncSite(site) {
  const startedAt = new Date().toISOString();
  let recordsFetched = 0;
  let syncError = null;

  // Each isolated pull stanza below catches its own failure so one bad dataset
  // doesn't abort the whole site. But a stanza that fails every tick (e.g. an
  // old site version permanently 404-ing an endpoint) used to log to the console
  // and nothing else — the run still recorded status='ok', so the hub tile went
  // stale forever with zero operator signal (SYNC-3, no-silent-failures). Each
  // stanza now routes its failure here: System Log via logError + accumulated so
  // the run is recorded status='partial' with the reasons in hub_sync_log.error.
  const stageErrors = [];
  const recordStageFailure = (stage, e) => {
    const msg = e?.message || String(e);
    console.log(`[hub-etl] ${stage} skipped for ${site.id}: ${msg}`);
    try { logError('hub.etl.stage', e, { site: site.id, site_url: site.url, stage }); } catch { /* logger is best-effort; the stanza already degraded gracefully */ }
    stageErrors.push(`${stage}: ${msg}`);
  };
  // True once the health check confirms the reporting endpoint answers. Lets the
  // catch tell a reachability failure (health check / TCP) apart from a downstream
  // data-pull timeout, so only genuine unreachability flips the site Offline.
  let reachable = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const headers = { 'X-Reporting-Token': site.token };

    // Health check
    const healthRes = await fetch(`${site.url}/api/reporting/health`, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
    reachable = true; // reporting endpoint answered — failures below are data-pull, not reachability

    // ETL change-detection — pull the site's current dataset tokens so the
    // heavy inventory/sales stages below can skip a full re-pull when nothing
    // changed since the last successful cycle. Any failure yields {} so those
    // stages refresh exactly as before (fail-safe — never a stale skip).
    const freshTokens = await fetchEtlFreshness(site, headers);
    const etlGate = makeEtlGate(db, site.id, freshTokens);

    // KPIs
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 10000);
    const kpisRes = await fetch(`${site.url}/api/reporting/kpis`, { headers, signal: ctrl2.signal });
    clearTimeout(t2);
    const kpis = kpisRes.ok ? await kpisRes.json() : null;

    // Kick off bat-summary EARLY so it runs in parallel with the
    // records + inventory pagination loops below. bat-summary is a
    // single tiny payload that's independent of records/inventory —
    // previously it was the LAST step in the sequential pipeline,
    // gated behind every records+inventory page completing. On a
    // site with 5K records that's up to 50s of needless waiting
    // before the BAT summary even fires. Fired now, awaited at the
    // bottom of the try block once everything else is done.
    //
    // Wrap a .catch so a dangling rejection (e.g. records throws
    // before we get to await batSummaryPromise) doesn't become an
    // unhandledRejection event. The downstream consumer treats a
    // null response as a transient bat-summary failure and logs it
    // without failing the whole sync.
    const ctrlBatEarly = new AbortController();
    const tBatEarly = setTimeout(() => ctrlBatEarly.abort(), 30_000);
    const batSummaryPromise = fetch(`${site.url}/api/reporting/bat-summary`, {
      headers,
      signal: ctrlBatEarly.signal,
    })
      .finally(() => clearTimeout(tBatEarly))
      .catch((err) => ({ ok: false, _earlyError: err }));

    // Last sync for the incremental pull — keyed on started_at (see
    // incrementalSinceParam / SINCE_SAFETY_MS above for why START not completed_at).
    // 'partial' counts: those runs DID complete the records pull (a partial
    // failure is in a downstream stanza, not the records pull, which fails to
    // status='error'), so `since` should advance.
    const lastSync = db.prepare(
      `SELECT started_at FROM hub_sync_log WHERE site_id=? AND status IN ('ok','partial') ORDER BY started_at DESC LIMIT 1`
    ).get(site.id);
    const sinceParam = incrementalSinceParam(lastSync?.started_at);

    // Records — paginate until has_more is false
    const upsertRec = db.prepare(`
      INSERT INTO hub_records (
        site_id, record_id, customer_number, customer_name, flag_color, flag_reason, flag_created_by,
        outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
        updated_date, synced_at, sales_rep, account_type
      ) VALUES (
        @site_id, @record_id, @customer_number, @customer_name, @flag_color, @flag_reason, @flag_created_by,
        @outstanding_balance, @unpaid_invoices, @receipts, @auto_flagged, @terms,
        @updated_date, @synced_at, @sales_rep, @account_type
      )
      ON CONFLICT(site_id, record_id) DO UPDATE SET
        customer_number=excluded.customer_number,
        customer_name=excluded.customer_name,
        flag_color=excluded.flag_color,
        flag_reason=excluded.flag_reason,
        flag_created_by=excluded.flag_created_by,
        outstanding_balance=excluded.outstanding_balance,
        unpaid_invoices=excluded.unpaid_invoices,
        receipts=excluded.receipts,
        auto_flagged=excluded.auto_flagged,
        terms=excluded.terms,
        updated_date=excluded.updated_date,
        synced_at=excluded.synced_at,
        sales_rep=excluded.sales_rep,
        account_type=excluded.account_type
    `);
    const insertMany = db.transaction((records) => {
      const now = new Date().toISOString();
      for (const r of records) {
        upsertRec.run({
          site_id: site.id,
          record_id: r.id,
          customer_number: r.customer_number,
          customer_name: r.customer_name,
          flag_color: r.flag_color || 'none',
          flag_reason: r.flag_reason || null,
          flag_created_by: r.flag_created_by || null,
          outstanding_balance: r.outstanding_balance || null,
          unpaid_invoices: r.unpaid_invoices || '[]',
          receipts: r.receipts || '[]',
          auto_flagged: r.auto_flagged ? 1 : 0,
          terms: r.terms || null,
          updated_date: r.updated_date,
          synced_at: now,
          sales_rep: r.sales_rep || null,
          account_type: r.account_type || null,
        });
      }
    });

    // Depth-2 pipeline: while the better-sqlite3 transaction inserts page N,
    // page N+1 is fetched in parallel. Insert order is preserved (we await
    // pages in offset order) so this is safe — the transaction for page N
    // is committed before page N+1 inserts. On a 5K-record site that's
    // 5 pages × ~RTT/2 saved instead of fully serialised round-trips.
    const fetchRecordsPage = async (pageOffset) => {
      const ctrl3 = new AbortController();
      const t3 = setTimeout(() => ctrl3.abort(), 10000);
      const pageUrl = `${site.url}/api/reporting/records${sinceParam}${sinceParam ? '&' : '?'}offset=${pageOffset}&limit=1000`;
      try {
        const recRes = await fetch(pageUrl, { headers, signal: ctrl3.signal });
        clearTimeout(t3);
        if (!recRes.ok) throw new Error(`Records fetch failed at offset ${pageOffset}: HTTP ${recRes.status}`);
        return await recRes.json();
      } finally {
        clearTimeout(t3);
      }
    };
    // Attach a no-op .catch() to every prefetched-but-not-yet-awaited
    // promise so that if `insertMany` throws (SQLite I/O / locking
    // error), the abandoned fetch's eventual rejection doesn't surface
    // as an unhandledRejection. The .catch chain creates a sibling
    // handler — when we DO await the original promise on the next
    // iteration, errors still propagate normally.
    const guardOrphan = (p) => { if (p) p.catch(() => {}); return p; };

    let offset = 0;
    let nextRecordsPromise = guardOrphan(fetchRecordsPage(0));
    while (true) {
      const recData = await nextRecordsPromise;
      const records = recData?.records || [];
      // Kick off the next page fetch BEFORE the synchronous insert so the
      // network round-trip overlaps with the better-sqlite3 transaction.
      const consumed = records.length;
      const willHaveMore = recData?.has_more === true && consumed > 0;
      nextRecordsPromise = willHaveMore ? guardOrphan(fetchRecordsPage(offset + consumed)) : null;

      if (consumed > 0) {
        if (offset === 0) {
          const sample = records[0];
          console.log(`[hub-etl-diag] Site ${site.name}: first record keys:`, Object.keys(sample).join(', '));
          console.log(`[hub-etl-diag] Site ${site.name}: account_type=${JSON.stringify(sample.account_type)}, sales_rep=${JSON.stringify(sample.sales_rep)}`);
        }
        insertMany(records);
        recordsFetched += consumed;
        offset += consumed;
      }
      if (!nextRecordsPromise) break;
    }

    // Inventory — full refresh (skipped when the site reports unchanged inventory)
    inventoryStage: {
    if (!etlGate.shouldRun('inventory', 'inventory')) { etlGate.logSkip('inventory', 'inventory'); break inventoryStage; }
    const upsertInv = db.prepare(`
      INSERT INTO hub_inventory (site_id, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, synced_at)
      VALUES (@site_id, @item_number, @item_description, @qty_on_hand, @last_cost, @price_list, @price, @stocking_uom, @commodity, @inventory_value, @synced_at)
      ON CONFLICT(site_id, item_number) DO UPDATE SET
        item_description=excluded.item_description,
        qty_on_hand=excluded.qty_on_hand,
        last_cost=excluded.last_cost,
        price_list=excluded.price_list,
        price=excluded.price,
        stocking_uom=excluded.stocking_uom,
        commodity=excluded.commodity,
        inventory_value=excluded.inventory_value,
        synced_at=excluded.synced_at
    `);
    // Trim every string field at ingest. Sage source data carries
    // trailing space padding on most CHAR columns (e.g. item_number
    // "74                      " not "74") which would otherwise cause
    // joins against the clean numbers in hub_inventory_sales to miss —
    // surfaced 2026-05-29 as blank descriptions + 0 qty on Hub Inventory
    // Movement. Trimming at write keeps storage canonical.
    const trim = (v) => (typeof v === 'string' ? v.trim() : v);
    const insertInventory = db.transaction((invRecords) => {
      const now = new Date().toISOString();
      for (const r of invRecords) {
        upsertInv.run({
          site_id: site.id,
          item_number: trim(r.item_number),
          item_description: trim(r.item_description) || null,
          qty_on_hand: trim(r.qty_on_hand) || null,
          last_cost: trim(r.last_cost) || null,
          price_list: trim(r.price_list) || null,
          price: trim(r.price) || null,
          stocking_uom: trim(r.stocking_uom) || null,
          commodity: trim(r.commodity) || null,
          inventory_value: trim(r.inventory_value) || null,
          synced_at: now,
        });
      }
    });
    // Same depth-2 pipeline pattern as the records loop above — overlap the
    // next page fetch with the current page's insert transaction.
    const fetchInvPage = async (pageOffset) => {
      const ctrlInv = new AbortController();
      const tInv = setTimeout(() => ctrlInv.abort(), 10000);
      const invUrl = `${site.url}/api/reporting/inventory?offset=${pageOffset}&limit=1000`;
      try {
        const invRes = await fetch(invUrl, { headers, signal: ctrlInv.signal });
        clearTimeout(tInv);
        if (!invRes.ok) throw new Error(`Inventory fetch failed at offset ${pageOffset}: HTTP ${invRes.status}`);
        return await invRes.json();
      } finally {
        clearTimeout(tInv);
      }
    };
    const syncedItemNumbers = [];
    let invOffset = 0;
    // Same orphan-rejection guard pattern as the records loop above —
    // see the comment around guardOrphan().
    let nextInvPromise = guardOrphan(fetchInvPage(0));
    while (true) {
      const invData = await nextInvPromise;
      const invRecords = invData?.records || [];
      const consumed = invRecords.length;
      const willHaveMore = invData?.has_more === true && consumed > 0;
      nextInvPromise = willHaveMore ? guardOrphan(fetchInvPage(invOffset + consumed)) : null;
      if (consumed > 0) {
        insertInventory(invRecords);
        // Must trim here too — insertInventory canonicalises item_number
        // via trim(), so the prune DELETE below uses the same form.
        // Skipping the trim would delete every just-inserted row (DELETE
        // matches trimmed stored values against padded source values).
        for (const r of invRecords) {
          if (r.item_number) syncedItemNumbers.push(typeof r.item_number === 'string' ? r.item_number.trim() : r.item_number);
        }
        invOffset += consumed;
      }
      if (!nextInvPromise) break;
    }
    // Prune hub_inventory rows no longer in the site's query (upsert-then-prune)
    pruneHubInventory(db, site.id, syncedItemNumbers);
    etlGate.commit('inventory', 'inventory');
    } // end inventoryStage

    // AR document summary (per-branch "Sales Figures") — tiny payload (one row
    // per month over the current+prior FY), single fetch. Clear-and-reload the
    // branch's rows each cycle so dropped months don't linger.
    try {
      const ctrlAr = new AbortController();
      const tAr = setTimeout(() => ctrlAr.abort(), 20000);
      let arData;
      try {
        const arRes = await fetch(`${site.url}/api/reporting/ar-document-summary`, { headers, signal: ctrlAr.signal });
        if (!arRes.ok) throw new Error(`HTTP ${arRes.status}`);
        arData = await arRes.json();
      } finally { clearTimeout(tAr); }
      const arMonths = Array.isArray(arData?.months) ? arData.months : [];
      const upsertArDoc = db.prepare(`
        INSERT OR REPLACE INTO hub_ar_document_summary
          (site_id, ym, inv_excl, inv_vat, inv_incl, cn_excl, cn_vat, cn_incl, dn_excl, dn_vat, dn_incl, synced_at)
        VALUES (@site_id, @ym, @inv_excl, @inv_vat, @inv_incl, @cn_excl, @cn_vat, @cn_incl, @dn_excl, @dn_vat, @dn_incl, @synced_at)`);
      db.transaction(() => {
        db.prepare('DELETE FROM hub_ar_document_summary WHERE site_id = ?').run(site.id);
        const now = new Date().toISOString();
        for (const m of arMonths) {
          if (!m?.month) continue;
          upsertArDoc.run({
            site_id: site.id, ym: m.month, synced_at: now,
            inv_excl: Number(m.invoices?.excl) || 0, inv_vat: Number(m.invoices?.vat) || 0, inv_incl: Number(m.invoices?.incl) || 0,
            cn_excl: Number(m.credit_notes?.excl) || 0, cn_vat: Number(m.credit_notes?.vat) || 0, cn_incl: Number(m.credit_notes?.incl) || 0,
            dn_excl: Number(m.debit_notes?.excl) || 0, dn_vat: Number(m.debit_notes?.vat) || 0, dn_incl: Number(m.debit_notes?.incl) || 0,
          });
        }
      })();
    } catch (e) {
      console.warn(`[HUB] AR document summary sync failed for ${site.slug || site.id}: ${e.message}`);
    }

    // Invoice profit day totals (per-branch profit by day) — INCREMENTAL.
    //
    // The branch aggregates in SQL and returns one row per trading day, so even a
    // two-year backfill is ~600 rows. We still pull incrementally, because a cold
    // branch reading two years of OE invoice + credit-note lines out of Sage took
    // 85 seconds on first run and under a second once warm.
    //
    // Each run re-pulls a trailing 30-day window from the newest day we already
    // hold (or backfills from Jan of last year if we hold nothing). The trailing
    // window matters: invoices get posted late, so yesterday's total is not final
    // and the last few weeks have to be allowed to move. Days outside the window
    // are left alone, which is why this deletes by RANGE rather than by site.
    //
    // Week, month and year are NOT stored — the hub derives them from these day
    // rows when it renders, so a rollup can never disagree with its own days.
    try {
      const isoToday = new Date().toISOString().slice(0, 10);
      const newest = db.prepare('SELECT MAX(day) AS d FROM hub_invoice_profit_day WHERE site_id = ?').get(site.id)?.d;
      const from = newest
        ? new Date(Date.parse(`${newest}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10)
        : `${new Date().getFullYear() - 1}-01-01`;

      const ctrlPr = new AbortController();
      // 180s, not the 20s the AR summary uses: a first-run backfill on a cold
      // branch is slow, and a timeout here costs a whole day of totals. Later
      // runs return in under a second.
      const tPr = setTimeout(() => ctrlPr.abort(), 180000);
      let prData;
      try {
        const url = `${site.url}/api/reporting/invoice-profit-totals?from=${from}&to=${isoToday}`;
        const prRes = await fetch(url, { headers, signal: ctrlPr.signal });
        if (!prRes.ok) throw new Error(`HTTP ${prRes.status}`);
        prData = await prRes.json();
      } finally { clearTimeout(tPr); }

      const days = Array.isArray(prData?.days) ? prData.days : [];
      const upsertDay = db.prepare(`
        INSERT OR REPLACE INTO hub_invoice_profit_day
          (site_id, day, selling, cost, profit, invoice_count, credit_note_count, synced_at)
        VALUES (@site_id, @day, @selling, @cost, @profit, @invoice_count, @credit_note_count, @synced_at)`);
      db.transaction(() => {
        // Clear only the window we just re-read, so a day that legitimately
        // dropped to nothing is removed rather than left frozen at its old value,
        // while history outside the window survives.
        db.prepare('DELETE FROM hub_invoice_profit_day WHERE site_id = ? AND day >= ? AND day <= ?')
          .run(site.id, prData?.from || from, prData?.to || isoToday);
        const now = new Date().toISOString();
        // Written whether or not any days came back: a branch that legitimately
        // traded nothing in the window has synced successfully and must not be
        // reported as missing.
        db.prepare(`
          INSERT OR REPLACE INTO hub_invoice_profit_sync (site_id, synced_at, window_from, window_to, day_count)
          VALUES (?, ?, ?, ?, ?)`).run(site.id, now, prData?.from || from, prData?.to || isoToday, days.length);
        for (const d of days) {
          if (!d?.day) continue;
          upsertDay.run({
            site_id: site.id,
            day: String(d.day),
            selling: Number(d.selling) || 0,
            cost: Number(d.cost) || 0,
            profit: Number(d.profit) || 0,
            invoice_count: Number(d.invoice_count) || 0,
            credit_note_count: Number(d.credit_note_count) || 0,
            synced_at: now,
          });
        }
      })();
    } catch (e) {
      // Through recordStageFailure, not a bare console.warn: the footer decides
      // status='partial' from stageErrors, so a warn-only catch recorded the run
      // as 'ok'. The report's own empty state tells operators to check
      // Hub -> Sync Log when totals are missing — that instruction has to lead
      // somewhere true.
      recordStageFailure('Invoice profit totals', e);
    }

    // Inventory movement (sales velocity cache) — paginated fetch using
    // the same pattern as the inventory sync above. Each page is 1000
    // rows with a 10s timeout; large sites with many SKUs × months no
    // longer risk aborting on a single oversized response.
    //
    // All pages are collected in memory first, then the delete+insert
    // runs in a single transaction. This prevents a partial replace if
    // a later page fetch fails — the old data stays intact until a
    // fully successful sync completes.
    movementStage: {
    if (!etlGate.shouldRun('inv_sales_movement', 'inventory_sales')) { etlGate.logSkip('inventory movement', 'inventory_sales'); break movementStage; }
    try {
      const fetchMovPage = async (pageOffset) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const url = `${site.url}/api/reporting/inventory-movement?offset=${pageOffset}&limit=1000`;
        try {
          const res = await fetch(url, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`Inventory movement fetch failed at offset ${pageOffset}: HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return data;
        } finally {
          clearTimeout(t);
        }
      };

      // Stage: collect all pages before touching the DB.
      const allMovRecords = [];
      let movOffset = 0;
      let nextMovPromise = guardOrphan(fetchMovPage(0));
      while (true) {
        const movData = await nextMovPromise;
        const movRecords = movData?.records || [];
        const consumed = movRecords.length;
        const willHaveMore = movData?.has_more === true && consumed > 0;
        nextMovPromise = willHaveMore ? guardOrphan(fetchMovPage(movOffset + consumed)) : null;
        for (const r of movRecords) allMovRecords.push(r);
        movOffset += consumed;
        if (!nextMovPromise) break;
      }

      // Swap: atomic delete + insert in one transaction.
      const upsertMov = db.prepare(`
        INSERT INTO hub_inventory_sales (site_id, item_number, period, qty_sold, revenue, order_count, last_sale_date, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, now_local())
        ON CONFLICT(site_id, item_number, period) DO UPDATE SET
          qty_sold=excluded.qty_sold, revenue=excluded.revenue,
          order_count=excluded.order_count, last_sale_date=excluded.last_sale_date,
          synced_at=excluded.synced_at
      `);
      db.transaction(() => {
        db.prepare('DELETE FROM hub_inventory_sales WHERE site_id = ?').run(site.id);
        for (const r of allMovRecords) {
          upsertMov.run(site.id, r.item_number, r.period, r.qty_sold || 0, r.revenue || 0, r.order_count || 0, r.last_sale_date || null);
        }
      })();
      etlGate.commit('inv_sales_movement', 'inventory_sales');
    } catch (movErr) {
      recordStageFailure('Inventory movement', movErr);
    }
    } // end movementStage

    // Inventory item sales (inter-branch transfers excluded) → for the dashboard
    // Top Items + Dead Stock tiles. Same paginate → stage → atomic-swap pattern.
    itemSalesStage: {
    if (!etlGate.shouldRun('inv_sales_item', 'inventory_sales')) { etlGate.logSkip('inventory item-sales', 'inventory_sales'); break itemSalesStage; }
    try {
      const fetchItemPage = async (pageOffset) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const url = `${site.url}/api/reporting/inventory-item-sales?offset=${pageOffset}&limit=5000`;
        try {
          const res = await fetch(url, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`Inventory item-sales fetch failed at offset ${pageOffset}: HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return data;
        } finally { clearTimeout(t); }
      };
      const allItemRecords = [];
      let itemOffset = 0;
      let nextItemPromise = guardOrphan(fetchItemPage(0));
      while (true) {
        const itemData = await nextItemPromise;
        const recs = itemData?.records || [];
        const consumed = recs.length;
        const willHaveMore = itemData?.has_more === true && consumed > 0;
        nextItemPromise = willHaveMore ? guardOrphan(fetchItemPage(itemOffset + consumed)) : null;
        for (const r of recs) allItemRecords.push(r);
        itemOffset += consumed;
        if (!nextItemPromise) break;
      }
      const upsertItem = db.prepare(`
        INSERT INTO hub_inventory_item_sales (site_id, item_number, item_description, period, qty_sold, revenue, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, now_local())
        ON CONFLICT(site_id, item_number, period) DO UPDATE SET
          item_description=excluded.item_description, qty_sold=excluded.qty_sold,
          revenue=excluded.revenue, synced_at=excluded.synced_at
      `);
      db.transaction(() => {
        db.prepare('DELETE FROM hub_inventory_item_sales WHERE site_id = ?').run(site.id);
        for (const r of allItemRecords) {
          upsertItem.run(site.id, r.item_number, r.item_description || null, r.period, r.qty_sold || 0, r.revenue || 0);
        }
      })();
      etlGate.commit('inv_sales_item', 'inventory_sales');
    } catch (itemErr) {
      recordStageFailure('Inventory item-sales', itemErr);
    }
    } // end itemSalesStage

    // Item -> vendor master (ICITMV-backed) → vendor attribution for the hub
    // Sales-by-Vendor report. Small (~2.4k rows): single fetch, clear + insert.
    try {
      const ctrlIv = new AbortController();
      const tIv = setTimeout(() => ctrlIv.abort(), 15000);
      let ivRes;
      try { ivRes = await fetch(`${site.url}/api/reporting/item-vendors`, { headers, signal: ctrlIv.signal }); }
      finally { clearTimeout(tIv); }
      if (ivRes.ok) {
        const data = await ivRes.json();
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const insIv = db.prepare('INSERT OR REPLACE INTO hub_item_vendor (site_id, item_number, vendor_code, vendor_name, synced_at) VALUES (?, ?, ?, ?, now_local())');
        db.transaction(() => {
          db.prepare('DELETE FROM hub_item_vendor WHERE site_id = ?').run(site.id);
          for (const r of rows) {
            const item = String(r.item_number || '').trim();
            if (!item) continue;
            insIv.run(site.id, item, r.vendor_code || null, r.vendor_name || null);
          }
        })();
      } else {
        recordStageFailure('Item vendors', new Error(`item-vendors returned HTTP ${ivRes.status} from ${site.url}/api/reporting/item-vendors`));
      }
    } catch (ivErr) {
      recordStageFailure('Item vendors', ivErr);
    }

    // Inventory customer sales (inter-branch transfers excluded) → for the
    // dashboard Top Customers tile (summed over the selected timeline).
    custSalesStage: {
    if (!etlGate.shouldRun('inv_sales_customer', 'inventory_sales')) { etlGate.logSkip('inventory customer-sales', 'inventory_sales'); break custSalesStage; }
    try {
      const fetchCustPage = async (pageOffset) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const url = `${site.url}/api/reporting/inventory-customer-sales?offset=${pageOffset}&limit=5000`;
        try {
          const res = await fetch(url, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`Inventory customer-sales fetch failed at offset ${pageOffset}: HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return data;
        } finally { clearTimeout(t); }
      };
      const allCustRecords = [];
      let custOffset = 0;
      let nextCustPromise = guardOrphan(fetchCustPage(0));
      while (true) {
        const custData = await nextCustPromise;
        const recs = custData?.records || [];
        const consumed = recs.length;
        const willHaveMore = custData?.has_more === true && consumed > 0;
        nextCustPromise = willHaveMore ? guardOrphan(fetchCustPage(custOffset + consumed)) : null;
        for (const r of recs) allCustRecords.push(r);
        custOffset += consumed;
        if (!nextCustPromise) break;
      }
      const upsertCust = db.prepare(`
        INSERT INTO hub_inventory_customer_sales (site_id, customer_code, customer_name, period, revenue, qty, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, now_local())
        ON CONFLICT(site_id, customer_code, period) DO UPDATE SET
          customer_name=excluded.customer_name, revenue=excluded.revenue,
          qty=excluded.qty, synced_at=excluded.synced_at
      `);
      db.transaction(() => {
        db.prepare('DELETE FROM hub_inventory_customer_sales WHERE site_id = ?').run(site.id);
        for (const r of allCustRecords) {
          upsertCust.run(site.id, r.customer_code, r.customer_name || null, r.period, r.revenue || 0, r.qty || 0);
        }
      })();
      etlGate.commit('inv_sales_customer', 'inventory_sales');
    } catch (custErr) {
      recordStageFailure('Inventory customer-sales', custErr);
    }
    } // end custSalesStage

    // Debtor AR open items → hub_debtor_ar_invoice, so Aged Debtors ages
    // per-document at the hub. Paginate → stage → atomic full-refresh per site.
    try {
      const fetchArPage = async (pageOffset) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const url = `${site.url}/api/reporting/ar-open-items?offset=${pageOffset}&limit=5000`;
        try {
          const res = await fetch(url, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`AR open-items fetch failed at offset ${pageOffset}: HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return data;
        } finally { clearTimeout(t); }
      };
      const allArRecords = [];
      let arOffset = 0;
      let nextArPromise = guardOrphan(fetchArPage(0));
      while (true) {
        const arData = await nextArPromise;
        const recs = arData?.records || [];
        const consumed = recs.length;
        const willHaveMore = arData?.has_more === true && consumed > 0;
        nextArPromise = willHaveMore ? guardOrphan(fetchArPage(arOffset + consumed)) : null;
        for (const r of recs) allArRecords.push(r);
        arOffset += consumed;
        if (!nextArPromise) break;
      }
      // Stage-and-swap (see chunkedStageLoad above) — the old version did the
      // whole set in one transaction with a JS upsert loop, blocking the
      // entire app for its duration.
      await chunkedStageLoad(db, {
        ddl: `CREATE TEMP TABLE IF NOT EXISTS stage_debtor_ar (
          site_id TEXT, customer_code TEXT, reporting_account TEXT, document_number TEXT,
          document_type TEXT, document_date TEXT, due_date TEXT,
          original_amount REAL, outstanding_amount REAL, reference TEXT)`,
        clearSql: 'DELETE FROM stage_debtor_ar WHERE site_id = ?',
        insertSql: 'INSERT INTO stage_debtor_ar VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        rows: allArRecords,
        siteId: site.id,
        // reporting_account rolls national-account children up to the parent on
        // the hub (buildAgedDebtorsReport joins/aggregates by it); falls back to
        // the child code, matching debtorSync + the v093 backfill.
        mapRow: (r) => [site.id, r.customer_code, r.reporting_account || r.customer_code || null, r.document_number, r.document_type || null, r.document_date || null, r.due_date || null, r.original_amount || 0, r.outstanding_amount || 0, r.reference || null],
      });
      db.transaction(() => {
        db.prepare('DELETE FROM hub_debtor_ar_invoice WHERE site_id = ?').run(site.id);
        // INSERT OR REPLACE keeps the old upsert's last-one-wins behaviour for
        // feeds that repeat (site_id, customer_code, document_number) in one pull.
        db.prepare(`
          INSERT OR REPLACE INTO hub_debtor_ar_invoice
            (site_id, customer_code, reporting_account, document_number, document_type, document_date, due_date, original_amount, outstanding_amount, reference, synced_at)
          SELECT site_id, customer_code, reporting_account, document_number, document_type, document_date, due_date, original_amount, outstanding_amount, reference, now_local()
          FROM stage_debtor_ar WHERE site_id = ?
        `).run(site.id);
        db.prepare('DELETE FROM stage_debtor_ar WHERE site_id = ?').run(site.id);
      })();
      // Mark this site's AR open-item sync as COMPLETED — even when it returned
      // zero open items — so Aged Debtors ages it from the (now-empty) ledger
      // instead of falling back to its possibly-stale hub_records snapshot (SYNC-5).
      db.prepare(`INSERT INTO hub_debtor_ar_sync (site_id, synced_at) VALUES (?, now_local())
        ON CONFLICT(site_id) DO UPDATE SET synced_at = excluded.synced_at`).run(site.id);
    } catch (arErr) {
      recordStageFailure('Debtor AR open-items', arErr);
    }

    // Creditor AP open items → hub_creditor_ap_invoice, so Aged Creditors works
    // at the hub. Paginate → stage → atomic full-refresh per site.
    try {
      const fetchApPage = async (pageOffset) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const url = `${site.url}/api/reporting/ap-open-items?offset=${pageOffset}&limit=5000`;
        try {
          const res = await fetch(url, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`AP open-items fetch failed at offset ${pageOffset}: HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return data;
        } finally { clearTimeout(t); }
      };
      const allApRecords = [];
      let apOffset = 0;
      let nextApPromise = guardOrphan(fetchApPage(0));
      while (true) {
        const apData = await nextApPromise;
        const recs = apData?.records || [];
        const consumed = recs.length;
        const willHaveMore = apData?.has_more === true && consumed > 0;
        nextApPromise = willHaveMore ? guardOrphan(fetchApPage(apOffset + consumed)) : null;
        for (const r of recs) allApRecords.push(r);
        apOffset += consumed;
        if (!nextApPromise) break;
      }
      // Stage-and-swap (see chunkedStageLoad above) — same main-thread-freeze
      // fix as the AR block.
      await chunkedStageLoad(db, {
        ddl: `CREATE TEMP TABLE IF NOT EXISTS stage_creditor_ap (
          site_id TEXT, vendor_code TEXT, document_number TEXT, document_type TEXT,
          document_date TEXT, due_date TEXT,
          original_amount REAL, outstanding_amount REAL, reference TEXT)`,
        clearSql: 'DELETE FROM stage_creditor_ap WHERE site_id = ?',
        insertSql: 'INSERT INTO stage_creditor_ap VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        rows: allApRecords,
        siteId: site.id,
        mapRow: (r) => [site.id, r.vendor_code, r.document_number, r.document_type || null, r.document_date || null, r.due_date || null, r.original_amount || 0, r.outstanding_amount || 0, r.reference || null],
      });
      db.transaction(() => {
        db.prepare('DELETE FROM hub_creditor_ap_invoice WHERE site_id = ?').run(site.id);
        db.prepare(`
          INSERT OR REPLACE INTO hub_creditor_ap_invoice
            (site_id, vendor_code, document_number, document_type, document_date, due_date, original_amount, outstanding_amount, reference, synced_at)
          SELECT site_id, vendor_code, document_number, document_type, document_date, due_date, original_amount, outstanding_amount, reference, now_local()
          FROM stage_creditor_ap WHERE site_id = ?
        `).run(site.id);
        db.prepare('DELETE FROM stage_creditor_ap WHERE site_id = ?').run(site.id);
      })();
    } catch (apErr) {
      recordStageFailure('Creditor AP open-items', apErr);
    }

    // Creditor master → hub_creditor, so Aged Creditors can join vendor name /
    // terms / last_payment_date. The report's default paid_only=true filter needs
    // last_payment_date, so without this the default hub view stays empty even
    // though the AP open items are present.
    try {
      const fetchCredPage = async (pageOffset) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const url = `${site.url}/api/reporting/creditors?offset=${pageOffset}&limit=5000`;
        try {
          const res = await fetch(url, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`Creditor master fetch failed at offset ${pageOffset}: HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return data;
        } finally { clearTimeout(t); }
      };
      const allCredRecords = [];
      let credOffset = 0;
      let nextCredPromise = guardOrphan(fetchCredPage(0));
      while (true) {
        const credData = await nextCredPromise;
        const recs = credData?.records || [];
        const consumed = recs.length;
        const willHaveMore = credData?.has_more === true && consumed > 0;
        nextCredPromise = willHaveMore ? guardOrphan(fetchCredPage(credOffset + consumed)) : null;
        for (const r of recs) allCredRecords.push(r);
        credOffset += consumed;
        if (!nextCredPromise) break;
      }
      const upsertCred = db.prepare(`
        INSERT INTO hub_creditor (site_id, vendor_code, vendor_name, terms, contact, phone, email, is_active, last_receipt_date, last_payment_date, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now_local())
        ON CONFLICT(site_id, vendor_code) DO UPDATE SET
          vendor_name=excluded.vendor_name, terms=excluded.terms, contact=excluded.contact,
          phone=excluded.phone, email=excluded.email, is_active=excluded.is_active,
          last_receipt_date=excluded.last_receipt_date, last_payment_date=excluded.last_payment_date,
          synced_at=excluded.synced_at
      `);
      db.transaction(() => {
        db.prepare('DELETE FROM hub_creditor WHERE site_id = ?').run(site.id);
        for (const r of allCredRecords) {
          upsertCred.run(site.id, r.vendor_code, r.vendor_name || null, r.terms || null, r.contact || null, r.phone || null, r.email || null, r.is_active ?? 1, r.last_receipt_date || null, r.last_payment_date || null);
        }
      })();
    } catch (credErr) {
      recordStageFailure('Creditor master', credErr);
    }

    // Stock receipt expiry — read-only hub copy for cross-site visibility.
    // Paginated fetch (1000 rows / 10s per page), stage all pages in
    // memory, then atomic delete+insert so a mid-page failure leaves
    // existing data intact.
    try {
      const fetchSrePage = async (pageOffset) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const url = `${site.url}/api/reporting/stock-receipt-expiry?offset=${pageOffset}&limit=1000`;
        try {
          const res = await fetch(url, { headers, signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`Stock receipt expiry fetch failed at offset ${pageOffset}: HTTP ${res.status}`);
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          return data;
        } finally {
          clearTimeout(t);
        }
      };

      const allSreRecords = [];
      let sreOffset = 0;
      let nextSrePromise = guardOrphan(fetchSrePage(0));
      while (true) {
        const sreData = await nextSrePromise;
        const sreRecords = sreData?.records || [];
        const consumed = sreRecords.length;
        const willHaveMore = sreData?.has_more === true && consumed > 0;
        nextSrePromise = willHaveMore ? guardOrphan(fetchSrePage(sreOffset + consumed)) : null;
        for (const r of sreRecords) allSreRecords.push(r);
        sreOffset += consumed;
        if (!nextSrePromise) break;
      }

      const insertSre = db.prepare(`
        INSERT INTO hub_stock_receipt_expiry (
          site_id, receipt_number, supplier_name, receipt_date,
          receipt_line_id, line_no, item_number, item_description,
          qty_received, uom, unit_cost,
          expiry_date, qty_at_expiry, entered_by, entry_source, notes, expiry_created,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now_local())
      `);
      db.transaction(() => {
        db.prepare('DELETE FROM hub_stock_receipt_expiry WHERE site_id = ?').run(site.id);
        for (const r of allSreRecords) {
          insertSre.run(
            site.id, r.receipt_number, r.supplier_name, r.receipt_date,
            r.receipt_line_id, r.line_no, r.item_number, r.item_description,
            r.qty_received, r.uom, r.unit_cost,
            r.expiry_date || null, r.qty_at_expiry || null, r.entered_by || null,
            r.entry_source || null, r.notes || null, r.expiry_created || null,
          );
        }
      })();
    } catch (sreErr) {
      recordStageFailure('Stock receipt expiry', sreErr);
    }

    // BAT Reconciliation summary — recorded into hub_bat_summary.
    // The fetch was kicked off in parallel right after KPIs (above),
    // so by this point the response is usually already in flight or
    // complete — we just consume the prefetched promise here.
    // Failures here are logged but don't fail the whole sync (the
    // customer-records ETL is the primary purpose of this run).
    try {
      const batRes = await batSummaryPromise;
      if (batRes.ok) {
        const bat = await batRes.json();
        db.prepare(`
          INSERT INTO hub_bat_summary (
            site_id, total_supplier, total_sage, total_variance,
            weeks_count, matched_count, mismatch_count, awaiting_count,
            missing_weeks_count,
            summary_year, last_paid_week, last_paid_year,
            last_bat_week, last_bat_year,
            missing_credit_notes_weeks, mismatch_weeks,
            total_exceptions, total_exception_amount,
            last_upload_at, synced_at, last_error
          ) VALUES (
            @site_id, @total_supplier, @total_sage, @total_variance,
            @weeks_count, @matched_count, @mismatch_count, @awaiting_count,
            @missing_weeks_count,
            @summary_year, @last_paid_week, @last_paid_year,
            @last_bat_week, @last_bat_year,
            @missing_credit_notes_weeks, @mismatch_weeks,
            @total_exceptions, @total_exception_amount,
            @last_upload_at, @synced_at, NULL
          )
          ON CONFLICT(site_id) DO UPDATE SET
            total_supplier=excluded.total_supplier,
            total_sage=excluded.total_sage,
            total_variance=excluded.total_variance,
            weeks_count=excluded.weeks_count,
            matched_count=excluded.matched_count,
            mismatch_count=excluded.mismatch_count,
            awaiting_count=excluded.awaiting_count,
            missing_weeks_count=excluded.missing_weeks_count,
            summary_year=excluded.summary_year,
            last_paid_week=excluded.last_paid_week,
            last_paid_year=excluded.last_paid_year,
            last_bat_week=excluded.last_bat_week,
            last_bat_year=excluded.last_bat_year,
            missing_credit_notes_weeks=excluded.missing_credit_notes_weeks,
            mismatch_weeks=excluded.mismatch_weeks,
            total_exceptions=excluded.total_exceptions,
            total_exception_amount=excluded.total_exception_amount,
            last_upload_at=excluded.last_upload_at,
            synced_at=excluded.synced_at,
            last_error=NULL
        `).run({
          site_id: site.id,
          total_supplier: bat.total_supplier || 0,
          total_sage: bat.total_sage || 0,
          total_variance: bat.total_variance || 0,
          weeks_count: bat.weeks_count || 0,
          matched_count: bat.matched_count || 0,
          mismatch_count: bat.mismatch_count || 0,
          awaiting_count: bat.awaiting_count || 0,
          // Sites running an older version that doesn't return these fields
          // will arrive as undefined; defaults below keep the writes clean
          // and old sites just show 0 / null on the per-site card until
          // they upgrade.
          missing_weeks_count: bat.missing_weeks_count || 0,
          summary_year: bat.summary_year ?? null,
          last_paid_week: bat.last_paid_week ?? null,
          last_paid_year: bat.last_paid_year ?? null,
          last_bat_week: bat.last_bat_week ?? null,
          last_bat_year: bat.last_bat_year ?? null,
          missing_credit_notes_weeks: Array.isArray(bat.missing_credit_notes_weeks)
            ? JSON.stringify(bat.missing_credit_notes_weeks) : null,
          mismatch_weeks: Array.isArray(bat.mismatch_weeks)
            ? JSON.stringify(bat.mismatch_weeks) : null,
          total_exceptions: bat.total_exceptions || 0,
          total_exception_amount: bat.total_exception_amount || 0,
          last_upload_at: bat.last_upload_at || null,
          synced_at: new Date().toISOString(),
        });
      } else {
        const msg = batRes._earlyError
          ? `BAT summary fetch failed — ${describeFetchError(batRes._earlyError, `${site.url}/api/reporting/bat-summary`).slice(0, 400)}`
          : `BAT summary fetch returned HTTP ${batRes.status} from ${site.url}/api/reporting/bat-summary`;
        db.prepare(`
          INSERT INTO hub_bat_summary (site_id, last_error, synced_at)
          VALUES (?, ?, ?)
          ON CONFLICT(site_id) DO UPDATE SET last_error=excluded.last_error, synced_at=excluded.synced_at
        `).run(site.id, msg, new Date().toISOString());
        recordStageFailure('BAT summary', new Error(msg));
      }
    } catch (batErr) {
      const msg = describeFetchError(batErr, `${site.url}/api/reporting/bat-summary`).slice(0, 500);
      db.prepare(`
        INSERT INTO hub_bat_summary (site_id, last_error, synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET last_error=excluded.last_error, synced_at=excluded.synced_at
      `).run(site.id, msg, new Date().toISOString());
      recordStageFailure('BAT summary', batErr);
    }

    // BAT exceptions (per-week detail) — pulled into hub_bat_exceptions for the
    // hub "Exceptions by Week" report (grouped site -> week). Cleared and
    // re-inserted per site each sync. Best-effort: a failure here is logged and
    // never fails the whole run (records ETL is the primary purpose).
    try {
      const ctrlExc = new AbortController();
      const tExc = setTimeout(() => ctrlExc.abort(), 30_000);
      let excRes;
      try {
        excRes = await fetch(`${site.url}/api/reporting/bat-exceptions-detail?year=all`, { headers, signal: ctrlExc.signal });
      } finally { clearTimeout(tExc); }
      if (excRes.ok) {
        const payload = await excRes.json();
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const now = new Date().toISOString();
        const ins = db.prepare(`
          INSERT INTO hub_bat_exceptions
            (site_id, year, week_number, order_number, branch_code, customer,
             delivery_date, pod_uploaded_date, ocr, invoice, exception_reason,
             amount, is_missing_pod, synced_at)
          VALUES (@site_id, @year, @week_number, @order_number, @branch_code, @customer,
             @delivery_date, @pod_uploaded_date, @ocr, @invoice, @exception_reason,
             @amount, @is_missing_pod, @synced_at)
        `);
        db.transaction(() => {
          db.prepare('DELETE FROM hub_bat_exceptions WHERE site_id = ?').run(site.id);
          for (const r of rows) {
            ins.run({
              site_id: site.id,
              year: r.year ?? null,
              week_number: r.week_number ?? null,
              order_number: r.order_number ?? null,
              branch_code: r.branch_code ?? null,
              customer: r.customer ?? null,
              delivery_date: r.delivery_date ?? null,
              pod_uploaded_date: r.pod_uploaded_date ?? null,
              ocr: r.ocr ?? null,
              invoice: r.invoice ?? null,
              exception_reason: r.exception_reason ?? null,
              // Preserve "unknown" (null) — a blank BAT amount is not a real R0.00.
              amount: (r.amount === null || r.amount === undefined) ? null
                : (Number.isFinite(Number(r.amount)) ? Number(r.amount) : null),
              is_missing_pod: r.is_missing_pod ? 1 : 0,
              synced_at: now,
            });
          }
        })();
      } else {
        recordStageFailure('BAT exceptions', new Error(`bat-exceptions-detail returned HTTP ${excRes.status} from ${site.url}/api/reporting/bat-exceptions-detail`));
      }
    } catch (excErr) {
      recordStageFailure('BAT exceptions', excErr);
    }

    // Update hub_sites
    // Promote the site→Accpac freshness/status/error fields from the
    // kpis JSON blob to dedicated columns so the dashboard tile can
    // colour-code without parsing JSON on every render. The tile shows
    // last_accpac_synced_at as the user-visible "data freshness" line
    // (vs last_seen which is when the HUB last pulled). last_accpac_status
    // drives the tile colour; last_accpac_error gives the operator the
    // actual reason ("ELOGIN", "ESOCKET", etc. via describeSqlError).
    //
    // last_accpac_synced_at and last_accpac_status use COALESCE so a
    // null kpis value (kpis call returned ok but the site has no
    // non-BAT-only connections, so this field is genuinely empty in
    // the response) does NOT wipe a valid existing value. Without
    // COALESCE, the optimistic stamp from the trigger flow (PR #238)
    // had a useful lifetime of "until the next syncSite tick" — at
    // most 5 minutes, after which a successful sync that lacked the
    // field erased it back to null and the operator's tile reverted
    // to "(not yet reported)". Same protection covers a stamp the hub
    // pulled successfully on a previous tick: if the site momentarily
    // stops reporting it, we keep the last known good value rather
    // than erasing it.
    //
    // last_accpac_error needs three-way logic, not COALESCE:
    //   - new error in kpis → store it (replace any stale prior error)
    //   - kpis explicitly status='ok' AND no error → clear (the prior
    //     cause is no longer current; leaving it shown would mislead)
    //   - null kpis / unknown → preserve (we have no signal either way)
    const kpisAccpacAt     = kpis?.site_accpac_last_synced_at || null;
    const kpisAccpacStatus = kpis?.site_accpac_status         || null;
    const kpisAccpacError  = kpis?.site_accpac_error          || null;
    db.prepare(`
      UPDATE hub_sites SET
        last_seen = ?,
        last_kpis = ?,
        status = 'ok',
        last_accpac_synced_at = COALESCE(?, last_accpac_synced_at),
        last_accpac_status    = COALESCE(?, last_accpac_status),
        last_accpac_error     = CASE
                                  WHEN ? IS NOT NULL THEN ?      -- new error reported → store it
                                  WHEN ? = 'ok'      THEN NULL   -- kpis explicitly OK → clear stale error
                                  ELSE last_accpac_error          -- null kpis or unknown → preserve
                                END
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      kpis ? JSON.stringify(kpis) : null,
      kpisAccpacAt,
      kpisAccpacStatus,
      kpisAccpacError, kpisAccpacError,
      kpisAccpacStatus,
      site.id,
    );

  } catch (err) {
    // describeFetchError unwraps undici "fetch failed" → real cause + URL.
    // For non-fetch errors (e.g. SQLite from insertMany / upsertInv) the
    // helper just returns err.message verbatim, so this is safe to use as
    // a single funnel.
    syncError = describeFetchError(err, site.url);
    const raw = String(err?.message || err);
    const isConnError = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(raw);
    // Only flip the site Offline for genuine UNREACHABILITY: the health check
    // itself failed (we never confirmed the reporting endpoint is up), or a
    // connection-level error dropped the link mid-sync. A downstream data-pull
    // TIMEOUT / HTTP / SQLite error means the site is reachable but the hub pull
    // failed — leave hub_sites.status to the health-ping (that was the flip-flop).
    // Distinguishing these also stops a site that drops just after a ping from
    // rendering online for up to the 15-minute ping interval.
    //
    // In NEITHER case touch last_accpac_status/last_accpac_error: those are the
    // SITE's Accpac sync state, written only from the KPI response (success path).
    // A hub-side pull failure here is unrelated to Accpac, so writing 'error'
    // would show a false Accpac failure on the dashboard footer. The pull failure
    // is recorded in hub_sync_log (status='error', below) and the verbose System
    // Log, so it isn't silenced.
    if (!reachable || isConnError) {
      db.prepare(`UPDATE hub_sites SET status='error' WHERE id=?`).run(site.id);
    }

    // Verbose, plain-English log so an operator can triage from the System
    // Log alone without source-diving. Default fetch errors ("fetch failed",
    // "This operation was aborted") are too cryptic — they don't say which
    // site, which fetch, or what to do about it.
    const siteLabel = site.name || site.slug;
    let friendlyMsg;
    if (/aborted/i.test(raw)) {
      friendlyMsg =
        `Hub-to-site sync timed out for site "${siteLabel}" at ${site.url}. ` +
        `One of the fetches (health check, KPIs, records, inventory, or BAT summary) didn't ` +
        `respond within its timeout window — the site service either took too long to answer ` +
        `or the network link is slow. ` +
        `Likely causes: (1) the site service is hung or under heavy load — open Operations on ` +
        `the site box and check OCR / sync activity, (2) the network link to the site is slow ` +
        `or down — verify Tailscale / VPN connectivity from the hub, (3) the site box is in ` +
        `low-resource swap-thrash. ` +
        `Test from the hub: curl ${site.url}/api/reporting/health -H 'x-reporting-token: <token>'`;
    } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(raw)) {
      friendlyMsg =
        `Hub-to-site sync could not reach site "${siteLabel}" at ${site.url}. ` +
        `The TCP connection failed before any HTTP exchange — the site service is not listening ` +
        `on this URL. ` +
        `Most likely cause: the Cardoso service was wiped on the site box (a known bug in pre-` +
        `2026.5.4 installers removed the service before extracting new files; if extraction failed, ` +
        `the service was never recreated — fixed in PR #234). ` +
        `Operator action: log into the site machine and run "Get-Service CardosoCigarettes". ` +
        `If the service is missing, re-run the latest CardosoSetup-vX.X.X.exe on the site box ` +
        `to reinstall. If the service is present but stopped, start it; if it crashes on start, ` +
        `check ${site.url ? new URL(site.url).host : 'site'}'s logs/service-error.log. ` +
        `Underlying error: ${raw}.`;
    } else if (/no such column/i.test(raw)) {
      friendlyMsg =
        `Hub-to-site sync failed for site "${siteLabel}" with a SQL schema error. ` +
        `Underlying error: ${raw}. ` +
        `This means a database migration didn't run on this hub — most commonly the lost v62 ` +
        `migration (added back in PR #228 / release 2026.5.3) for the last_accpac_synced_at columns. ` +
        `Operator action: confirm the hub itself is on 2026.5.3 or later (Operations → Updates), ` +
        `then restart the Cardoso service on the hub so migrations re-run on boot.`;
    } else if (/CHECK constraint failed/i.test(raw)) {
      friendlyMsg =
        `Hub-to-site sync failed for site "${siteLabel}" with a SQL CHECK-constraint error. ` +
        `Underlying error: ${raw}. ` +
        `A code path tried to write a value that the schema CHECK doesn't allow — usually because ` +
        `a feature added a new value (e.g. resource_type='site') without coordinating a schema ` +
        `migration. Operator action: check that the hub is on the latest release; if it is, this ` +
        `may be a fresh constraint regression and should be reported.`;
    } else {
      friendlyMsg =
        `Hub-to-site sync failed for site "${siteLabel}" at ${site.url}. ` +
        `Underlying error did not match a known pattern. Raw error: ${raw}. ` +
        `Check the site's own System Log (open ${site.url} → Operations → System Log) for the ` +
        `corresponding inbound failure, and verify the site service is healthy.`;
    }
    logError('hub.sync', new Error(friendlyMsg), {
      site_slug: site.slug,
      site_id: site.id,
      site_name: site.name,
      site_url: site.url,
      raw_error: raw,
      err_kind: err?.constructor?.name,
      err_code: err?.code,
    });
  }

  // status: 'error' = the whole site sync failed (records pull / fatal); 'partial'
  // = records synced but one or more downstream stanzas failed (recorded in
  // error so the operator sees WHICH); 'ok' = clean. A fatal error dominates.
  const finalStatus = syncError ? 'error' : (stageErrors.length ? 'partial' : 'ok');
  const finalError = syncError || (stageErrors.length ? stageErrors.join(' | ') : null);
  db.prepare(`
    INSERT INTO hub_sync_log (site_id, started_at, completed_at, records_fetched, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(site.id, startedAt, new Date().toISOString(), recordsFetched, finalStatus, finalError);

  return { site_id: site.id, site_slug: site.slug, records_fetched: recordsFetched, error: syncError };
}

async function syncAllSites() {
  console.log(`[HUB] Syncing ${HUB_SITES.length} site(s)...`);
  // Bounded concurrency: sync sites in batches of 3 to avoid DB connection exhaustion
  const CONCURRENCY = 3;
  const results = [];
  for (let i = 0; i < HUB_SITES.length; i += CONCURRENCY) {
    const batch = HUB_SITES.slice(i, i + CONCURRENCY);
    // trackOp: each site's ETL runs large synchronous better-sqlite3
    // transactions on the main thread — if the app stalls/freezes during
    // one, the freeze forensics name the site instead of logging a mystery.
    const batchResults = await Promise.allSettled(batch.map((site) => {
      const doneOp = trackOp(`hub-etl:${site.slug || site.id}`);
      return syncSite(site).finally(doneOp);
    }));
    results.push(...batchResults);
  }
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      console.log(`[HUB] ${r.value.site_slug}: ${r.value.records_fetched} records, error=${r.value.error || 'none'}`);
    } else {
      console.error('[HUB] Unexpected error:', r.reason);
    }
  });
}

// Pull backup for ONE site. Extracted so both the daily cron
// (runHubBackupPull) and the on-demand site→hub notification path
// (POST /api/hub/notify-backup-ready, fired by the Backup-Now button
// on the site) can share the same download + integrity-check + env-
// config + retention-prune logic. Errors are caught + logged inside;
// caller doesn't need to handle.
//
// Returns { ok, file, integrity, error? } so callers that want to
// surface the result (the on-demand path returns this back to the
// site, which surfaces it in the operator's toast) can do so.
async function pullBackupForSite(site) {
  try {
    // Reconcile THIS site's backup folders FIRST — BEFORE the network fetch.
    // Earlier this ran only after a 2xx download, so a renamed/offline site
    // (download fails → early return) never migrated, and because the read
    // paths resolve canonical → exact legacy <id> only, Hub Backups/DR could
    // show no snapshots exactly when the renamed site is down. Running it up
    // front migrates the legacy <id> / older <oldName>-<id> folder to the
    // canonical <name>-<id> regardless of whether the download below succeeds.
    // Also covers POST /api/hub/notify-backup-ready, which calls this directly.
    const hubBackupsBase = path.join(process.cwd(), 'database', 'hub-backups');
    try {
      reconcileHubBackupDirs(hubBackupsBase, [site], { allSites: hubRepository.listSitesForBackup() });
    } catch (e) { console.warn('[HUB BACKUP] per-site reconcile failed:', e.message); }

    const controller = new AbortController();
    // 5 min cap — DB snapshots can run several MB over Tailscale; the
    // previous 60 s ceiling routinely killed legitimate transfers.
    const hardTimeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    const upstream = await fetch(`${site.url}/api/backup/download`, {
      headers: { 'x-reporting-token': site.token || '' },
      signal: controller.signal,
    });
    clearTimeout(hardTimeout);
    if (!upstream.ok) {
      // Best-effort body capture — many sites return a JSON {error: "..."}
      // or a plain text reason on 4xx/5xx; it's the difference between
      // "we got 503" and "we got 503: backup file not yet generated, try
      // again in 30s."
      //
      // We pull bytes off the stream directly instead of using
      // upstream.text() — text() buffers the ENTIRE response into
      // memory before we get a chance to slice it, so a misbehaving
      // proxy returning a multi-megabyte HTML error page would spike
      // hub RSS during exactly the failure path operators are most
      // likely to hit. Stream-read with an explicit byte cap and
      // cancel the rest of the body as soon as we have enough.
      //
      // SEPARATE timeout for this read, independent of hardTimeout
      // above. hardTimeout was cleared as soon as fetch returned —
      // fine for a successful download (the pipeline below has its
      // own progress) but a stalling/trickling error body has nothing
      // bounding it. Without this guard, one site whose proxy returns
      // headers fast then hangs on the body would block this call
      // indefinitely; runHubBackupPull awaits batches via
      // Promise.allSettled, so the whole batch (and any later batches)
      // would be held up by that one stuck site.
      //
      // Read failures still don't mask the error — we record the
      // status line + URL either way; if the read stalled we annotate
      // bodyDetail so the operator can tell the body never arrived.
      const BODY_BYTE_CAP = 2048;        // small read window
      const BODY_CHAR_CAP = 500;         // what actually lands in the log
      const BODY_READ_TIMEOUT_MS = 10_000;
      let bodyDetail = '';
      let bodyTimedOut = false;
      try {
        if (upstream.body) {
          const reader = upstream.body.getReader();
          const chunks = [];
          let total = 0;
          const bodyTimer = setTimeout(() => {
            bodyTimedOut = true;
            // cancel() rejects any in-flight read() — caught inside
            // the loop so we exit cleanly with whatever bytes arrived.
            try { reader.cancel(); } catch (e) { console.error('[hubEtl.stream_close]', { siteId: site.id, phase: 'body_timeout_cancel' }, e.message); }
          }, BODY_READ_TIMEOUT_MS);
          try {
            while (total < BODY_BYTE_CAP) {
              try {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
                total += value.byteLength;
              } catch {
                // Most commonly: our cancel() above. Stop reading;
                // the bodyTimedOut flag is checked below.
                break;
              }
            }
          } finally {
            clearTimeout(bodyTimer);
            // Release the connection so the upstream can stop sending.
            try { await reader.cancel(); } catch (e) { console.error('[hubEtl.stream_close]', { siteId: site.id, phase: 'finally_cancel' }, e.message); }
          }
          let prefix = '';
          if (total > 0) {
            const merged = Buffer.concat(
              chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
            );
            prefix = merged
              .subarray(0, BODY_BYTE_CAP)
              .toString('utf8')
              .trim()
              .slice(0, BODY_CHAR_CAP);
          }
          if (bodyTimedOut) {
            bodyDetail = prefix
              ? `: (body read timed out after ${BODY_READ_TIMEOUT_MS}ms; partial: ${prefix})`
              : `: (body read timed out after ${BODY_READ_TIMEOUT_MS}ms; no bytes received)`;
          } else if (prefix) {
            bodyDetail = `: ${prefix}`;
          }
        }
      } catch {
        // ignore — body read failure shouldn't mask the status code
      }
      const friendly =
        `HTTP ${upstream.status}${upstream.statusText ? ' ' + upstream.statusText : ''}` +
        bodyDetail +
        ` — url=${site.url}/api/backup/download`;
      logError('hub.backupPull', new Error(friendly), {
        site_name: site.name,
        site_id: site.id,
        site_url: site.url,
        http_status: upstream.status,
        friendly,
      });
      try {
        db.prepare(`INSERT INTO hub_backup_integrity (site_id, filename, result) VALUES (?, ?, ?)`)
          .run(site.id, '(download failed)', `pull_failed: ${friendly}`);
      } catch (e) { console.error('[hubEtl.integrity_log]', { siteId: site.id, phase: 'http_error_row' }, e.message); }
      return { ok: false, error: friendly };
    }
    // Folder named by the site's readable name (e.g. "Ermelo"), not the opaque
    // id, so the hub-backups/ tree is legible. The .db filename keeps the id
    // for uniqueness + integrity-record keying. (Reconcile already ran at the
    // top of this function, before the download.)
    const dir = path.join(hubBackupsBase, siteBackupDirName(site));
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `cardoso-${site.id}-${ts}.db`);
    // Stream the response body straight to disk instead of buffering the
    // whole DB in memory. A 200 MB site DB used to spike RSS by 200 MB
    // and block the event loop during the sync writeFileSync.
    await pipeline(Readable.fromWeb(upstream.body), createWriteStream(file));

    // Two independent post-pipeline tasks: integrity check (local file
    // I/O + SQLite) and .env config fetch (HTTP round-trip to the site).
    // They share no state, so run them in parallel — saves the env
    // round-trip per site, which on a Tailscale link is ~50–500ms.
    const integrityP = checkBackupIntegrity(site.id, file);
    const envP = (async () => {
      // Also pull the site's .env config alongside the db so disaster
      // recovery has both. Sites that have BACKUP_CONFIG_EXPORT_MODE=disabled
      // will return 403 — log and continue. Whether secrets are redacted
      // depends on the site's BACKUP_CONFIG_EXPORT_MODE setting.
      try {
        const envCtrl = new AbortController();
        const envTimeout = setTimeout(() => envCtrl.abort(), 30_000);
        const envRes = await fetch(`${site.url}/api/backup/config`, {
          headers: { 'x-reporting-token': site.token || '' },
          signal: envCtrl.signal,
        });
        clearTimeout(envTimeout);
        if (envRes.ok) {
          const envText = await envRes.text();
          const mode = envRes.headers.get('x-backup-config-mode') || 'unknown';
          const envFile = path.join(dir, `config-${site.id}-${ts}.env`);
          writeFileSync(envFile, envText, 'utf8');
          console.log(`[HUB BACKUP] ${site.name}: saved .env config (${envText.length} bytes, mode=${mode})`);
        } else if (envRes.status === 403) {
          console.log(`[HUB BACKUP] ${site.name}: .env export disabled on site (BACKUP_CONFIG_EXPORT_MODE=disabled)`);
        } else {
          console.warn(`[HUB BACKUP] ${site.name}: .env fetch HTTP ${envRes.status}`);
        }
      } catch (envErr) {
        // Don't let a config-pull failure mark the whole site backup as failed.
        console.warn(`[HUB BACKUP] ${site.name}: .env fetch failed — ${describeFetchError(envErr, `${site.url}/api/backup/config`)}`);
      }
    })();

    const [integrity] = await Promise.all([integrityP, envP]);
    console.log(`[HUB BACKUP] ${site.name}: streamed -> ${integrity.finalPath} [${integrity.integrity}]`);

    // BAT preview JPEGs — stored on the site at uploads/bat-previews/
    // (one <extractionId>.jpg per OCR'd row). Without these, restoring
    // a site from a hub backup would lose every preview the operator
    // can use to manually enter an invoice number when OCR didn't
    // match. The site exposes them as a streaming zip via
    // /api/backup/bat-previews; we save it alongside the .db. Sized
    // generously (5 min timeout) because previews dirs run 100-500 MB.
    //
    // Best-effort: a sites that's never run OCR returns an empty zip
    // (200 with X-Backup-Preview-Count: 0). A failure here doesn't
    // fail the whole backup; we still have the .db + .env. Operator
    // restoring will see the empty/missing zip and know they have no
    // previews to restore — better than the .db pull silently failing
    // because of a previews issue.
    let previewsResult = { ok: false, count: 0 };
    const previewFile = path.join(dir, `bat-previews-${site.id}-${ts}.zip`);
    try {
      const prevCtrl = new AbortController();
      const prevTimeout = setTimeout(() => prevCtrl.abort(), 5 * 60 * 1000);
      const prevRes = await fetch(`${site.url}/api/backup/bat-previews`, {
        headers: { 'x-reporting-token': site.token || '' },
        signal: prevCtrl.signal,
      });
      clearTimeout(prevTimeout);
      if (prevRes.ok) {
        const previewCount = parseInt(prevRes.headers.get('x-backup-preview-count') || '0', 10);
        const expectedSize = parseInt(prevRes.headers.get('content-length') || '', 10);
        await pipeline(Readable.fromWeb(prevRes.body), createWriteStream(previewFile));
        const { statSync, unlinkSync } = await import('fs');
        const previewSize = statSync(previewFile).size;
        // Empty store-mode zip is 22 bytes (EOCD only). Anything smaller
        // is a truncated/aborted download that would silently look like
        // a valid 0-file snapshot to a future restore.
        const MIN_ZIP_BYTES = 22;
        if (previewSize < MIN_ZIP_BYTES) {
          try { unlinkSync(previewFile); } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file: previewFile, reason: 'too_small' }, e.message); }
          console.warn(`[HUB BACKUP] ${site.name}: BAT previews fetch returned ${previewSize} bytes — too small to be a valid zip; deleted.`);
          previewsResult = { ok: false, error: `zip too small: ${previewSize} bytes` };
        } else if (Number.isFinite(expectedSize) && expectedSize > 0 && previewSize !== expectedSize) {
          try { unlinkSync(previewFile); } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file: previewFile, reason: 'truncated' }, e.message); }
          console.warn(`[HUB BACKUP] ${site.name}: BAT previews truncated download (${previewSize} of ${expectedSize} bytes) — deleted.`);
          previewsResult = { ok: false, error: `truncated: ${previewSize}/${expectedSize}` };
        } else {
          console.log(`[HUB BACKUP] ${site.name}: BAT previews saved (${previewCount} files, ${(previewSize / 1024 / 1024).toFixed(1)} MB)`);
          previewsResult = { ok: true, count: previewCount, size: previewSize, file: previewFile };
        }
      } else {
        console.warn(`[HUB BACKUP] ${site.name}: BAT previews fetch HTTP ${prevRes.status} — skipping (existing previews on hub remain)`);
      }
    } catch (prevErr) {
      // Mid-stream failure leaves a partial file — clean it up.
      try {
        const { unlinkSync, existsSync } = await import('fs');
        if (existsSync(previewFile)) unlinkSync(previewFile);
      } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file: previewFile, reason: 'partial_cleanup' }, e.message); }
      console.warn(`[HUB BACKUP] ${site.name}: BAT previews fetch failed — ${describeFetchError(prevErr, `${site.url}/api/backup/bat-previews`)}`);
    }

    // Source-of-truth archives: JTI monthly exports + BAT supplier
    // uploads. Neither can be regenerated from the .db alone — JTI
    // archive rows reference files on disk; BAT supplier dispute
    // workflows replay against the original uploaded bytes. Same
    // best-effort pattern as bat-previews: a failure here doesn't
    // fail the whole backup.
    const archiveTargets = [
      { name: 'jti-archive', label: 'JTI archive' },
      { name: 'bat-archive', label: 'BAT archive' },
    ];
    const archiveResults = {};
    // Empty store-mode zip is 22 bytes (just the End-of-Central-Directory
    // record). Anything smaller can't be a valid zip; treat as a failed
    // download (truncation, proxy interrupt, archiver finalize race) and
    // delete so a future restore doesn't pick a 0-byte file as a
    // "snapshot".
    const MIN_ZIP_BYTES = 22;
    for (const { name, label } of archiveTargets) {
      const file = path.join(dir, `${name}-${site.id}-${ts}.zip`);
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
        const res = await fetch(`${site.url}/api/backup/${name}`, {
          headers: { 'x-reporting-token': site.token || '' },
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          // Capture Content-Length BEFORE streaming — used after pipeline
          // to detect truncation. The site's nestedArchiveEndpoint streams
          // and only sets Content-Length if it can know the total ahead
          // of time (it can't — archiver writes incrementally), so this
          // header may be absent. When absent we accept any size > MIN.
          const expectedSize = parseInt(res.headers.get('content-length') || '', 10);
          await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
          const { statSync, unlinkSync } = await import('fs');
          const size = statSync(file).size;
          if (size < MIN_ZIP_BYTES) {
            try { unlinkSync(file); } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file, reason: 'archive_too_small', archive: name }, e.message); }
            console.warn(`[HUB BACKUP] ${site.name}: ${label} fetch returned ${size} bytes — too small to be a valid zip; deleted.`);
            archiveResults[name] = { ok: false, error: `zip too small: ${size} bytes` };
            continue;
          }
          if (Number.isFinite(expectedSize) && expectedSize > 0 && size !== expectedSize) {
            try { unlinkSync(file); } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file, reason: 'archive_truncated', archive: name }, e.message); }
            console.warn(`[HUB BACKUP] ${site.name}: ${label} truncated download (${size} of ${expectedSize} bytes) — deleted.`);
            archiveResults[name] = { ok: false, error: `truncated: ${size}/${expectedSize}` };
            continue;
          }
          console.log(`[HUB BACKUP] ${site.name}: ${label} saved (${(size / 1024 / 1024).toFixed(1)} MB)`);
          archiveResults[name] = { ok: true, size, file };
        } else {
          console.warn(`[HUB BACKUP] ${site.name}: ${label} fetch HTTP ${res.status} — skipping (existing on hub remains)`);
          archiveResults[name] = { ok: false, status: res.status };
        }
      } catch (err) {
        // Clean up partial file from a mid-stream failure so a future
        // restore doesn't pick it up.
        try {
          const { unlinkSync, existsSync } = await import('fs');
          if (existsSync(file)) unlinkSync(file);
        } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file, reason: 'archive_partial_cleanup', archive: name }, e.message); }
        console.warn(`[HUB BACKUP] ${site.name}: ${label} fetch failed — ${describeFetchError(err, `${site.url}/api/backup/${name}`)}`);
        archiveResults[name] = { ok: false, error: err.message };
      }
    }

    // Prune older per-site backups so the hub doesn't accumulate
    // forever. Mirrors the site-side prune in scheduler.runLocalBackup.
    // Default 30 (HUB_BACKUP_KEEP_COUNT) — higher than site default
    // because the hub IS the long-tail archive.
    //
    // BAT preview zips are pruned separately at a SHALLOWER depth
    // (HUB_BAT_PREVIEWS_KEEP, default 3) because previews are
    // append-only on the site (each preview is written once when its
    // row is OCR'd) so the LATEST zip already covers all historical
    // extractions — keeping 30 zips would burn ~5 GB of hub disk
    // (typical zip is 100-200 MB) for no recovery benefit. Operator
    // can dial up via the env var if they want belt-and-braces.
    try {
      const { readdirSync, statSync, unlinkSync } = await import('fs');

      const dbFiles = readdirSync(dir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => ({ name: f, mtime: statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const parsedDbKeep = parseInt(process.env.HUB_BACKUP_KEEP_COUNT, 10);
      const dbKeep = Number.isFinite(parsedDbKeep) && parsedDbKeep >= 1 ? parsedDbKeep : 30;
      const dbToDelete = dbFiles.slice(dbKeep);
      for (const f of dbToDelete) {
        try { unlinkSync(path.join(dir, f.name)); } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file: f.name, reason: 'db_prune' }, e.message); }
      }
      if (dbToDelete.length > 0) {
        console.log(`[HUB BACKUP] ${site.name}: pruned ${dbToDelete.length} old DB backup(s), keeping ${dbKeep}`);
      }

      // Append-only zip prunes. bat-previews, jti-archive, bat-archive
      // all share the same property — the LATEST zip already contains
      // all historical entries (previews are written-once by extractionId,
      // jti exports are written-once per period, bat archives are
      // written-once per recon), so keeping a long tail of zips is
      // pure disk waste. Defaults are deliberately small; operators can
      // raise via env if they want belt-and-braces.
      const appendOnlyZipPrunes = [
        { prefix: 'bat-previews-',  envVar: 'HUB_BAT_PREVIEWS_KEEP',  defaultKeep: 3, label: 'preview zip' },
        { prefix: 'jti-archive-',   envVar: 'HUB_JTI_ARCHIVE_KEEP',   defaultKeep: 3, label: 'JTI archive zip' },
        { prefix: 'bat-archive-',   envVar: 'HUB_BAT_ARCHIVE_KEEP',   defaultKeep: 3, label: 'BAT archive zip' },
      ];
      for (const { prefix, envVar, defaultKeep, label } of appendOnlyZipPrunes) {
        const zips = readdirSync(dir)
          .filter((f) => f.startsWith(prefix) && f.endsWith('.zip'))
          .map((f) => ({ name: f, mtime: statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        const parsed = parseInt(process.env[envVar], 10);
        const keepN = Number.isFinite(parsed) && parsed >= 1 ? parsed : defaultKeep;
        const toDelete = zips.slice(keepN);
        for (const f of toDelete) {
          try { unlinkSync(path.join(dir, f.name)); } catch (e) { console.error('[hubEtl.file_unlink]', { siteId: site.id, file: f.name, reason: 'zip_prune', prefix }, e.message); }
        }
        if (toDelete.length > 0) {
          console.log(`[HUB BACKUP] ${site.name}: pruned ${toDelete.length} old ${label}(s), keeping ${keepN}`);
        }
      }
    } catch (pruneErr) {
      console.warn(`[HUB BACKUP] ${site.name}: prune failed (non-fatal): ${pruneErr.message}`);
    }

    return {
      ok: true,
      file: integrity.finalPath,
      integrity: integrity.integrity,
      previews: previewsResult,
      archives: archiveResults,
    };
  } catch (err) {
    const friendly = describeFetchError(err, `${site.url}/api/backup/download`);
    logError('hub.backupPull', err, { site_name: site.name, site_id: site.id, site_url: site.url, friendly });
    try {
      db.prepare(`INSERT INTO hub_backup_integrity (site_id, filename, result) VALUES (?, ?, ?)`)
        .run(site.id, '(download failed)', `pull_failed: ${friendly}`);
    } catch (e) { console.error('[hubEtl.integrity_log]', { siteId: site.id, phase: 'outer_catch_row' }, e.message); }
    return { ok: false, error: friendly };
  }
}

async function runHubBackupPull() {
  if (process.env.HUB_MODE !== 'true') return;
  const enabled = hubRepository.getBackupSyncEnabled();
  if (!enabled) {
    console.log('[HUB BACKUP] Skipping scheduled pull — backup sync disabled.');
    return;
  }
  const sites = hubRepository.listSitesForBackup();
  // Folder reconcile (legacy bare-<id> + post-rename <oldName>-<id> → canonical
  // <name>-<id>) runs per-site inside pullBackupForSite, so it covers both this
  // bulk path and the notify-backup-ready path. No separate bulk pass needed.
  console.log(`[HUB BACKUP] Starting parallel pull for ${sites.length} site(s)`);
  // Bounded concurrency: pull backups in batches of 2
  const CONCURRENCY = 2;
  for (let i = 0; i < sites.length; i += CONCURRENCY) {
    const batch = sites.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map((site) => pullBackupForSite(site)));
  }
}

// --- Site ping ---
// Pings each site by hitting /api/health and records online/offline status.
//
// Pings are HTTP-only and have no shared mutable state across sites, so they
// run in parallel via Promise.allSettled — wallclock drops from
// Σ(latencies + 5s_for_each_offline_site) to max(latencies). DB writes happen
// after each ping resolves; better-sqlite3 is synchronous so writes
// interleave naturally without a transaction.
export async function pingAllSites() {
  if (!HUB_SITES.length) return;
  const now = new Date().toISOString();
  await Promise.allSettled(HUB_SITES.map(async (site) => {
    let online = false;
    let latency_ms = null;
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${site.url}/api/health`, {
        signal: controller.signal,
        headers: { 'x-reporting-token': site.token || '' },
      });
      clearTimeout(timeout);
      latency_ms = Date.now() - t0;
      online = res.ok;
    } catch (_) {
      latency_ms = null;
    }
    try {
      db.prepare(`
        INSERT INTO hub_site_ping (site_slug, timestamp, online, latency_ms)
        VALUES (?, ?, ?, ?)
      `).run(site.slug, now, online ? 1 : 0, latency_ms);
      // Prune to last 200 rows per site
      db.prepare(`
        DELETE FROM hub_site_ping
        WHERE site_slug = ? AND id NOT IN (
          SELECT id FROM hub_site_ping WHERE site_slug = ? ORDER BY id DESC LIMIT 200
        )
      `).run(site.slug, site.slug);
      // Update hub_sites.status
      db.prepare(`UPDATE hub_sites SET status = ? WHERE slug = ?`).run(online ? 'online' : 'offline', site.slug);
    } catch (e) {
      console.error(`[HUB PING] DB error for ${site.slug}:`, e.message);
    }
    console.log(`[HUB PING] ${site.slug}: ${online ? 'online' : 'OFFLINE'} ${latency_ms != null ? latency_ms + 'ms' : '(timeout)'}`);
  }));
}

export { initHubTables, initHubSiteRegistry, syncAllSites, syncSite, runHubBackupPull, pullBackupForSite, HUB_SITES };
