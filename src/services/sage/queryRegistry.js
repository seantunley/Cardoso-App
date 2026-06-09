import db from '../../db/index.js';
// JTI's query module is intentionally pure (unit-testable without a DB), so it
// must NOT import this registry. We import ITS default instead — one direction,
// no circular dependency, no duplicated SQL. JTI keeps resolving locally; the
// registry just registers its default + override store for visibility/management.
import { DEFAULT_JTI_SQL, JTI_REQUIRED_COLUMNS } from '../jti/jtiQuery.js';

// ── Central Sage 300 query registry ─────────────────────────────────────────
//
// Single source of truth for every SQL query the app runs against the Sage 300
// (MSSQL) database. Before this, defaults were baked into each service, the
// "use override else default" ternary was copy-pasted per module, validation
// was inconsistent (commission/JTI validated, debtor/creditor/receipts did
// not), and overrides lived in five different stores — so it was hard to see
// or manage what Sage SQL the app actually runs.
//
// Each entry owns:
//   - defaultSql       the shipped query (verified against the live Sage schema)
//   - params           @-params the query binds (drives the validator)
//   - requiredColumns  output column aliases callers depend on (drives validator)
//   - pool             connection-role pool that runs it: 'bat_sage' | 'customer' | 'jti'
//   - tables           Sage tables touched (for the admin UI / docs)
//   - getOverride()    reads the operator override from its CURRENT store.
//                      Phase 2 unifies these into one sage_query_override table;
//                      until then each reader points at the existing column/KV.
//
// Public API:
//   resolveSageQuery(key)              → effective SQL (override-if-present else default)
//   validateSageQueryOverride(sql,key) → the single guardrail every save path uses
//   listSageQueries() / getSageQuery() → for the Settings → Sage Queries screen
//
// Adding a query here makes it visible + overridable + validated for free,
// instead of another string baked into a service.

const REGISTRY = {};
function define(d) { REGISTRY[d.key] = d; }

// Override readers. Literal SQL (no interpolation of caller input) reading the
// query's CURRENT store; returns the stored text or null. Wrapped so a missing
// table/column never throws into a sync.
function readerSql(selectSql, ...args) {
  return () => {
    try { return db.prepare(selectSql).get(...args)?.v ?? null; }
    catch { return null; }
  };
}

// ── Registry entries ────────────────────────────────────────────────────────

define({
  key: 'debtor.ar_invoice',
  label: 'Aged Debtors — AR open items',
  purpose: 'Open AR documents per customer, aged individually by due date for the Aged Debtors report.',
  pool: 'bat_sage',
  tables: ['AROBL', 'ARCUS'],
  params: [],
  requiredColumns: ['customer_code', 'document_number', 'document_date_int', 'due_date_int', 'outstanding_amount'],
  getOverride: readerSql('SELECT ar_invoice_sql_override AS v FROM debtor_sync_settings WHERE id = 1'),
  defaultSql: `
  SELECT
    LTRIM(RTRIM(o.IDCUST))           AS customer_code,
    CASE WHEN NULLIF(LTRIM(RTRIM(c.IDNATACCT)), '') IS NOT NULL
         THEN LTRIM(RTRIM(c.IDNATACCT))
         ELSE LTRIM(RTRIM(o.IDCUST)) END AS reporting_account,
    LTRIM(RTRIM(o.IDINVC))           AS document_number,
    CAST(o.TRXTYPEID AS varchar(10)) AS document_type,
    o.DATEINVC                       AS document_date_int,
    o.DATEDUE                        AS due_date_int,
    o.AMTINVCHC                      AS original_amount,
    o.AMTDUEHC                       AS outstanding_amount,
    LTRIM(RTRIM(o.IDORDERNBR))       AS reference
  FROM AROBL o
  LEFT JOIN ARCUS c ON LTRIM(RTRIM(c.IDCUST)) = LTRIM(RTRIM(o.IDCUST))
  WHERE o.AMTDUEHC <> 0
`,
});

define({
  key: 'stock_receipts.receipt',
  label: 'Stock Receipt Expiry — goods received',
  purpose: 'Goods received against POs (PO Receipt of Goods) for stock-expiry tracking.',
  pool: 'bat_sage',
  tables: ['PORCPH1', 'PORCPL'],
  params: ['from', 'to'],
  requiredColumns: ['receipt_number', 'supplier_code', 'receipt_date_int', 'item_number', 'qty_received'],
  getOverride: readerSql("SELECT value AS v FROM hub_settings WHERE key = 'stock_receipt_sql_override'"),
  defaultSql: `
  SELECT
    LTRIM(RTRIM(h.RCPNUMBER))  AS receipt_number,
    LTRIM(RTRIM(h.VDCODE))     AS supplier_code,
    LTRIM(RTRIM(h.VDNAME))     AS supplier_name,
    h.DATE                     AS receipt_date_int,
    l.RCPLSEQ                  AS line_no,
    LTRIM(RTRIM(l.ITEMNO))     AS item_number,
    LTRIM(RTRIM(l.ITEMDESC))   AS item_description,
    l.RQRECEIVED               AS qty_received,
    LTRIM(RTRIM(l.RCPUNIT))    AS uom,
    l.UNITCOST                 AS unit_cost
  FROM PORCPH1 h
  INNER JOIN PORCPL l ON l.RCPHSEQ = h.RCPHSEQ
  WHERE h.DATE BETWEEN @from AND @to
    AND l.RQRECEIVED > 0
  ORDER BY h.DATE DESC, h.RCPNUMBER, l.RCPLSEQ
`,
});

