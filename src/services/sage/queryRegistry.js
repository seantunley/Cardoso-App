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
  key: 'creditor.ap_unposted_payment',
  label: 'Creditors — UNPOSTED AP payments',
  purpose: 'Cheques captured in AP Payment Entry whose batch has not been posted yet — APOBL still shows their invoices as open, so vendor outstanding is overstated until posting. The Creditor Balances page nets these off.',
  pool: 'bat_sage',
  tables: ['APTCR', 'APBTA'],
  params: [],
  requiredColumns: ['vendor_code', 'payment_number', 'payment_date_int', 'amount', 'batch_number'],
  getOverride: readerSql('SELECT ap_unposted_sql_override AS v FROM creditor_sync_settings WHERE id = 1'),
  // Join verified against live Sage (CARDAT): payment entries key on
  // APTCR.BTCHTYPE ('PY') + CNTBTCH ↔ APBTA.PAYMTYPE + CNTBTCH.
  // "Unposted" = POSTSEQNBR = 0 (no posting sequence assigned yet) AND
  // BATCHSTAT <> 4 (not a deleted batch) — deliberately NOT a list of
  // open/ready status codes, so it can't break on a status we never sampled.
  defaultSql: `
  SELECT
    LTRIM(RTRIM(t.IDVEND))      AS vendor_code,
    LTRIM(RTRIM(t.IDRMIT))      AS payment_number,
    t.DATERMIT                  AS payment_date_int,
    t.AMTRMITHC                 AS amount,
    t.CNTBTCH                   AS batch_number,
    b.BATCHSTAT                 AS batch_status,
    LTRIM(RTRIM(b.BATCHDESC))   AS batch_description
  FROM APTCR t
  JOIN APBTA b ON b.PAYMTYPE = t.BTCHTYPE AND b.CNTBTCH = t.CNTBTCH
  WHERE t.BTCHTYPE = 'PY' AND b.POSTSEQNBR = 0 AND b.BATCHSTAT <> 4 AND t.AMTRMITHC > 0
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

define({
  key: 'inventory.sales_agg',
  label: 'Inventory — monthly sales aggregates',
  purpose: 'Per-item monthly sales totals (qty + revenue) for inventory movement / Trends.',
  pool: 'bat_sage',
  tables: ['OESHDT', 'ICITEM'],
  params: ['from', 'to'],
  requiredColumns: ['item_number', 'period', 'qty_sold', 'revenue', 'last_sale_int'],
  defaultSql: `
  SELECT
    LTRIM(RTRIM(OESHDT.ITEM))         AS item_number,
    FORMAT(CAST(CAST(OESHDT.TRANDATE AS VARCHAR(8)) AS DATE), 'yyyy-MM') AS period,
    SUM(OESHDT.QTYSOLD)               AS qty_sold,
    SUM(OESHDT.FAMTSALES)             AS revenue,
    COUNT(*)                          AS order_count,
    MAX(OESHDT.TRANDATE)              AS last_sale_int,
    MAX(LTRIM(RTRIM(ICITEM.[DESC])))  AS item_description
  FROM OESHDT
  INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
  WHERE OESHDT.TRANDATE BETWEEN @from AND @to
    AND OESHDT.QTYSOLD > 0
  GROUP BY LTRIM(RTRIM(OESHDT.ITEM)),
           FORMAT(CAST(CAST(OESHDT.TRANDATE AS VARCHAR(8)) AS DATE), 'yyyy-MM')
  ORDER BY item_number, period
`,
});

define({
  key: 'inventory.sales_txn',
  label: 'Inventory — per-transaction sales',
  purpose: 'Per-transaction sales rows for forecasting drill-through.',
  pool: 'bat_sage',
  tables: ['OESHDT', 'ICITEM', 'ARCUS'],
  params: ['from', 'to'],
  requiredColumns: ['item_number', 'transaction_date_int', 'order_number', 'qty_sold', 'line_amount'],
  defaultSql: `
  SELECT
    LTRIM(RTRIM(OESHDT.ITEM))         AS item_number,
    OESHDT.TRANDATE                   AS transaction_date_int,
    LTRIM(RTRIM(OESHDT.TRANNUM))      AS order_number,
    LTRIM(RTRIM(OESHDT.CUSTOMER))     AS customer_code,
    LTRIM(RTRIM(ARCUS.NAMECUST))      AS customer_name,
    OESHDT.QTYSOLD                    AS qty_sold,
    CASE WHEN OESHDT.QTYSOLD > 0 THEN OESHDT.FAMTSALES / OESHDT.QTYSOLD ELSE NULL END AS unit_price,
    OESHDT.FAMTSALES                  AS line_amount
  FROM OESHDT
  INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
  LEFT JOIN ARCUS ON OESHDT.CUSTOMER = ARCUS.IDCUST
  WHERE OESHDT.TRANDATE BETWEEN @from AND @to
    AND OESHDT.QTYSOLD > 0
  ORDER BY OESHDT.TRANDATE DESC, OESHDT.ITEM
