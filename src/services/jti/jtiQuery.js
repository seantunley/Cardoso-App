// JTI export — Sage 300 SQL query.
//
// Queries OE Shipment History (OESHDT) joined to the item master,
// vendor link table (filtered to JTI vendors), and customer master
// for the address fields. Returns rows in the exact shape the
// jtiSpreadsheet builder consumes.
//
// Two functions are exported:
//   - buildJtiSql({ fromDate, toDate })  — pure: returns { sql, params }
//   - queryJtiSales({ pool, fromDate, toDate }) — runs the query
//
// The split exists so the SQL itself can be unit-tested without a
// live Sage pool. The route handler calls queryJtiSales; tests can
// drive buildJtiSql directly.
//
// SQL design notes:
//
//   1. Vendor filter via EXISTS, not INNER JOIN, to dedupe items
//      that have multiple JTI vendor codes (e.g. JTI001 + JTI002).
//      An INNER JOIN against ICITMV would multiply rows; EXISTS gives
//      one row per shipment line regardless of vendor count.
//
//   2. TRANDATE in Sage 300 is INT YYYYMMDD, not DATETIME. The date
//      range parameters are passed as integers to match the column
//      type — no date parsing/casting on the SQL side.
//
//   3. ORDER BY TRANDATE matches the macro's final sort step. The
//      spreadsheet builder preserves input order, so sorting must
//      happen here (or upstream — keeping it here means the consumer
//      sees a sorted file even if the builder is called directly).
//
//   4. Parameterised inputs (mssql @-named) for the date range,
//      defence-in-depth even though we coerce to int beforehand.
//      The vendor pattern is hardcoded — no user input there.

const JTI_VENDOR_PATTERN = '%JTI%';

// The output spreadsheet builder consumes these seven aliases. Any
// query (default OR override) that doesn't surface all of them will
// produce a malformed .xlsx — so we enforce the contract twice:
//   - validateOverrideSql  rejects bad SQL on save (PUT /settings)
//   - assertRecordsetShape rejects bad recordsets on read (POST /export)
// Belt-and-braces: a SELECT can pass the regex but still return
// missing columns at runtime (e.g. dynamic SQL, conditional projection).
export const JTI_REQUIRED_COLUMNS = [
  'TRANNUM', 'TRANDATE', 'ITEM', 'DESC', 'CUSTOMER', 'NAMECUST', 'QTYSOLD',
];

/**
 * Coerce a Date / number / string to an integer YYYYMMDD. Sage 300
 * stores TRANDATE as INT in this format, and the WHERE clause
 * compares against that column directly.
 *
 * @param {Date | number | string} value
 * @returns {number}  e.g. 20260430
 * @throws {RangeError} when the value can't produce a plausible date
 */
export function toYyyymmddInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 19000101 || value > 21001231) {
      throw new RangeError(`toYyyymmddInt: integer ${value} out of plausible YYYYMMDD range`);
    }
    return value;
  }
  if (typeof value === 'string' && /^\d{8}$/.test(value.trim())) {
    return Number(value.trim());
  }
  const d = value instanceof Date ? value : new Date(value);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new RangeError(`toYyyymmddInt: cannot parse "${value}" as a date`);
  }
  // UTC components match jtiFilename.formatYyyymmdd — same reasoning:
  // a server in a positive TZ offset shouldn't shift the day.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return Number(`${yyyy}${mm}${dd}`);
}

