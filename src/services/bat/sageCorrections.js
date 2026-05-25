import sql from 'mssql';
import { getSagePool } from '../batReconciliation.js';

const TEXTDESC_MAX_LEN = 60;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export function parseDescription(text) {
  const problems = [];
  if (!text || !text.trim()) {
    return { weekNumber: null, feeType: 'OTHER', isValid: false, problems: ['Empty description'] };
  }
  const trimmed = text.trim();
  if (trimmed.length > TEXTDESC_MAX_LEN) {
    problems.push(`Exceeds ${TEXTDESC_MAX_LEN} character limit (${trimmed.length})`);
  }
  if (!PRINTABLE_ASCII.test(trimmed)) {
    problems.push('Contains non-ASCII or control characters (only printable ASCII is allowed)');
  }

  let weekNumber = null;
  const weekMatch = trimmed.match(/WEEK\s+(\d{1,2})/i);
  if (weekMatch) {
    weekNumber = parseInt(weekMatch[1], 10);
    if (weekNumber < 1 || weekNumber > 53) {
      problems.push(`Week ${weekNumber} is out of range (1-53)`);
      weekNumber = null;
    }
  } else {
    problems.push('No week number found (expected "WEEK <number>")');
  }

  const upper = trimmed.toUpperCase();
  let feeType = 'OTHER';
  if (upper.startsWith('DELIVERY'))      feeType = 'DELIVERY FEE';
  else if (upper.startsWith('DISCOUNT')) feeType = 'DISCOUNT FEE';
  else if (upper.startsWith('PRICING'))  feeType = 'PRICING ADJ';
  else if (upper.startsWith('PRICE'))    feeType = 'PRICING ADJ';
  else problems.push('Unrecognised fee type prefix (expected DELIVERY, DISCOUNT, PRICING, or PRICE)');

  const isValid = problems.length === 0 && weekNumber !== null && feeType !== 'OTHER';
  return { weekNumber, feeType, isValid, problems };
}

export async function queryProblematicLines(year) {
  const pool = await getSagePool();
  const result = await pool.request()
    .input('year', sql.Int, year)
    .query(`
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
          WHEN fee_type = 'OTHER' THEN 'BAD_FEE_TYPE'
          ELSE 'OK'
        END AS problem_type
      FROM all_bat_lines
      ORDER BY
        CASE
          WHEN desc_week IS NULL THEN 0
          WHEN fee_type = 'OTHER' THEN 1
          ELSE 2
        END,
        CNTBTCH, CNTITEM, CNTLINE
    `);
  return result.recordset || [];
}

export async function readCurrentDescription(batchNumber, itemNumber, lineNumber) {
  const pool = await getSagePool();
  const result = await pool.request()
    .input('batch', sql.Int, batchNumber)
    .input('item', sql.Int, itemNumber)
    .input('line', sql.Int, lineNumber)
    .query('SELECT LTRIM(RTRIM(TEXTDESC)) AS textdesc FROM APIBD WHERE CNTBTCH = @batch AND CNTITEM = @item AND CNTLINE = @line');
  return result.recordset?.[0]?.textdesc ?? null;
}

export async function updateSageDescription({ batchNumber, itemNumber, lineNumber, newDescription }) {
  if (!newDescription || newDescription.trim().length === 0) {
    throw new Error('New description cannot be empty');
  }
  if (newDescription.length > TEXTDESC_MAX_LEN) {
    throw new Error(`Description exceeds ${TEXTDESC_MAX_LEN} character limit`);
  }
  if (!/^[\x20-\x7E]+$/.test(newDescription)) {
    throw new Error('Description contains non-printable characters');
  }

  const pool = await getSagePool();
  const result = await pool.request()
    .input('newDesc', sql.NVarChar(TEXTDESC_MAX_LEN), newDescription)
    .input('batch', sql.Int, batchNumber)
    .input('item', sql.Int, itemNumber)
    .input('line', sql.Int, lineNumber)
    .query('UPDATE APIBD SET TEXTDESC = @newDesc WHERE CNTBTCH = @batch AND CNTITEM = @item AND CNTLINE = @line');

  const affected = result.rowsAffected?.[0] ?? 0;
  if (affected === 0) throw new Error('No matching line found — it may have been deleted or the key is wrong');
  if (affected > 1) throw new Error(`Safety check failed: ${affected} rows would be affected (expected exactly 1)`);
  return { rowsAffected: affected };
}