define({
  key: 'creditor.vendor',
  label: 'Creditors — vendor master',
  purpose: 'Vendor name, terms, contact and active flag for the Creditors module.',
  pool: 'bat_sage',
  tables: ['APVEN'],
  params: [],
  requiredColumns: ['vendor_code', 'vendor_name'],
  getOverride: readerSql('SELECT vendor_sql_override AS v FROM creditor_sync_settings WHERE id = 1'),
  defaultSql: `
  SELECT
    LTRIM(RTRIM(VENDORID))  AS vendor_code,
    LTRIM(RTRIM(VENDNAME))  AS vendor_name,
    LTRIM(RTRIM(TERMSCODE)) AS terms,
    LTRIM(RTRIM(NAMECTAC))  AS contact,
    LTRIM(RTRIM(TEXTPHON1)) AS phone,
    LTRIM(RTRIM(EMAIL1))    AS email,
    CASE WHEN SWACTV = 1 THEN 1 ELSE 0 END AS is_active
  FROM APVEN
`,
});

define({
  key: 'creditor.ap_invoice',
  label: 'Aged Creditors — AP open items',
  purpose: 'Open AP documents per vendor, aged by due date for the Aged Creditors report.',
  pool: 'bat_sage',
  tables: ['APOBL'],
  params: [],
  requiredColumns: ['vendor_code', 'document_number', 'document_date_int', 'due_date_int', 'outstanding_amount'],
  getOverride: readerSql('SELECT ap_invoice_sql_override AS v FROM creditor_sync_settings WHERE id = 1'),
  defaultSql: `
  SELECT
    LTRIM(RTRIM(IDVEND))    AS vendor_code,
    LTRIM(RTRIM(IDINVC))    AS document_number,
    CAST(IDTRXTYPE AS varchar(10)) AS document_type,
    DATEINVC                AS document_date_int,
    DATEINVCDU              AS due_date_int,
    AMTINVCHC               AS original_amount,
    AMTDUEHC                AS outstanding_amount,
    LTRIM(RTRIM(IDPONBR))   AS reference
  FROM APOBL
  WHERE AMTDUEHC <> 0
`,
});

define({
  key: 'creditor.ap_payment',
  label: 'Creditors — AP payments',
  purpose: 'Vendor payment (cheque) history within the sync window.',
  pool: 'bat_sage',
  tables: ['APTCR'],
  params: ['from', 'to'],
  requiredColumns: ['vendor_code', 'payment_number', 'payment_date_int', 'amount'],
  getOverride: readerSql('SELECT ap_payment_sql_override AS v FROM creditor_sync_settings WHERE id = 1'),
  defaultSql: `
  SELECT
    LTRIM(RTRIM(IDVEND))     AS vendor_code,
    LTRIM(RTRIM(IDRMIT))     AS payment_number,
    DATERMIT                 AS payment_date_int,
    LTRIM(RTRIM(PAYMCODE))   AS payment_method,
    AMTRMITHC                AS amount,
    LTRIM(RTRIM(TXTRMITREF)) AS reference,
    LTRIM(RTRIM(IDBANK))     AS bank_code
  FROM APTCR
  WHERE DATERMIT BETWEEN @from AND @to AND AMTRMITHC > 0
`,
});

define({
  key: 'creditor.po_header',
  label: 'Creditors — purchase order headers',
  purpose: 'Purchase order headers within the sync window.',
  pool: 'bat_sage',
  tables: ['POPORH1'],
  params: ['from', 'to'],
  requiredColumns: ['po_number', 'vendor_code', 'po_date_int'],
  getOverride: readerSql('SELECT po_header_sql_override AS v FROM creditor_sync_settings WHERE id = 1'),
  defaultSql: `
  SELECT
    LTRIM(RTRIM(PONUMBER))  AS po_number,
    LTRIM(RTRIM(VDCODE))    AS vendor_code,
    LTRIM(RTRIM(VDNAME))    AS vendor_name,
    DATE                    AS po_date_int,
    EXPARRIVAL              AS expected_date_int,
    CASE
      WHEN ISCOMPLETE = 1 THEN 'COMPLETE'
      WHEN ONHOLD     = 1 THEN 'ON HOLD'
      ELSE 'OPEN'
    END                     AS status,
    DOCTOTAL                AS total_amount
  FROM POPORH1
  WHERE DATE BETWEEN @from AND @to
`,
});

