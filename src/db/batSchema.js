/**
 * Schema init for the BAT reconciliation database.
 * Dropped the `user` table — auth is delegated to the main Cardoso session.
 * `created_by` stays as INTEGER referencing Cardoso's user.id (no FK since
 * the row lives in a different database).
 */
export function initBatSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS bat_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_number INTEGER NOT NULL,
      year INTEGER NOT NULL,
      upload_filename TEXT,
      supplier_discount REAL,
      supplier_delivery REAL,
      supplier_pricing REAL,
      supplier_discount_vat REAL,
      supplier_delivery_vat REAL,
      supplier_pricing_vat REAL,
      supplier_total REAL,
      sage_discount REAL,
      sage_delivery REAL,
      sage_pricing REAL,
      sage_total REAL,
      status TEXT DEFAULT 'pending',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(week_number, year)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bat_sage_credit_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
      batch_number INTEGER,
      batch_description TEXT,
      batch_status TEXT,
      vendor_number TEXT,
      document_number TEXT,
      document_date TEXT,
      line_description TEXT,
      week_number INTEGER,
      fee_type TEXT,
      line_amount REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bat_invoice_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
      pdf_url TEXT NOT NULL,
      order_number TEXT,
      branch_name TEXT,
      store_name TEXT,
      week TEXT,
      order_day TEXT,
      delivery_day TEXT,
      lead_time INTEGER,
      delivery_date TEXT,
      pod_uploaded_date TEXT,
      validate TEXT,
      extracted_invoice TEXT,
      extraction_status TEXT DEFAULT 'pending',
      extraction_attempts INTEGER DEFAULT 0,
      sage_match_document TEXT,
      sage_match_amount REAL,
      match_status TEXT DEFAULT 'pending',
      preview_path TEXT,
      order_amount REAL,
      is_exception INTEGER DEFAULT 0,
      target_days INTEGER,
      compliance_status TEXT,
      exception_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(reconciliation_id, pdf_url)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bat_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bat_cardoso_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
      invoice_number TEXT NOT NULL,
      amount REAL,
      upload_filename TEXT,
      raw_data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add fee breakdown columns
  try {
    const ciCols = db.prepare("PRAGMA table_info(bat_cardoso_invoices)").all();
    const ciHas = (name) => ciCols.find(c => c.name === name);
    if (!ciHas('price_diff')) db.exec("ALTER TABLE bat_cardoso_invoices ADD COLUMN price_diff REAL");
    if (!ciHas('discount'))   db.exec("ALTER TABLE bat_cardoso_invoices ADD COLUMN discount REAL");
    if (!ciHas('del_fee'))    db.exec("ALTER TABLE bat_cardoso_invoices ADD COLUMN del_fee REAL");
  if (!ciHas('c_overwritten')) db.exec("ALTER TABLE bat_cardoso_invoices ADD COLUMN c_overwritten INTEGER DEFAULT 0");
  } catch {}

  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_cardoso_inv_recon ON bat_cardoso_invoices(reconciliation_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_cardoso_inv_num ON bat_cardoso_invoices(invoice_number)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_recon_week ON bat_reconciliations(week_number, year)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_recon ON bat_invoice_extractions(reconciliation_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_status ON bat_invoice_extractions(extraction_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_sage_cn_recon ON bat_sage_credit_notes(reconciliation_id)`);

  // Light migration: add missing columns on existing DBs
  const extCols = db.prepare("PRAGMA table_info(bat_invoice_extractions)").all();
  const has = (name) => extCols.find((c) => c.name === name);
  if (!has('branch_name'))       db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN branch_name TEXT");
  if (!has('week'))              db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN week TEXT");
  if (!has('order_day'))         db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN order_day TEXT");
  if (!has('delivery_day'))      db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN delivery_day TEXT");
  if (!has('lead_time'))         db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN lead_time INTEGER");
  if (!has('pod_uploaded_date')) db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN pod_uploaded_date TEXT");
  if (!has('validate'))          db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN validate TEXT");
  if (!has('preview_path'))      db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN preview_path TEXT");
  if (!has('order_amount'))      db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN order_amount REAL");
  if (!has('is_exception'))      db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN is_exception INTEGER DEFAULT 0");
  if (!has('target_days'))       db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN target_days INTEGER");
  if (!has('compliance_status')) db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN compliance_status TEXT");
  if (!has('supplier_discount'))  db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN supplier_discount REAL");
  if (!has('supplier_del_fee'))   db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN supplier_del_fee REAL");
  if (!has('supplier_pricing'))   db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN supplier_pricing REAL");
  if (!has('exception_reason'))  db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN exception_reason TEXT");
  if (!has('extraction_error'))  db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN extraction_error TEXT");
  if (!has('manual_override'))   db.exec("ALTER TABLE bat_invoice_extractions ADD COLUMN manual_override INTEGER DEFAULT 0");

  const reconCols = db.prepare("PRAGMA table_info(bat_reconciliations)").all();
  const reconHas = (name) => reconCols.find((c) => c.name === name);
  if (!reconHas('last_error'))    db.exec("ALTER TABLE bat_reconciliations ADD COLUMN last_error TEXT");
  if (!reconHas('last_error_at')) db.exec("ALTER TABLE bat_reconciliations ADD COLUMN last_error_at TEXT");
  if (!reconHas('sage_error'))    db.exec("ALTER TABLE bat_reconciliations ADD COLUMN sage_error TEXT");
  // Mark-week-zero: synthetic recon row for genuinely empty weeks (no
  // deliveries, no charges) that the upload flow rejects because the
  // Delivery POD sheet is empty. A row with marked_zero = 1 has all
  // supplier totals = 0 and counts as "covered" in missing-weeks
  // calculations. Reversible.
  if (!reconHas('marked_zero'))      db.exec("ALTER TABLE bat_reconciliations ADD COLUMN marked_zero INTEGER DEFAULT 0");
  if (!reconHas('marked_zero_by'))   db.exec("ALTER TABLE bat_reconciliations ADD COLUMN marked_zero_by TEXT");
  if (!reconHas('marked_zero_at'))   db.exec("ALTER TABLE bat_reconciliations ADD COLUMN marked_zero_at TEXT");
  if (!reconHas('marked_zero_note')) db.exec("ALTER TABLE bat_reconciliations ADD COLUMN marked_zero_note TEXT");

  // Migration: replace UNIQUE(pdf_url) with UNIQUE(reconciliation_id, pdf_url).
  // Old constraint silently re-pointed any re-uploaded POD URL at the new recon
  // while keeping its previous extraction_status, leaving fresh weekly uploads
  // with zero pending rows to OCR.
  const idxList = db.prepare("PRAGMA index_list(bat_invoice_extractions)").all();
  const hasOldUnique = idxList.some((idx) => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all();
    return cols.length === 1 && cols[0].name === 'pdf_url';
  });
  if (hasOldUnique) {
    db.exec("PRAGMA foreign_keys = OFF");
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE bat_invoice_extractions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
          pdf_url TEXT NOT NULL,
          order_number TEXT,
          branch_name TEXT,
          store_name TEXT,
          week TEXT,
          order_day TEXT,
          delivery_day TEXT,
          lead_time INTEGER,
          delivery_date TEXT,
          pod_uploaded_date TEXT,
          validate TEXT,
          extracted_invoice TEXT,
          extraction_status TEXT DEFAULT 'pending',
          extraction_attempts INTEGER DEFAULT 0,
          extraction_error TEXT,
          sage_match_document TEXT,
          sage_match_amount REAL,
          match_status TEXT DEFAULT 'pending',
          preview_path TEXT,
          order_amount REAL,
          is_exception INTEGER DEFAULT 0,
          target_days INTEGER,
          compliance_status TEXT,
          exception_reason TEXT,
          supplier_discount REAL,
          supplier_del_fee REAL,
          supplier_pricing REAL,
          manual_override INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(reconciliation_id, pdf_url)
        )
      `);
      // Copy by intersection so any column drift between old/new shapes is tolerated
      const oldNames = db.prepare("PRAGMA table_info(bat_invoice_extractions)").all().map(c => c.name);
      const newNames = db.prepare("PRAGMA table_info(bat_invoice_extractions_new)").all().map(c => c.name);
      const shared = oldNames.filter(c => newNames.includes(c));
      const colList = shared.map(c => `"${c}"`).join(', ');
      db.exec(`INSERT INTO bat_invoice_extractions_new (${colList}) SELECT ${colList} FROM bat_invoice_extractions`);
      db.exec("DROP TABLE bat_invoice_extractions");
      db.exec("ALTER TABLE bat_invoice_extractions_new RENAME TO bat_invoice_extractions");
      // DROP TABLE removed every index along with the old table — recreate
      // both the schema-level indexes and the ones added by later migrations.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_recon ON bat_invoice_extractions(reconciliation_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_status ON bat_invoice_extractions(extraction_status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_recon_status ON bat_invoice_extractions(reconciliation_id, extraction_status, id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_invoice ON bat_invoice_extractions(extracted_invoice) WHERE extracted_invoice IS NOT NULL`);
    });
    rebuild();
    db.exec("PRAGMA foreign_keys = ON");
    console.log('[bat-schema] Migrated bat_invoice_extractions: UNIQUE(pdf_url) -> UNIQUE(reconciliation_id, pdf_url)');
  }
}
