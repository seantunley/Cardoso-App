/**
 * Hub ETL — extracted from server.js (US-010).
 *
 * Hub-mode table creation, site registry, sync-all-sites ETL,
 * and scheduled backup pull logic.
 */

import db from '../db/index.js';
import { buildStatements } from '../db/statements.js';

// --- Hub table creation (only called when HUB_MODE === 'true') ---
function initHubTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_sites (
      id TEXT PRIMARY KEY,
      slug TEXT,
      name TEXT,
      url TEXT,
      token TEXT,
      last_seen TEXT,
      last_kpis TEXT,
      status TEXT DEFAULT 'unknown'
    );
    CREATE TABLE IF NOT EXISTS hub_records (
      site_id TEXT,
      record_id TEXT,
      customer_number TEXT,
      customer_name TEXT,
      flag_color TEXT,
      flag_reason TEXT,
      outstanding_balance TEXT,
      unpaid_invoices TEXT,
      receipts TEXT,
      updated_date TEXT,
      synced_at TEXT,
      auto_flagged INTEGER DEFAULT 0,
      terms TEXT,
      PRIMARY KEY (site_id, record_id)
    );
    CREATE TABLE IF NOT EXISTS hub_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      records_fetched INTEGER,
      status TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS hub_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS hub_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      item_number TEXT NOT NULL,
      item_description TEXT,
      qty_on_hand TEXT,
      last_cost TEXT,
      price_list TEXT,
      price TEXT,
      stocking_uom TEXT,
      commodity TEXT,
      inventory_value TEXT,
      terms TEXT,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, item_number)
    );
  `);

  // Seed default hub settings
  db.prepare(`INSERT OR IGNORE INTO hub_settings (key, value) VALUES ('backup_sync_enabled', 'true')`).run();
}

// --- Site registry from env ---
// HUB_SITES is parsed lazily inside initHubSiteRegistry() to avoid ES module
// import-hoisting race where dotenv hasn't run yet at module load time.
let HUB_SITES = [];

function initHubSiteRegistry() {
  try {
    HUB_SITES = JSON.parse(process.env.HUB_SITES || '[]');
  } catch (e) {
    console.error('[HUB] Invalid HUB_SITES JSON:', e.message);
    HUB_SITES = [];
  }

  const upsertSite = db.prepare(`
    INSERT INTO hub_sites (id, slug, name, url, token, status)
    VALUES (@id, @slug, @name, @url, @token, 'unknown')
    ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, name=excluded.name, url=excluded.url, token=excluded.token
  `);
  for (const site of HUB_SITES) {
    upsertSite.run({ id: site.id, slug: site.slug, name: site.name, url: site.url, token: site.token || null });
  }
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
        site_id, record_id, customer_number, customer_name, flag_color, flag_reason,
        outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
        updated_date, synced_at
      ) VALUES (
        @site_id, @record_id, @customer_number, @customer_name, @flag_color, @flag_reason,
        @outstanding_balance, @unpaid_invoices, @receipts, @auto_flagged, @terms,
        @updated_date, @synced_at
      )
      ON CONFLICT(site_id, record_id) DO UPDATE SET
        customer_number=excluded.customer_number,
        customer_name=excluded.customer_name,
        flag_color=excluded.flag_color,
        flag_reason=excluded.flag_reason,
        outstanding_balance=excluded.outstanding_balance,
        unpaid_invoices=excluded.unpaid_invoices,
        receipts=excluded.receipts,
        auto_flagged=excluded.auto_flagged,
        terms=excluded.terms,
        updated_date=excluded.updated_date,
        synced_at=excluded.synced_at
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
          outstanding_balance: r.outstanding_balance || null,
          unpaid_invoices: r.unpaid_invoices || '[]',
          receipts: r.receipts || '[]',
          auto_flagged: r.auto_flagged ? 1 : 0,
          terms: r.terms || null,
          updated_date: r.updated_date,
          synced_at: now,
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
      if (!recRes.ok) break;
      const recData = await recRes.json();
      if (recData.records && recData.records.length > 0) {
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
      if (!invRes.ok) break;
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

    // Update hub_sites
    db.prepare(`
      UPDATE hub_sites SET last_seen=?, last_kpis=?, status='ok' WHERE id=?
    `).run(new Date().toISOString(), kpis ? JSON.stringify(kpis) : null, site.id);

  } catch (err) {
    syncError = err.message;
    db.prepare(`UPDATE hub_sites SET status='error' WHERE id=?`).run(site.id);
    console.error(`[HUB] Sync error for ${site.slug}:`, err.message);
  }

  db.prepare(`
    INSERT INTO hub_sync_log (site_id, started_at, completed_at, records_fetched, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(site.id, startedAt, new Date().toISOString(), recordsFetched, syncError ? 'error' : 'ok', syncError || null);

  return { site_id: site.id, site_slug: site.slug, records_fetched: recordsFetched, error: syncError };
}

async function syncAllSites() {
  console.log(`[HUB] Syncing ${HUB_SITES.length} site(s)...`);
  const results = await Promise.allSettled(HUB_SITES.map(syncSite));
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
  const stmts = buildStatements(db);
  const row = stmts.getHubSetting.get('backup_sync_enabled');
  const enabled = row ? row.value === 'true' : true;
  if (!enabled) {
    console.log('[HUB BACKUP] Skipping scheduled pull — backup sync disabled.');
    return;
  }
  const sites = stmts.hubSitesForBackup.all();
  console.log(`[HUB BACKUP] Starting parallel pull for ${sites.length} site(s)`);
  const { mkdirSync, writeFileSync } = await import('fs');
  const pathMod = await import('path');
  await Promise.allSettled(sites.map(async (site) => {
    try {
      const controller = new AbortController();
      const hardTimeout = setTimeout(() => controller.abort(), 30000);
      const upstream = await fetch(`${site.url}/api/backup/download`, {
        headers: { 'x-reporting-token': site.token || '' },
        signal: controller.signal,
      });
      clearTimeout(hardTimeout);
      if (!upstream.ok) { console.error(`[HUB BACKUP] ${site.name}: HTTP ${upstream.status}`); return; }
      const buf = Buffer.from(await upstream.arrayBuffer());
      const dir = pathMod.join(process.cwd(), 'database', 'hub-backups', site.id);
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = pathMod.join(dir, `cardoso-${site.id}-${ts}.db`);
      writeFileSync(file, buf);
      console.log(`[HUB BACKUP] ${site.name}: saved ${buf.length} bytes -> ${file}`);
    } catch (err) {
      console.error(`[HUB BACKUP] ${site.name}: ${err.message}`);
    }
  }));
}

export { initHubTables, initHubSiteRegistry, syncAllSites, runHubBackupPull, HUB_SITES };