define({
  key: 'creditor.po_line',
  label: 'Creditors — purchase order lines',
  purpose: 'Purchase order line detail within the sync window.',
  pool: 'bat_sage',
  tables: ['POPORH1', 'POPORL'],
  params: ['from', 'to'],
  requiredColumns: ['po_number', 'line_no', 'item_number'],
  getOverride: readerSql('SELECT po_line_sql_override AS v FROM creditor_sync_settings WHERE id = 1'),
  defaultSql: `
  SELECT
    LTRIM(RTRIM(h.PONUMBER))  AS po_number,
    l.PORLSEQ                 AS line_no,
    LTRIM(RTRIM(l.ITEMNO))    AS item_number,
    LTRIM(RTRIM(l.ITEMDESC))  AS item_description,
    l.OQORDERED               AS qty_ordered,
    l.OQRECEIVED              AS qty_received,
    l.UNITCOST                AS unit_cost,
    l.EXTENDED                AS extended_cost
  FROM POPORH1 h
  INNER JOIN POPORL l ON l.PORHSEQ = h.PORHSEQ
  WHERE h.DATE BETWEEN @from AND @to
`,
});

define({
  key: 'commission.sales',
  label: 'Sales Commission — sweets sales',
  purpose: 'Sweets sales + credits per rep for the commission report (earned when raised).',
  pool: 'customer',
  tables: ['OESHDT', 'ICITEM'],
  params: ['from', 'to'],
  requiredColumns: ['sales_rep', 'gross_amount', 'credit_amount'],
  getOverride: readerSql('SELECT sales_query_override AS v FROM commission_settings WHERE id = 1'),
  defaultSql: `
SELECT LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, ''))) AS sales_rep,
       SUM(ISNULL(OESHDT.FAMTSALES, 0)) AS gross_amount,
       SUM(ISNULL(OESHDT.FRETSALES, 0)) AS credit_amount
FROM OESHDT
-- No ICITMV join: COMMODIM = '1' on ICITEM already filters to sweets, and
-- nothing here reads a vendor column. Joining the vendor table on ITEMNO
-- multiplies each shipment line by an item's vendor count, overstating sales,
-- credits and commission (same Sage cardinality trap jtiQuery.js avoids with EXISTS).
INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
WHERE OESHDT.TRANDATE BETWEEN @from AND @to
  AND LTRIM(RTRIM(ICITEM.COMMODIM)) = '1'
GROUP BY LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, '')))
`.trim(),
});

define({
  key: 'commission.receipts',
  label: 'Sales Commission — customer receipts',
  purpose: 'Customer payment receipts per rep (ex-VAT via @vat divisor).',
  pool: 'customer',
  tables: ['AROBP', 'ARCUS'],
  params: ['from', 'to', 'vat'],
  requiredColumns: ['sales_rep', 'receipt_amount'],
  getOverride: readerSql('SELECT receipts_query_override AS v FROM commission_settings WHERE id = 1'),
  defaultSql: `
SELECT LTRIM(RTRIM(ISNULL(c.CODESLSP1, ''))) AS sales_rep,
       SUM(ISNULL(o.AMTPAYMHC, 0)) / @vat AS receipt_amount
FROM AROBP o
INNER JOIN ARCUS c
  ON LTRIM(RTRIM(c.IDCUST)) = LTRIM(RTRIM(o.IDCUST))
 AND c.CODECURN = o.CODECURN
WHERE o.DATERMIT BETWEEN @from AND @to
  AND LTRIM(RTRIM(o.IDINVC)) LIKE 'PY%'
GROUP BY LTRIM(RTRIM(ISNULL(c.CODESLSP1, '')))
`.trim(),
});