// Default query — the version-controlled SQL that ships with the
// codebase. Operators can override it via jti_settings.query_override
// (admin-gated UI on the JTI page). The default + override go through
// the same param-binding path; only the SQL string differs.
//
// String columns are trimmed to match the macro's output exactly.
//
// Most fields use LTRIM(RTRIM(...)) — Sage 300 stores them as CHAR(N)
// with right-side space padding, and a small number of records carry
// a leading space from data-entry slips. Both kinds of whitespace
// are noise to the consumer pipeline.
//
// ICITEM.[DESC] is the EXCEPTION — RTRIM only, no LTRIM. Some
// product names are stored with INTENTIONAL leading whitespace (e.g.
// "  CAMEL CLASSIC **BOX**") to control how they sort/group on
// printed reports. The downstream pipeline relies on that exact
// value; stripping the leading spaces would diverge from the macro.
export const DEFAULT_JTI_SQL = `
    SELECT
      LTRIM(RTRIM(OESHDT.TRANNUM))   AS TRANNUM,
      OESHDT.TRANDATE                AS TRANDATE,
      LTRIM(RTRIM(OESHDT.ITEM))      AS ITEM,
      RTRIM(ICITEM.[DESC])           AS [DESC],
      LTRIM(RTRIM(OESHDT.CUSTOMER))  AS CUSTOMER,
      LTRIM(RTRIM(ARCUS.NAMECUST))   AS NAMECUST,
      OESHDT.QTYSOLD                 AS QTYSOLD
    FROM OESHDT OESHDT
    INNER JOIN ICITEM ICITEM
      ON OESHDT.ITEM = ICITEM.ITEMNO
    LEFT JOIN ARCUS ARCUS
      ON OESHDT.CUSTOMER = ARCUS.IDCUST
    WHERE OESHDT.TRANDATE BETWEEN @from AND @to
      AND EXISTS (
        SELECT 1
        FROM ICITMV ICITMV
        WHERE ICITMV.ITEMNO = OESHDT.ITEM
          AND ICITMV.VENDNUM LIKE @vendor
      )
    -- ORDER BY Date only — same-day rows keep Sage's natural row
    -- order, which is what the Crystal-report-plus-Excel-macro flow
    -- produces. Adding TRANNUM/ITEM tiebreakers here would put
    -- 'CN…' rows before 'IN…' rows within a day (alphabetical) and
    -- diverge from the operator's expected ordering.
    ORDER BY OESHDT.TRANDATE ASC
  `;

/**
 * Build the parameterised SQL + param map for the JTI query.
 *
 * @param {{
 *   fromDate: Date | number | string,
 *   toDate: Date | number | string,
 *   sqlOverride?: string,    // operator-supplied SQL; defaults to DEFAULT_JTI_SQL
 * }} args
 * @returns {{ sql: string, params: { from: number, to: number, vendor: string } }}
 * @throws {RangeError} when dates are invalid
 * @throws {Error}      when fromDate > toDate
 */
export function buildJtiSql({ fromDate, toDate, sqlOverride }) {
  if (fromDate == null || toDate == null) {
    throw new TypeError('buildJtiSql: fromDate and toDate are required');
  }
  const from = toYyyymmddInt(fromDate);
  const to = toYyyymmddInt(toDate);
  if (from > to) {
    throw new Error(`buildJtiSql: fromDate (${from}) must not be after toDate (${to})`);
  }

  const sql = (typeof sqlOverride === 'string' && sqlOverride.trim().length > 0)
    ? sqlOverride
    : DEFAULT_JTI_SQL;

  return {
    sql,
    params: { from, to, vendor: JTI_VENDOR_PATTERN },
  };
}

