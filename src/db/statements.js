/**
 * Pre-compiled prepared statements.
 * Extracted from server.js for US-002.
 */

function buildStatements(db) {
  const stmts = {};

  stmts.getUserById        = db.prepare('SELECT * FROM "user" WHERE id = ?');
  stmts.getUserByEmail     = db.prepare('SELECT * FROM "user" WHERE email = ?');
  stmts.updateUserPassword = db.prepare('UPDATE "user" SET password_hash = ? WHERE id = ?');

  stmts.kpiTotalRecords  = db.prepare('SELECT COUNT(*) as count FROM datarecord');
  stmts.kpiFlagCounts    = db.prepare('SELECT flag_color, COUNT(*) as count FROM datarecord GROUP BY flag_color');
  stmts.kpiLastSync      = db.prepare('SELECT completed_at FROM syncrun ORDER BY completed_at DESC LIMIT 1');
  stmts.kpiLastRun       = db.prepare('SELECT status, completed_at FROM syncrun ORDER BY completed_at DESC LIMIT 1');
  stmts.kpiActiveConns   = db.prepare("SELECT COUNT(*) as count FROM databaseconnection WHERE status = 'active'");

  stmts.autoRecordsForFlags  = db.prepare('SELECT * FROM datarecord WHERE flag_color IS NOT NULL OR auto_flagged = 1 OR outstanding_balance IS NOT NULL');
  stmts.activeAutoFlagRules  = db.prepare('SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC');
  stmts.updateAutoFlag       = db.prepare("UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = 1, flag_source = 'auto' WHERE id = ?");
  stmts.clearAutoFlag        = db.prepare("UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE id = ? AND auto_flagged = 1");
  stmts.clearAllAutoFlags    = db.prepare("UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE auto_flagged = 1");

  // ── Sync engine writes ──────────────────────────────────────────────────
  // These were previously prepared inside runConnectionImport, which runs
  // per-connection every 15 minutes. better-sqlite3 internally caches by
  // SQL text so the cost was small, but the JS wrappers were still
  // allocated per call. Moving them here matches the buildStatements
  // intent and makes the hot-path read cleaner.
  stmts.syncUpdateRecord = db.prepare(`
    UPDATE datarecord
    SET
      created_by = ?,
      customer_number = ?,
      customer_name = ?,
      age_analysis = ?,
      age_current = ?,
      age_7_days = ?,
      age_14_days = ?,
      age_21_days = ?,
      outstanding_balance = ?,
      source_id = ?,
      source_table = ?,
      data = ?,
      local_fields = ?,
      unpaid_invoices = ?,
      receipts = ?,
      terms = ?,
      sales_rep = ?,
      account_type = ?,
      flag_color = ?,
      flag_reason = ?,
      flag_created_by = ?,
      note = ?,
      custom_field_1 = ?,
      custom_field_2 = ?,
      custom_field_3 = ?,
      synced_at = ?,
      updated_date = ?
    WHERE id = ?
  `);

  stmts.syncInsertRecord = db.prepare(`
    INSERT INTO datarecord (
      created_by,
      customer_number,
      customer_name,
      age_analysis,
      age_current,
      age_7_days,
      age_14_days,
      age_21_days,
      outstanding_balance,
      source_id,
      source_table,
      data,
      local_fields,
      unpaid_invoices,
      receipts,
      terms,
      sales_rep,
      account_type,
      note,
      custom_field_1,
      custom_field_2,
      custom_field_3,
      synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmts.syncUpsertInventory = db.prepare(`
    INSERT INTO inventoryrecord (source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, updated_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_table, item_number) DO UPDATE SET
      item_description=excluded.item_description,
      qty_on_hand=excluded.qty_on_hand,
      last_cost=excluded.last_cost,
      price_list=excluded.price_list,
      price=excluded.price,
      stocking_uom=excluded.stocking_uom,
      commodity=excluded.commodity,
      inventory_value=excluded.inventory_value,
      updated_date=excluded.updated_date
  `);

  // Flag-snapshot statements (clear-data preserve/restore + new-record
  // auto-flag). Previously rebuilt inside the writeRowsTransaction closure
  // on every sync batch.
  stmts.syncUpdateRecordFlag = db.prepare(
    `UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = ?, flag_source = 'auto' WHERE id = ?`
  );
  stmts.findFlagSnapshot = db.prepare(`
    SELECT flag_color, flag_reason, flag_created_by, flag_source, auto_flagged, note
    FROM flag_snapshots WHERE customer_number = ? LIMIT 1
  `);
  stmts.restoreFlagSnapshot = db.prepare(`
    UPDATE datarecord SET flag_color = ?, flag_reason = ?, flag_created_by = ?, flag_source = ?, auto_flagged = ?, note = ? WHERE id = ?
  `);
  stmts.deleteFlagSnapshot = db.prepare(`DELETE FROM flag_snapshots WHERE customer_number = ?`);

  if (process.env.HUB_MODE === 'true') {
    stmts.getHubSetting     = db.prepare('SELECT value FROM hub_settings WHERE key = ?');
    stmts.setHubSetting     = db.prepare('INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    stmts.hubSitesForBackup = db.prepare('SELECT id, name, url, token FROM hub_sites');
  }

  return stmts;
}

export { buildStatements };
