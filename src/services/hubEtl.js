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
import { describeFetchError } from '../lib/errorDescribe.js';
// ntopng replaces the old PowerShell-based network device sync; no ETL pull needed.

const { sqliteDb: db, repository: hubRepository } = getHubStorageRuntime();

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
    try { backupDb?.close(); } catch (_) {}
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

// --- ETL function ---
async function syncSite(site) {
  const startedAt = new Date().toISOString();
  let recordsFetched = 0;
  let syncError = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const headers = { 'X-Reporting-Token': site.token };

    // Health check
    const healthRes = await fetch(`${site.url}/api/reporting/health`, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);

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

    // Last sync for incremental pull
    const lastSync = db.prepare(
      `SELECT completed_at FROM hub_sync_log WHERE site_id=? AND status='ok' ORDER BY completed_at DESC LIMIT 1`
    ).get(site.id);
    const sinceParam = lastSync ? `?since=${encodeURIComponent(lastSync.completed_at)}` : '';

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

    // Inventory — full refresh
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
    const insertInventory = db.transaction((invRecords) => {
      const now = new Date().toISOString();
      for (const r of invRecords) {
        upsertInv.run({
          site_id: site.id,
          item_number: r.item_number,
          item_description: r.item_description || null,
          qty_on_hand: r.qty_on_hand || null,
          last_cost: r.last_cost || null,
          price_list: r.price_list || null,
          price: r.price || null,
          stocking_uom: r.stocking_uom || null,
          commodity: r.commodity || null,
          inventory_value: r.inventory_value || null,
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
        for (const r of invRecords) { if (r.item_number) syncedItemNumbers.push(r.item_number); }
        invOffset += consumed;
      }
      if (!nextInvPromise) break;
    }
    // Prune hub_inventory rows no longer in the site's query (upsert-then-prune)
    if (syncedItemNumbers.length > 0) {
      const placeholders = syncedItemNumbers.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM hub_inventory WHERE site_id = ? AND item_number NOT IN (${placeholders})`
      ).run(site.id, ...syncedItemNumbers);
    }

    // Network devices: now served live from ntopng API — no ETL pull here.

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
        console.warn(`[HUB] ${site.name}: ${msg}`);
      }
    } catch (batErr) {
      const msg = describeFetchError(batErr, `${site.url}/api/reporting/bat-summary`).slice(0, 500);
      db.prepare(`
        INSERT INTO hub_bat_summary (site_id, last_error, synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET last_error=excluded.last_error, synced_at=excluded.synced_at
      `).run(site.id, msg, new Date().toISOString());
      console.warn(`[HUB] ${site.name}: BAT summary fetch failed — ${msg}`);
    }

    // Update hub_sites
    // Promote the site→Accpac freshness/status/error fields from the
    // kpis JSON blob to dedicated columns so the dashboard tile can
    // colour-code without parsing JSON on every render. The tile shows
    // last_accpac_synced_at as the user-visible "data freshness" line
    // (vs last_seen which is when the HUB last pulled). last_accpac_status
    // drives the tile colour; last_accpac_error gives the operator the
    // actual reason ("ELOGIN", "ESOCKET", etc. via describeSqlError).
    db.prepare(`
      UPDATE hub_sites SET
        last_seen = ?,
        last_kpis = ?,
        status = 'ok',
        last_accpac_synced_at = ?,
        last_accpac_status = ?,
        last_accpac_error = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      kpis ? JSON.stringify(kpis) : null,
      kpis?.site_accpac_last_synced_at || null,
      kpis?.site_accpac_status || null,
      kpis?.site_accpac_error || null,
      site.id,
    );

  } catch (err) {
    // describeFetchError unwraps undici "fetch failed" → real cause + URL.
    // For non-fetch errors (e.g. SQLite from insertMany / upsertInv) the
    // helper just returns err.message verbatim, so this is safe to use as
    // a single funnel.
    syncError = describeFetchError(err, site.url);
    db.prepare(`UPDATE hub_sites SET status='error' WHERE id=?`).run(site.id);

    // Verbose, plain-English log so an operator can triage from the System
    // Log alone without source-diving. Default fetch errors ("fetch failed",
    // "This operation was aborted") are too cryptic — they don't say which
    // site, which fetch, or what to do about it.
    const raw = String(err?.message || err);
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

  db.prepare(`
    INSERT INTO hub_sync_log (site_id, started_at, completed_at, records_fetched, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(site.id, startedAt, new Date().toISOString(), recordsFetched, syncError ? 'error' : 'ok', syncError || null);

  return { site_id: site.id, site_slug: site.slug, records_fetched: recordsFetched, error: syncError };
}

async function syncAllSites() {
  console.log(`[HUB] Syncing ${HUB_SITES.length} site(s)...`);
  // Bounded concurrency: sync sites in batches of 3 to avoid DB connection exhaustion
  const CONCURRENCY = 3;
  const results = [];
  for (let i = 0; i < HUB_SITES.length; i += CONCURRENCY) {
    const batch = HUB_SITES.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(syncSite));
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
      const msg = `HTTP ${upstream.status}`;
      logError('hub.backupPull', new Error(msg), { site_name: site.name, site_id: site.id });
      try {
        db.prepare(`INSERT INTO hub_backup_integrity (site_id, filename, result) VALUES (?, ?, ?)`)
          .run(site.id, '(download failed)', `pull_failed: ${msg}`);
      } catch {}
      return { ok: false, error: msg };
    }
    const dir = path.join(process.cwd(), 'database', 'hub-backups', site.id);
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

    // Prune older per-site backups so the hub doesn't accumulate
    // forever. Mirrors the site-side prune in scheduler.runLocalBackup.
    // Default 30 (HUB_BACKUP_KEEP_COUNT) — higher than site default
    // because the hub IS the long-tail archive.
    try {
      const { readdirSync, statSync, unlinkSync } = await import('fs');
      const allFiles = readdirSync(dir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => ({ name: f, mtime: statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const parsedKeep = parseInt(process.env.HUB_BACKUP_KEEP_COUNT, 10);
      const hubKeep = Number.isFinite(parsedKeep) && parsedKeep >= 1 ? parsedKeep : 30;
      const toDelete = allFiles.slice(hubKeep);
      for (const f of toDelete) {
        try { unlinkSync(path.join(dir, f.name)); } catch {}
      }
      if (toDelete.length > 0) {
        console.log(`[HUB BACKUP] ${site.name}: pruned ${toDelete.length} old backup(s), keeping ${hubKeep}`);
      }
    } catch (pruneErr) {
      console.warn(`[HUB BACKUP] ${site.name}: prune failed (non-fatal): ${pruneErr.message}`);
    }

    return { ok: true, file: integrity.finalPath, integrity: integrity.integrity };
  } catch (err) {
    const friendly = describeFetchError(err, `${site.url}/api/backup/download`);
    logError('hub.backupPull', err, { site_name: site.name, site_id: site.id, site_url: site.url, friendly });
    try {
      db.prepare(`INSERT INTO hub_backup_integrity (site_id, filename, result) VALUES (?, ?, ?)`)
        .run(site.id, '(download failed)', `pull_failed: ${friendly}`);
    } catch {}
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