/**
 * Validate an operator-supplied SQL override BEFORE storing it. Catches
 * the obvious foot-guns:
 *   - missing @from / @to (date filter would be silently lost)
 *   - missing required columns in the SELECT (recordset would be
 *     incomplete; the runtime contract assert below would also catch
 *     this, but tripping at SAVE time is friendlier)
 *   - non-SELECT statements (no INSERT / UPDATE / DELETE / DROP etc.)
 *   - missing @vendor (warning not error — operator may legitimately
 *     hardcode the vendor pattern in their override)
 *
 * Returns an array of issue strings. Empty array = OK to save.
 *
 * @param {string} sqlText
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateOverrideSql(sqlText) {
  const errors = [];
  const warnings = [];
  const trimmed = String(sqlText || '').trim();
  if (!trimmed) return { errors, warnings };  // empty = "no override", legit

  // Must START with SELECT (or a WITH for CTEs). No mutating verbs.
  if (!/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
    errors.push('Override SQL must begin with SELECT (or WITH for CTEs). Mutating statements are not allowed.');
  }
  // Reject mutating verbs anywhere in the script, in case someone
  // chains `; UPDATE …` after a SELECT.
  if (/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|MERGE|EXEC|EXECUTE|CREATE|ALTER|GRANT|REVOKE)\b/i.test(trimmed)) {
    errors.push('Override SQL contains a mutating keyword (INSERT/UPDATE/DELETE/DROP/TRUNCATE/MERGE/EXEC/CREATE/ALTER/GRANT/REVOKE).');
  }

  // Required date params.
  if (!/@from\b/i.test(trimmed)) errors.push('Override SQL must reference @from in the WHERE clause.');
  if (!/@to\b/i.test(trimmed))   errors.push('Override SQL must reference @to in the WHERE clause.');
  if (!/@vendor\b/i.test(trimmed)) {
    warnings.push('Override SQL does not reference @vendor — make sure your vendor filter is hardcoded if you intended that.');
  }

  // Must surface every required output column. We look for
  //   "AS <COL>"  OR  "<COL> AS"  OR a bare reference (column name
  // appearing as a token). This is intentionally permissive — a
  // tighter regex would reject legitimate variants like square-
  // bracketed identifiers. The runtime contract assert is the
  // hard pin; this is a save-time smoke check.
  for (const col of JTI_REQUIRED_COLUMNS) {
    const re = new RegExp(`\\b(?:AS\\s+\\[?${col}\\]?|\\[?${col}\\]?\\b)`, 'i');
    if (!re.test(trimmed)) {
      errors.push(`Override SQL must surface a column called ${col} (the spreadsheet builder reads it by that exact alias).`);
    }
  }

  return { errors, warnings };
}

/**
 * Runtime contract enforcement: after the query returns, verify the
 * recordset has every required column on its first row. Empty
 * recordsets pass (no rows means no contract to break).
 *
 * Why duplicate the save-time check: validateOverrideSql is a regex
 * smoke test on the SQL TEXT. assertRecordsetShape verifies what the
 * SQL actually RETURNED. A clever override could pass the regex but
 * conditionally drop a column at runtime — only the recordset check
 * catches that.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @throws {Error} listing missing columns
 */
export function assertRecordsetShape(rows) {
  if (!Array.isArray(rows)) throw new TypeError('assertRecordsetShape: rows must be an array');
  if (rows.length === 0) return;
  const sample = rows[0];
  const present = new Set(Object.keys(sample));
  const missing = JTI_REQUIRED_COLUMNS.filter((c) => !present.has(c));
  if (missing.length > 0) {
    throw new Error(
      `JTI query returned rows missing required columns: ${missing.join(', ')}. ` +
      `Edit the query in Settings → JTI to surface every required column (TRANNUM, TRANDATE, ITEM, DESC, CUSTOMER, NAMECUST, QTYSOLD).`
    );
  }
}

/**
 * Execute the JTI query against a Sage 300 pool.
 *
 * @param {{
 *   pool: { request: () => any },          // mssql ConnectionPool
 *   fromDate: Date | number | string,
 *   toDate: Date | number | string,
 *   sqlOverride?: string,                  // operator-supplied SQL (defaults to DEFAULT_JTI_SQL)
 * }} args
 * @returns {Promise<Array<{
 *   TRANNUM: string, TRANDATE: number, ITEM: string,
 *   DESC: string, CUSTOMER: string, NAMECUST: string | null, QTYSOLD: number
 * }>>}
 * @throws {Error} when the recordset is missing any of the required
 *                 JTI_REQUIRED_COLUMNS (column-contract enforcement)
 */
export async function queryJtiSales({ pool, fromDate, toDate, sqlOverride }) {
  if (!pool || typeof pool.request !== 'function') {
    throw new TypeError('queryJtiSales: a Sage pool with .request() is required');
  }
  const { sql, params } = buildJtiSql({ fromDate, toDate, sqlOverride });
  const req = pool.request();
  req.input('from', params.from);
  req.input('to', params.to);
  req.input('vendor', params.vendor);
  const result = await req.query(sql);
  const rows = result.recordset || [];
  // Enforce the column contract before handing rows to the spreadsheet
  // builder. Loud failure here is much better than producing a quietly
  // malformed .xlsx for the downstream pipeline.
  assertRecordsetShape(rows);
  return rows;
}
