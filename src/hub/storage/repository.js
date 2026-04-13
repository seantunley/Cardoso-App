export function createHubRepository(adapter) {
  function ensureHubTables() {
    adapter.exec(`
      CREATE TABLE IF NOT EXISTS hub_sites (
        id TEXT PRIMARY KEY,
        slug TEXT,
        name TEXT,
        url TEXT,
        token TEXT,
        last_seen TEXT,
        last_kpis TEXT,
        status TEXT DEFAULT 'unknown',
        logic_version INTEGER,
        logic_sync_status TEXT DEFAULT 'never_synced',
        logic_last_error TEXT,
        logic_last_synced_at TEXT,
        logic_status_updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS hub_records (
        site_id TEXT,
        record_id TEXT,
        customer_number TEXT,
        customer_name TEXT,
        flag_color TEXT,
        flag_reason TEXT,
        flag_created_by TEXT,
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

    adapter.run(`
      INSERT INTO hub_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, 'backup_sync_enabled', 'true');
  }

  return {
    adapter,
    ensureHubTables,
    upsertSites(sites = []) {
      const upsertSite = adapter.prepare(`
        INSERT INTO hub_sites (id, slug, name, url, token, status)
        VALUES (@id, @slug, @name, @url, @token, 'unknown')
        ON CONFLICT(id) DO UPDATE SET
          slug = excluded.slug,
          name = excluded.name,
          url = excluded.url,
          token = excluded.token
      `);
      const upsertSitesTx = adapter.transaction((items) => {
        for (const site of items) {
          upsertSite.run({
            id: site.id,
            slug: site.slug,
            name: site.name,
            url: site.url,
            token: site.token || null,
          });
        }
      });
      upsertSitesTx(Array.isArray(sites) ? sites : []);
    },
    getBackupSyncEnabled() {
      const row = adapter.queryOne('SELECT value FROM hub_settings WHERE key = ?', 'backup_sync_enabled');
      return row ? row.value === 'true' : true;
    },
    setBackupSyncEnabled(enabled) {
      adapter.run(`
        INSERT INTO hub_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `, 'backup_sync_enabled', enabled ? 'true' : 'false');
      return enabled;
    },
    listSitesForBackup() {
      return adapter.queryAll('SELECT id, name, url, token FROM hub_sites');
    },
  };
}
