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
// ntopng replaces the old PowerShell-based network device sync; no ETL pull needed.

const { sqliteDb: db, repository: hubRepository } = getHubStorageRuntime();

function checkBackupIntegrity(siteId, filePath) {
  let backupDb = null;
  let finalPath = filePath;
  let resultText = 'unchecked';

  try {
    backupDb = new BetterSqlite3(filePath, { readonly: true, fileMustExist: true });
    const rows = backupDb.prepare('PRAGMA integrity_check').all();
    const values = rows.map((row) => String(Object.values(row)[0] ?? '').trim()).filter(Boolean);
    const ok = values.length > 0 && values.every((value) => value.toLowerCase() === 'ok');
    resultText = ok ? 'ok' : JSON.stringify(values);

    if (!ok) {
      finalPath = `${filePath}.corrupt`;
      renameSync(filePath, finalPath);
      console.warn(`[HUB BACKUP] ${siteId}: integrity check failed, renamed to ${path.basename(finalPath)}`);
    }
  } catch (err) {
    resultText = err.message || 'integrity_check_failed';
    try {
      finalPath = `${filePath}.corrupt`;
      renameSync(filePath, finalPath);
    } catch (_) {
      finalPath = filePath;
    }
    console.warn(`[HUB BACKUP] ${siteId}: integrity check error: ${resultText}`);
  } finally {
    try { backupDb?.close(); } catch (_) {}
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

    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const ctrl3 = new AbortController();
      const t3 = setTimeout(() => ctrl3.abort(), 10000);
      const pageUrl = `${site.url}/api/reporting/records${sinceParam}${sinceParam ? '&' : '?'}offset=${offset}&limit=1000`;
      const recRes = await fetch(pageUrl, { headers, signal: ctrl3.signal });
      clearTimeout(t3);
      if (!recRes.ok) throw new Error(`Records fetch failed at offset ${offset}: HTTP ${recRes.status}`);
      const recData = await recRes.json();
      if (recData.records && recData.records.length > 0) {
        // Log first record diagnostics for account_type/sales_rep tracing
        if (offset === 0) {
          const sample = recData.records[0];
          console.log(`[hub-etl-diag] Site ${site.name}: first record keys:`, Object.keys(sample).join(', '));
          console.log(`[hub-etl-diag] Site ${site.name}: account_type=${JSON.stringify(sample.account_type)}, sales_rep=${JSON.stringify(sample.sales_rep)}`);
        }
        insertMany(recData.records);
        recordsFetched += recData.records.length;
        offset += recData.records.length;
      }
      hasMore = recData.has_more === true;
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
    const syncedItemNumbers = [];
    let invOffset = 0;
    let invHasMore = true;
    while (invHasMore) {
      const ctrlInv = new AbortController();
      const tInv = setTimeout(() => ctrlInv.abort(), 10000);
      const invUrl = `${site.url}/api/reporting/inventory?offset=${invOffset}&limit=1000`;
      const invRes = await fetch(invUrl, { headers, signal: ctrlInv.signal });
      clearTimeout(tInv);
      if (!invRes.ok) throw new Error(`Inventory fetch failed at offset ${invOffset}: HTTP ${invRes.status}`);
      const invData = await invRes.json();
      if (invData.records && invData.records.length > 0) {
        insertInventory(invData.records);
        invData.records.forEach(r => { if (r.item_number) syncedItemNumbers.push(r.item_number); });
        invOffset += invData.records.length;
      }
      invHasMore = invData.has_more === true;
    }
    // Prune hub_inventory rows no longer in the site's query (upsert-then-prune)
    if (syncedItemNumbers.length > 0) {
      const placeholders = syncedItemNumbers.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM hub_inventory WHERE site_id = ? AND item_number NOT IN (${placeholders})`
      ).run(site.id, ...syncedItemNumbers);
    }

    // Network devices: now served live from ntopng API — no ETL pull here.

    // BAT Reconciliation summary — single-row pull, recorded into hub_bat_summary.
    // Failures here are logged but don't fail the whole sync (the customer-records
    // ETL is the primary purpose of this run).
    try {
      const ctrlBat = new AbortController();
      const tBat = setTimeout(() => ctrlBat.abort(), 10000);
      const batRes = await fetch(`${site.url}/api/reporting/bat-summary`, { headers, signal: ctrlBat.signal });
      clearTimeout(tBat);
      if (batRes.ok) {
        const bat = await batRes.json();
        db.prepare(`
          INSERT INTO hub_bat_summary (
            site_id, total_supplier, total_sage, total_variance,
            weeks_count, matched_count, mismatch_count, awaiting_count,
            total_exceptions, total_exception_amount,
            last_upload_at, synced_at, last_error
          ) VALUES (
            @site_id, @total_supplier, @total_sage, @total_variance,
            @weeks_count, @matched_count, @mismatch_count, @awaiting_count,
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
          total_exceptions: bat.total_exceptions || 0,
          total_exception_amount: bat.total_exception_amount || 0,
          last_upload_at: bat.last_upload_at || null,
          synced_at: new Date().toISOString(),
        });
      } else {
        const msg = `BAT summary HTTP ${batRes.status}`;
        db.prepare(`
          INSERT INTO hub_bat_summary (site_id, last_error, synced_at)
          VALUES (?, ?, ?)
          ON CONFLICT(site_id) DO UPDATE SET last_error=excluded.last_error, synced_at=excluded.synced_at
        `).run(site.id, msg, new Date().toISOString());
        console.warn(`[HUB] ${site.name}: ${msg}`);
      }
    } catch (batErr) {
      const msg = String(batErr.message || batErr).slice(0, 500);
      db.prepare(`
        INSERT INTO hub_bat_summary (site_id, last_error, synced_at)
        VALUES (?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET last_error=excluded.last_error, synced_at=excluded.synced_at
      `).run(site.id, msg, new Date().toISOString());
      console.warn(`[HUB] ${site.name}: BAT summary fetch failed: ${msg}`);
    }

    // Update hub_sites
    db.prepare(`
      UPDATE hub_sites SET last_seen=?, last_kpis=?, status='ok' WHERE id=?
    `).run(new Date().toISOString(), kpis ? JSON.stringify(kpis) : null, site.id);

  } catch (err) {
    syncError = err.message;
    db.prepare(`UPDATE hub_sites SET status='error' WHERE id=?`).run(site.id);
    logError('hub.sync', err, { site_slug: site.slug, site_id: site.id });
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
    await Promise.allSettled(batch.map(async (site) => {
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
          return;
        }
        const dir = path.join(process.cwd(), 'database', 'hub-backups', site.id);
        mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = path.join(dir, `cardoso-${site.id}-${ts}.db`);
        // Stream the response body straight to disk instead of buffering the
        // whole DB in memory. A 200 MB site DB used to spike RSS by 200 MB
        // and block the event loop during the sync writeFileSync.
        await pipeline(Readable.fromWeb(upstream.body), createWriteStream(file));
        const integrity = checkBackupIntegrity(site.id, file);
        console.log(`[HUB BACKUP] ${site.name}: streamed -> ${integrity.finalPath} [${integrity.integrity}]`);

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
          console.warn(`[HUB BACKUP] ${site.name}: .env fetch failed: ${envErr.message}`);
        }
      } catch (err) {
        logError('hub.backupPull', err, { site_name: site.name, site_id: site.id });
        try {
          db.prepare(`INSERT INTO hub_backup_integrity (site_id, filename, result) VALUES (?, ?, ?)`)
            .run(site.id, '(download failed)', `pull_failed: ${err.message || 'unknown'}`);
        } catch {}
      }
    }));
  }
}

// --- Site ping ---
// Pings each site by hitting /api/health and records online/offline status.
export async function pingAllSites() {
  if (!HUB_SITES.length) return;
  const now = new Date().toISOString();
  for (const site of HUB_SITES) {
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
  }
}

export { initHubTables, initHubSiteRegistry, syncAllSites, runHubBackupPull, HUB_SITES };