define({
  key: 'commission.unpaid',
  label: 'Sales Commission — unpaid sweets invoices',
  purpose: 'Per-invoice list of sweets invoices in the period not fully paid (clawback tracking).',
  pool: 'customer',
  tables: ['OESHDT', 'ICITEM', 'AROBL', 'ARCUS'],
  params: ['from', 'to'],
  requiredColumns: ['sales_rep', 'invoice_number', 'customer_code', 'outstanding_amount', 'net_sweet_amount'],
  getOverride: readerSql('SELECT unpaid_query_override AS v FROM commission_settings WHERE id = 1'),
  defaultSql: `
SELECT LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, ''))) AS sales_rep,
       LTRIM(RTRIM(OESHDT.TRANNUM))              AS invoice_number,
       LTRIM(RTRIM(OESHDT.CUSTOMER))             AS customer_code,
       LTRIM(RTRIM(ISNULL(cu.NAMECUST, '')))     AS customer_name,
       MIN(OESHDT.TRANDATE)                      AS invoice_date,
       MAX(ar.AMTINVCHC)                         AS original_amount,
       MAX(ar.AMTDUEHC)                          AS outstanding_amount,
       SUM(ISNULL(OESHDT.FAMTSALES, 0))
         - SUM(ISNULL(OESHDT.FRETSALES, 0))      AS net_sweet_amount
FROM OESHDT
-- No ICITMV join (see sales query): joining the vendor table multiplies
-- shipment lines for multi-vendor items and would inflate the per-invoice
-- net sweet amount and the clawback snapshots built from it.
INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
INNER JOIN AROBL ar
  ON LTRIM(RTRIM(ar.IDINVC))  = LTRIM(RTRIM(OESHDT.TRANNUM))
 AND LTRIM(RTRIM(ar.IDCUST)) = LTRIM(RTRIM(OESHDT.CUSTOMER))
LEFT JOIN ARCUS cu
  ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(OESHDT.CUSTOMER))
WHERE OESHDT.TRANDATE BETWEEN @from AND @to
  AND LTRIM(RTRIM(ICITEM.COMMODIM)) = '1'
  AND ar.SWPAID = 0
GROUP BY LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, ''))),
         LTRIM(RTRIM(OESHDT.TRANNUM)),
         LTRIM(RTRIM(OESHDT.CUSTOMER)),
         LTRIM(RTRIM(ISNULL(cu.NAMECUST, '')))
ORDER BY sales_rep, MIN(OESHDT.TRANDATE), invoice_number
`.trim(),
});

define({
  key: 'jti.export',
  label: 'JTI Export — OE shipments',
  purpose: 'OE shipment lines for the JTI vendor export, filtered to the JTI vendor via ICITMV.',
  pool: 'jti',
  tables: ['OESHDT', 'ICITEM', 'ICITMV', 'ARCUS'],
  params: ['from', 'to', 'vendor'],
  requiredColumns: JTI_REQUIRED_COLUMNS,
  getOverride: readerSql("SELECT value AS v FROM jti_settings WHERE key = 'query_override'"),
  defaultSql: DEFAULT_JTI_SQL,
});

// ── Public API ──────────────────────────────────────────────────────────────

const BANNED_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|CREATE)\b/i;

/**
 * The single guardrail for an operator-supplied override. Returns an error
 * string, or null when the SQL is acceptable (or empty = clear to default).
 * Uses the registry descriptor's declared params + requiredColumns so each
 * query enforces its own contract.
 */
export function validateSageQueryOverride(sqlText, key) {
  const d = REGISTRY[key];
  if (!d) return `Unknown Sage query: ${key}`;
  if (sqlText === null || sqlText === undefined) return null;
  const s = String(sqlText).trim();
  if (s.length === 0) return null; // empty = clear back to default
  if (!/^(\s*--[^\n]*\n)*\s*(SELECT|WITH)\b/i.test(s)) return 'must start with SELECT or WITH (read-only)';
  if (BANNED_SQL.test(s)) return 'contains a forbidden write/DDL keyword';
  for (const p of d.params || []) {
    if (!new RegExp(`@${p}\\b`, 'i').test(s)) return `must reference the @${p} parameter`;
  }
  for (const c of d.requiredColumns || []) {
    if (!new RegExp(`\\b${c}\\b`, 'i').test(s)) return `must output a "${c}" column (the sync maps results by this alias)`;
  }
  if (s.length > 20_000) return 'too long (max 20,000 characters)';
  return null;
}

/**
 * Effective SQL for a query: the operator override when present, else the
 * shipped default. Non-validating (overrides are validated on save) so this
 * stays a drop-in for the old `(override || DEFAULT)` ternaries.
 */
export function resolveSageQuery(key) {
  const d = REGISTRY[key];
  if (!d) throw new Error(`Unknown Sage query: ${key}`);
  const override = d.getOverride ? (d.getOverride() || '').trim() : '';
  return override || d.defaultSql;
}

/** Descriptor for a single query (null if unknown). */
export function getSageQuery(key) {
  return REGISTRY[key] || null;
}

/** Every registered query + its current override state, for the admin screen. */
export function listSageQueries() {
  return Object.values(REGISTRY).map((d) => {
    const override = d.getOverride ? (d.getOverride() || '') : '';
    return {
      key: d.key,
      label: d.label,
      purpose: d.purpose,
      pool: d.pool,
      tables: d.tables,
      params: d.params || [],
      requiredColumns: d.requiredColumns || [],
      defaultSql: d.defaultSql,
      override: override.trim() ? override : null,
      overridable: Boolean(d.getOverride),
    };
  });
}