`,
});

define({
  key: 'pricing.price_lists',
  label: 'Pricing — price list enumeration',
  purpose: 'Available Sage price lists and their item counts.',
  pool: 'bat_sage',
  tables: ['ICPRICP'],
  params: [],
  requiredColumns: ['code', 'item_count'],
  defaultSql: `
  SELECT
    LTRIM(RTRIM(PRICELIST)) AS code,
    COUNT(DISTINCT ITEMNO)  AS item_count
  FROM ICPRICP
  WHERE LTRIM(RTRIM(PRICELIST)) <> ''
    AND UNITPRICE > 0
  GROUP BY LTRIM(RTRIM(PRICELIST))
  ORDER BY 1
`,
});

define({
  key: 'bat.sage_corrections',
  label: 'BAT — problematic fee lines',
  purpose: 'Scans BAT vendor AP lines for week-number typos / missing prefixes to correct.',
  pool: 'bat_sage',
  tables: ['APIBH', 'APIBD', 'APIBC'],
  params: ['year'],
  requiredColumns: ['batch_number', 'item_number', 'line_number', 'document_number', 'line_description', 'week_number', 'fee_type', 'problem_type'],
  defaultSql: `
  ;WITH all_bat_lines AS (
    SELECT
      d.CNTBTCH,
      d.CNTITEM,
      d.CNTLINE,
      h.IDVEND,
      h.IDINVC,
      h.DATEINVC,
      CAST(CAST(h.DATEINVC AS VARCHAR(8)) AS DATE) AS doc_date,
      bc.BTCHDESC,
      bc.BTCHSTTS,
      LTRIM(RTRIM(d.TEXTDESC)) AS textdesc,
      d.AMTDISTHC,
      CASE
        WHEN d.TEXTDESC LIKE '%WEEK [0-9]%'
          THEN CAST(LTRIM(RTRIM(SUBSTRING(d.TEXTDESC,
               PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5, 2))) AS INT)
        ELSE NULL
      END AS desc_week,
      CASE
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DELIVERY%' THEN 'DELIVERY FEE'
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DISCOUNT%' THEN 'DISCOUNT FEE'
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'PRICING%'  THEN 'PRICING ADJ'
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'PRICE%'    THEN 'PRICING ADJ'
        ELSE 'OTHER'
      END AS fee_type
    FROM APIBH h
    INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM
    LEFT JOIN APIBC bc ON bc.CNTBTCH = h.CNTBTCH
    WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'
      AND YEAR(CAST(CAST(h.DATEINVC AS VARCHAR(8)) AS DATE)) = @year
      AND LTRIM(RTRIM(d.TEXTDESC)) NOT LIKE '%Purchases Clearing Account%'
  )
  SELECT
    CNTBTCH   AS batch_number,
    CNTITEM   AS item_number,
    CNTLINE   AS line_number,
    LTRIM(RTRIM(IDVEND)) AS vendor_number,
    LTRIM(RTRIM(IDINVC)) AS document_number,
    DATEINVC  AS document_date,
    doc_date,
    LTRIM(RTRIM(COALESCE(BTCHDESC, ''))) AS batch_description,
    CASE BTCHSTTS
      WHEN 1 THEN 'Open'
      WHEN 3 THEN 'Posted'
      WHEN 4 THEN 'Deleted'
      WHEN 7 THEN 'Posted'
      WHEN NULL THEN 'Archived'
      ELSE 'Unknown'
    END AS batch_status,
    textdesc  AS line_description,
    desc_week AS week_number,
    fee_type,
    AMTDISTHC AS line_amount,
    CASE
      WHEN desc_week IS NULL THEN 'NO_WEEK'
      ELSE 'OK'
    END AS problem_type
  FROM all_bat_lines
  WHERE fee_type <> 'OTHER'
  ORDER BY CNTBTCH, CNTITEM, CNTLINE
