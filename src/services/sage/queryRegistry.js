import db from '../../db/index.js';

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
