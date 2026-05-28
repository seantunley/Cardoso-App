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
      CREATE TABLE IF NOT EXISTS hub_inventory_sales (
        site_id       TEXT    NOT NULL,
        item_number   TEXT    NOT NULL,
        period        TEXT    NOT NULL,
        qty_sold      REAL    NOT NULL DEFAULT 0,
        revenue       REAL    NOT NULL DEFAULT 0,
        order_count   INTEGER NOT NULL DEFAULT 0,
        last_sale_date TEXT,
        synced_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (site_id, item_number, period)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_inv_sales_site_period
        ON hub_inventory_sales(site_id, period);
      CREATE TABLE IF NOT EXISTS hub_stock_receipt_expiry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        receipt_number TEXT,
        supplier_name TEXT,
        receipt_date TEXT,
        receipt_line_id INTEGER,
        line_no INTEGER,
        item_number TEXT NOT NULL,
        item_description TEXT,
        qty_received TEXT,
        uom TEXT,
        unit_cost TEXT,
        expiry_date TEXT,
        qty_at_expiry TEXT,
        entered_by TEXT,
        entry_source TEXT,
        notes TEXT,
        expiry_created TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_hub_stock_expiry_site
        ON hub_stock_receipt_expiry(site_id);
      CREATE INDEX IF NOT EXISTS idx_hub_stock_expiry_item
        ON hub_stock_receipt_expiry(site_id, item_number);
      CREATE INDEX IF NOT EXISTS idx_hub_stock_expiry_date
        ON hub_stock_receipt_expiry(expiry_date);
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
      // Three-step reconcile in a single transaction:
      //   1. Upsert each incoming site, marking it in_env=1 and clearing
      //      any prior tombstone timestamp.
      //   2. Find existing rows whose id is NOT in the incoming list and
      //      mark them in_env=0 (preserving the original removed_from_env_at
      //      via COALESCE so the timestamp doesn't reset every boot).
      //   3. Empty-env guard: if the incoming list is empty AND there are
      //      already rows in hub_sites, that is almost certainly a config
      //      error (operator cleared HUB_SITES env). Skip step 2 entirely
      //      in that case — better to leave every existing row marked
      //      in_env=1 than to silently mark the entire fleet as orphan.
      const items = Array.isArray(sites) ? sites : [];
      const upsertSite = adapter.prepare(`
        INSERT INTO hub_sites (id, slug, name, url, token, status, in_env, removed_from_env_at)
        VALUES (@id, @slug, @name, @url, @token, 'unknown', 1, NULL)
        ON CONFLICT(id) DO UPDATE SET
          slug                = excluded.slug,
          name                = excluded.name,
          url                 = excluded.url,
          token               = excluded.token,
          in_env              = 1,
          removed_from_env_at = NULL
      `);

      const reconcile = adapter.transaction(() => {
        for (const site of items) {
          upsertSite.run({
            id: site.id,
            slug: site.slug,
            name: site.name,
            url: site.url,
            token: site.token || null,
          });
        }

        // Empty-env guard. An empty incoming list combined with rows
        // already in the table is the "operator cleared HUB_SITES" case;
        // refuse to mark every site as orphan in one go. This costs us
        // the legitimate "I really did retire every site" case — but
        // that's rare and recoverable (operator can use the per-site
        // Forget button instead).
        if (items.length === 0) {
          const existing = adapter.queryOne('SELECT COUNT(*) AS n FROM hub_sites');
          if (existing && existing.n > 0) {
            console.warn('[HUB] HUB_SITES env is empty but hub_sites has rows — refusing to orphan everything (assumed config error). Use the per-site Forget button to retire sites individually.');
            return;
          }
        }

        // Mark every row not in the incoming list as orphan. Use NOT IN
        // with a bound set; SQLite caps params at ~999 which is far
        // beyond any plausible site count.
        const incomingIds = items.map((s) => s.id).filter(Boolean);
        if (incomingIds.length > 0) {
          const placeholders = incomingIds.map(() => '?').join(',');
          adapter.prepare(`
            UPDATE hub_sites
            SET in_env = 0,
                removed_from_env_at = COALESCE(removed_from_env_at, datetime('now'))
            WHERE id NOT IN (${placeholders}) AND in_env = 1
          `).run(...incomingIds);
        }
      });

      reconcile();
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