`,
});

// ── Public API ──────────────────────────────────────────────────────────────

// Read/write keyword denylist for operator overrides. The REAL guarantee that an
// override stays read-only is a least-privilege, READ-ONLY Sage login (the DB
// rejects writes) — see docs/notes. This denylist is defense in depth so an
// override can't issue a write, DDL, an out-of-band read (OPENROWSET/OPENQUERY/
// BULK), SELECT…INTO (table creation), a time-based stall (WAITFOR), or a
// server-config command even if the connecting login is over-privileged.
const BANNED_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|CREATE|INTO|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|WAITFOR|RECONFIGURE|SHUTDOWN)\b/i;
// Extended / system stored procedures (xp_cmdshell, sp_executesql, …).
const BANNED_PROCS = /\b(?:xp|sp)_\w/i;

// Comment- AND string-literal-aware scrub for the read-only validator. Returns
// the SQL with /* */ and -- comments removed AND the CONTENTS of string /
// quoted-identifier literals blanked. This is required for the denylist + single-
// statement checks to be sound: a naive comment strip can be fooled by a literal
// like SELECT '--'; DROP TABLE x (the -- inside the string is NOT a comment to
// SQL Server, so the regex would wrongly eat the real ;DROP), and would also
// false-positive on a legitimate literal that contains ';' or '--'. Tracks
// '...', "..." and [...] with their ''/""/]] escapes; -- and /* */ are treated
// as comments only OUTSIDE a literal.
//
// `keepDelimitedIds`: the read-only keyword/statement scan wants delimited
// identifiers blanked too (a column named [DELETE] or [a;b] must not trip the
// keyword/`;` checks). But the required-column smoke check must still SEE
// delimited aliases — JTI writes its reserved-word alias as `AS [DESC]` — so it
// passes this true to keep [...] and "..." (still blanking '...' string literals,
// which can never be an alias).
export function scrubSqlForValidation(sqlText, { keepDelimitedIds = false } = {}) {
  const src = String(sqlText ?? '');
  let out = '';
  let i = 0;
  const n = src.length;
  // Consume a quoted span. When `keep`, copy it verbatim (so a delimited alias
  // like [DESC] survives for the column check); otherwise emit a single space in
  // its place. `close` doubled (''/""/]]) is an escaped delimiter, not the end.
  const consume = (close, keep) => {
    if (keep) out += src[i];
    i += 1; // past the opening delimiter
    while (i < n) {
      if (src[i] === close && src[i + 1] === close) { if (keep) out += close + close; i += 2; continue; }
      if (src[i] === close) { if (keep) out += close; i += 1; break; }
      if (keep) out += src[i];
      i += 1;
    }
    if (!keep) out += ' ';
  };
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (c === "'") { consume("'", false); continue; }                 // string literal — always blanked
    if (c === '"') { consume('"', keepDelimitedIds); continue; }       // quoted identifier (or string)
    if (c === '[') { consume(']', keepDelimitedIds); continue; }       // bracketed identifier
    if (c === '-' && c2 === '-') { while (i < n && src[i] !== '\n') i += 1; out += ' '; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Security core shared by every Sage override validator: must be a single,
 * read-only SELECT/WITH statement with no write/DDL/out-of-band/proc escapes.
 * Returns an error string, or null when acceptable (empty is caller-handled).
 * Checks the comment-stripped form.
 */
export function readOnlyOverrideViolation(sqlText) {
  const s = String(sqlText ?? '').trim();
  if (s.length === 0) return null;
  if (s.length > 20_000) return 'too long (max 20,000 characters)';
  const clean = scrubSqlForValidation(s).trim();
  // Must start with SELECT or WITH. A leading ';' is allowed — the BAT
  // corrections default is a T-SQL CTE that legitimately starts ";WITH".
  if (!/^(\s|;)*(SELECT|WITH)\b/i.test(clean)) return 'must start with SELECT or WITH (read-only)';
  if (BANNED_KEYWORDS.test(clean)) return 'contains a forbidden write / DDL / out-of-band keyword (e.g. INTO, OPENROWSET, WAITFOR)';
  if (BANNED_PROCS.test(clean)) return 'contains a forbidden stored-procedure reference (xp_/sp_)';
  // Single statement only — a leading ';' (CTE batch separator) and a trailing
  // ';' are fine; a ';' with another statement after it is not.
  if (clean.split(';').map((x) => x.trim()).filter(Boolean).length > 1) {
    return 'must be a single statement (no second ";"-separated statement)';
  }
  return null;
}

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
  const sec = readOnlyOverrideViolation(s);
  if (sec) return sec;
  // Keep delimited identifiers here so a reserved-word alias like `AS [DESC]`
  // (jti.export) is still visible to the required-column smoke check.
  const clean = scrubSqlForValidation(s, { keepDelimitedIds: true });
  for (const p of d.params || []) {
    if (!new RegExp(`@${p}\\b`, 'i').test(clean)) return `must reference the @${p} parameter`;
  }
  for (const c of d.requiredColumns || []) {
    if (!new RegExp(`\\b${c}\\b`, 'i').test(clean)) return `must output a "${c}" column (the sync maps results by this alias)`;
  }
  return null;
}

// Unified override store (migration v095). This is the primary source for every
// query; the descriptor's legacy getOverride() (the old per-module column / KV
// row) is kept only as a read-only fallback for a value not yet migrated.
// Returns the unified-store row's sql_text, or undefined when there is NO row.
// Distinguishing "no row" from "row with an empty value" matters: an empty row
// is the explicit "use the shipped default" marker (see setSageQueryOverride).
function readUnifiedRow(key) {
  try {
    const row = db.prepare('SELECT sql_text FROM sage_query_override WHERE query_key = ?').get(key);
    return row ? (row.sql_text ?? '') : undefined;
  } catch {
    return undefined; // table not present yet (pre-migration)
  }
}

function effectiveOverride(d) {
  const unified = readUnifiedRow(d.key);
  if (unified !== undefined) {
    // A unified row is authoritative — an empty value is the explicit "use the
    // shipped default" marker, which SUPPRESSES the legacy fallback (v095 copies
    // legacy overrides into the unified store but leaves the old store
    // populated, so without this a "Reset to default" would reactivate it).
    const s = String(unified).trim();
    return s || null;
  }
  // No unified state at all → fall back to the legacy per-module store, for any
  // override the migration didn't carry across.
  const legacy = d.getOverride ? (d.getOverride() || '').trim() : '';
  return legacy || null;
}

/**
 * Set (or clear, when sqlText is empty) the override for a query in the unified
 * store. Validates first and throws on a bad override. Returns {key, cleared}.
 */
export function setSageQueryOverride(key, sqlText, userId = null) {
  const d = REGISTRY[key];
  if (!d) throw new Error(`Unknown Sage query: ${key}`);
  const s = (sqlText || '').trim();
  if (s.length === 0) {
    // Clear back to the shipped default. Persist an explicit empty "use default"
    // marker (NOT a delete) so a pre-v095 legacy override left in the old store
    // can't reactivate via effectiveOverride()'s fallback once the row is gone.
    db.prepare(`
      INSERT INTO sage_query_override (query_key, sql_text, updated_by, updated_at)
      VALUES (?, '', ?, now_local())
      ON CONFLICT(query_key) DO UPDATE SET
        sql_text = '', updated_by = excluded.updated_by, updated_at = now_local()
    `).run(key, userId);
    return { key, cleared: true };
  }
  const issue = validateSageQueryOverride(s, key);
  if (issue) throw new Error(issue);
  db.prepare(`
    INSERT INTO sage_query_override (query_key, sql_text, updated_by, updated_at)
    VALUES (?, ?, ?, now_local())
    ON CONFLICT(query_key) DO UPDATE SET
      sql_text = excluded.sql_text, updated_by = excluded.updated_by, updated_at = now_local()
  `).run(key, s, userId);
  return { key, cleared: false };
}

/**
 * Effective SQL for a query: the operator override when present, else the
 * shipped default. Non-validating (overrides are validated on save) so this
 * stays a drop-in for the old `(override || DEFAULT)` ternaries.
 */
export function resolveSageQuery(key) {
  const d = REGISTRY[key];
  if (!d) throw new Error(`Unknown Sage query: ${key}`);
  return effectiveOverride(d) || d.defaultSql;
}

/** Descriptor for a single query (null if unknown). */
export function getSageQuery(key) {
  return REGISTRY[key] || null;
}

/** Every registered query + its current override state, for the admin screen. */
export function listSageQueries() {
  return Object.values(REGISTRY).map((d) => {
    const override = effectiveOverride(d);
    return {
      key: d.key,
      label: d.label,
      purpose: d.purpose,
      pool: d.pool,
      tables: d.tables,
      params: d.params || [],
      requiredColumns: d.requiredColumns || [],
      defaultSql: d.defaultSql,
      override: override || null,
      overridable: true,
    };
  });
}
