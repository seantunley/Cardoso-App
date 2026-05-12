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

/**
 * Build the parameterised SQL + param map for the JTI query.
 *
 * @param {{ fromDate: Date | number | string, toDate: Date | number | string }} args
 * @returns {{ sql: string, params: { from: number, to: number, vendor: string } }}
 * @throws {RangeError} when dates are invalid
 * @throws {Error}      when fromDate > toDate
 */
export function buildJtiSql({ fromDate, toDate }) {
  if (fromDate == null || toDate == null) {
    throw new TypeError('buildJtiSql: fromDate and toDate are required');
  }
  const from = toYyyymmddInt(fromDate);
  const to = toYyyymmddInt(toDate);
  if (from > to) {
    throw new Error(`buildJtiSql: fromDate (${from}) must not be after toDate (${to})`);
  }

  const sql = `
    SELECT
      OESHDT.TRANNUM       AS TRANNUM,
      OESHDT.TRANDATE      AS TRANDATE,
      OESHDT.ITEM          AS ITEM,
      ICITEM.[DESC]        AS [DESC],
      OESHDT.CUSTOMER      AS CUSTOMER,
      ARCUS.NAMECUST       AS NAMECUST,
      OESHDT.QTYSOLD       AS QTYSOLD
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
    ORDER BY OESHDT.TRANDATE ASC, OESHDT.TRANNUM ASC, OESHDT.ITEM ASC
  `;

  return {
    sql,
    params: {
      from,
      to,
      vendor: JTI_VENDOR_PATTERN,
    },
  };
}

/**
 * Execute the JTI query against a Sage 300 pool.
 *
 * @param {{
 *   pool: { request: () => any },          // mssql ConnectionPool
 *   fromDate: Date | number | string,
 *   toDate: Date | number | string,
 * }} args
 * @returns {Promise<Array<{
 *   TRANNUM: string, TRANDATE: number, ITEM: string,
 *   DESC: string, CUSTOMER: string, NAMECUST: string | null, QTYSOLD: number
 * }>>}
 */
export async function queryJtiSales({ pool, fromDate, toDate }) {
  if (!pool || typeof pool.request !== 'function') {
    throw new TypeError('queryJtiSales: a Sage pool with .request() is required');
  }
  const { sql, params } = buildJtiSql({ fromDate, toDate });
  const req = pool.request();
  req.input('from', params.from);
  req.input('to', params.to);
  req.input('vendor', params.vendor);
  const result = await req.query(sql);
  return result.recordset || [];
}
