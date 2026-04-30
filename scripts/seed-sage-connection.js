/**
 * One-shot seed: create or update a DatabaseConnection row named
 * "Sage 300 (BAT Reconciliation)" with the reconciliation module's
 * hard-coded Sage queries stored in table_configs for reference.
 *
 * Fill in host, database_name, username, and password via the Cardoso UI.
 */
import Database from 'better-sqlite3';
const db = new Database('./database/cardoso.db');

// Note: ${weekNumber} is a Sage-query placeholder, NOT a JS template var.
// Stored verbatim so it's obvious this is a parameterised query.
const creditNotesQuery = [
  "SELECT",
  "  bc.CNTBTCH AS batch_number,",
  "  LTRIM(RTRIM(bc.BTCHDESC)) AS batch_description,",
  "  CASE bc.BTCHSTTS",
  "    WHEN 1 THEN 'Open'",
  "    WHEN 3 THEN 'Posted'",
  "    WHEN 4 THEN 'Deleted'",
  "    WHEN 7 THEN 'Posted'",
  "    ELSE 'Unknown (' + CAST(bc.BTCHSTTS AS VARCHAR) + ')'",
  "  END AS batch_status,",
  "  LTRIM(RTRIM(h.IDVEND)) AS vendor_number,",
  "  LTRIM(RTRIM(h.IDINVC)) AS document_number,",
  "  h.DATEINVC AS document_date,",
  "  LTRIM(RTRIM(d.TEXTDESC)) AS line_description,",
  "  LTRIM(RTRIM(SUBSTRING(d.TEXTDESC, PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5, 2))) AS week_number,",
  "  CASE",
  "    WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DELIVERY%' THEN 'DELIVERY FEE'",
  "    WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DISCOUNT%' THEN 'DISCOUNT FEE'",
  "    WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'PRICING%'  THEN 'PRICING ADJ'",
  "    ELSE 'OTHER'",
  "  END AS fee_type,",
  "  d.AMTDISTHC AS line_amount",
  "FROM APIBC bc",
  "INNER JOIN APIBH h ON h.CNTBTCH = bc.CNTBTCH",
  "INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM",
  "WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'",
  "  AND LTRIM(RTRIM(d.TEXTDESC)) LIKE '%WEEK :weekNumber%'",
  "ORDER BY",
  "  CASE",
  "    WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DELIVERY%' THEN 1",
  "    WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DISCOUNT%' THEN 2",
  "    WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'PRICING%'  THEN 3",
  "    ELSE 4",
  "  END,",
  "  bc.CNTBTCH",
].join('\n');

const postedInvoicesQuery = [
  "SELECT",
  "  LTRIM(RTRIM(IDVEND)) AS vendor_number,",
  "  LTRIM(RTRIM(IDINVC)) AS document_number,",
  "  DATEINVC AS document_date,",
  "  ISNULL(AMTINVCHC, 0) AS amount,",
  "  LTRIM(RTRIM(DESCINVC)) AS description",
  "FROM APOBL",
  "WHERE LTRIM(RTRIM(IDVEND)) LIKE '%BAT%'",
].join('\n');

const tableConfigs = JSON.stringify({
  usage:
    'Read-only Sage 300 source for the BAT Supplier Reconciliation module. ' +
    'Queries are hard-coded in src/services/batReconciliation.js — the entries here ' +
    'are for reference / audit only. The reconciliation module auto-detects this ' +
    'connection by matching name LIKE \'%sage%\' AND status=\'active\'.',
  queries: [
    {
      name: 'credit_notes_by_week',
      description: 'Fetches Sage AP credit-note batches for a given week (BAT vendor only). Parameterised by week number.',
      sql: creditNotesQuery,
      binds: ['weekNumber'],
      tables: ['APIBC', 'APIBH', 'APIBD'],
    },
    {
      name: 'posted_invoices',
      description: 'Fetches all posted BAT invoices (vendor LIKE %BAT%) from the open AP ledger for matching extracted invoice numbers.',
      sql: postedInvoicesQuery,
      binds: [],
      tables: ['APOBL'],
    },
  ],
  fields: {
    credit_notes: {
      batch_number:     'APIBC.CNTBTCH',
      batch_description:'APIBC.BTCHDESC',
      batch_status:     'APIBC.BTCHSTTS (decoded)',
      vendor_number:    'APIBH.IDVEND',
      document_number:  'APIBH.IDINVC',
      document_date:    'APIBH.DATEINVC',
      line_description: 'APIBD.TEXTDESC',
      week_number:      'parsed from APIBD.TEXTDESC',
      fee_type:         'derived from APIBD.TEXTDESC prefix',
      line_amount:      'APIBD.AMTDISTHC',
    },
    posted_invoices: {
      vendor_number:    'APOBL.IDVEND',
      document_number:  'APOBL.IDINVC',
      document_date:    'APOBL.DATEINVC',
      amount:           'APOBL.AMTINVCHC',
      description:      'APOBL.DESCINVC',
    },
  },
}, null, 2);

const name = 'Sage 300 (BAT Reconciliation)';
const existing = db.prepare('SELECT id, sync_query, is_bat_only FROM databaseconnection WHERE LOWER(name) = LOWER(?)').get(name);

if (existing) {
  // Refresh table_configs metadata. Also fill sync_query / is_bat_only if
  // the row predates those fields, but never overwrite a query the user
  // has already customised.
  const fields = ['table_configs = ?', 'updated_date = CURRENT_TIMESTAMP'];
  const params = [tableConfigs];
  if (!existing.sync_query || !existing.sync_query.trim()) {
    fields.push('sync_query = ?');
    params.push(creditNotesQuery);
  }
  if (existing.is_bat_only !== 1) {
    fields.push('is_bat_only = 1');
  }
  params.push(existing.id);
  db.prepare(`UPDATE databaseconnection SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  console.log(`Updated existing Sage connection (id ${existing.id}); sync_query ${existing.sync_query?.trim() ? 'preserved' : 'seeded'}, is_bat_only ${existing.is_bat_only === 1 ? 'already set' : 'set to 1'}.`);
} else {
  const info = db.prepare(`
    INSERT INTO databaseconnection (
      name, host, port, database_name, username, encrypted_password,
      use_encryption, table_configs, sync_query, is_bat_only,
      status, created_by, created_date, updated_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    name,
    'FILL_IN_SAGE_HOST',
    1433,
    'FILL_IN_SAGE_DATABASE',
    'FILL_IN_SAGE_USERNAME',
    '',
    0,
    tableConfigs,
    creditNotesQuery,   // sync_query — required by Connections UI
    1,                  // is_bat_only — excluded from generic sync engine
    'inactive',
    'system:bat-seed',
  );
  console.log(`Seeded Sage connection (id ${info.lastInsertRowid}) with credit-notes query and is_bat_only=1.`);
}

const row = db.prepare('SELECT id, name, host, database_name, username, status FROM databaseconnection WHERE LOWER(name) LIKE ?').get('%sage%');
console.log('\nCurrent Sage connection row:');
console.log(row);
console.log('\nFill in these placeholders via the Connections page (Edit → save):');
console.log('  host:       FILL_IN_SAGE_HOST');
console.log('  database:   FILL_IN_SAGE_DATABASE');
console.log('  username:   FILL_IN_SAGE_USERNAME');
console.log('  password:   (blank — set via Edit modal)');
console.log('\nThen Test → Activate. BAT module will pick it up automatically.');
