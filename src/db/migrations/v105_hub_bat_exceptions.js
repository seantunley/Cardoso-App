export default {
  version: 105,
  name: 'hub_bat_exceptions',
  up(db) {
    // Per-site, per-week BAT exception LINES, pulled by the hub ETL from each
    // site's /api/reporting/bat-exceptions-detail. Drives the hub view of the
    // "Exceptions by Week" report (grouped site -> week). Unlike hub_bat_summary
    // (one summary row per site), this holds the detail rows, cleared and
    // re-inserted per site on each sync. Harmless/empty on a site install.
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_bat_exceptions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id           TEXT NOT NULL,
        year              INTEGER,
        week_number       INTEGER,
        order_number      TEXT,
        branch_code       TEXT,
        customer          TEXT,
        delivery_date     TEXT,
        pod_uploaded_date TEXT,
        ocr               TEXT,
        invoice           TEXT,
        exception_reason  TEXT,
        amount            REAL,
        is_missing_pod    INTEGER DEFAULT 0,
        synced_at         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hub_bat_exceptions_site
        ON hub_bat_exceptions (site_id, year, week_number);
    `);
  },
};
