import sql from 'mssql';
import { getSagePool } from '../batReconciliation.js';
import { logError } from '../../lib/errorLog.js';
import { resolveSageQuery } from '../sage/queryRegistry.js';

const TEXTDESC_MAX_LEN = 60;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

// Plain Wagner-Fischer Levenshtein distance — used to spot typos like
// WEK → WEEK or FE → FEE. Inputs are short single words; no need for
// the row-only memory optimisation.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Detect a misspelled WEEK keyword: any 3-6 letter word followed by a
// 1-2 digit number, where the word is within edit-distance 2 of WEEK.
// "WEK 12", "WEAK 12", "WEEEK 12" → all caught. Returns the canonical
// "WEEK <N>" suggestion, or null if no typo is found.
function detectWeekTypo(text) {
  const upper = (text || '').toUpperCase();
  const re = /\b([A-Z]{3,6})\s+(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(upper)) !== null) {
    const word = m[1];
    if (word === 'WEEK') return null; // canonical is already present
    const d = levenshtein(word, 'WEEK');
    if (d > 0 && d <= 2) {
      return { actual: word, suggestion: `WEEK ${m[2]}` };
    }
  }
  return null;
}

// Detect a misspelled FEE/ADJ keyword. For a valid prefix line, the
// second word should be FEE (DELIVERY/DISCOUNT) or ADJ (PRICING/PRICE).
// "DELIVERY FE WEEK 12" → typo of FEE. Returns null when the second
// word is already canonical or too far from canonical to be a typo.
function detectKeywordTypo(text, feeType) {
  const expected = (feeType || '').split(' ')[1]; // 'FEE' or 'ADJ'
  if (!expected) return null;
  const upper = (text || '').toUpperCase();
  const tokens = upper.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  // Find any token that IS the expected keyword anywhere in the line —
  // if present, there's no typo to fix.
  if (tokens.includes(expected)) return null;
  // Otherwise check token #2 (immediately after the prefix) for a typo
  const actual = tokens[1];
  if (actual.length < 2 || actual.length > 4) return null;
  const d = levenshtein(actual, expected);
  if (d > 0 && d <= 1) {
    return { actual, suggestion: expected };
  }
  return null;
}

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
  logError('sageCorrections.run', new Error(`sageCorrections.run scan starting for year ${year}`), { year }, 'info');
  try {
    const pool = await getSagePool();
    const result = await pool.request()
    .input('year', sql.Int, year)
    .query(resolveSageQuery('bat.sage_corrections'));

  // Post-process to catch spelling mistakes that SQL alone can't see:
  //   - NO_WEEK rows where the line actually has "WEREK 12" / "WEK 12" etc.
  //     → reclassify as SPELLING with the canonical "WEEK <N>" suggestion.
  //   - OK rows where the second word is a typo of FEE or ADJ
  //     (e.g. "DELIVERY FE WEEK 12") → reclassify as SPELLING.
  // These previously slipped through and broke BAT reconciliation matching
  // because the canonical regex never hit.
  const PROBLEM_RANK = { SPELLING: 0, NO_WEEK: 1, OK: 2 };
  const lines = (result.recordset || []).map(row => {
    if (row.problem_type === 'NO_WEEK') {
      const typo = detectWeekTypo(row.line_description);
      if (typo) {
        return { ...row, problem_type: 'SPELLING', spelling_kind: 'WEEK', spelling_actual: typo.actual, suggestion: typo.suggestion };
      }
      return row;
    }
    if (row.problem_type === 'OK') {
      const typo = detectKeywordTypo(row.line_description, row.fee_type);
      if (typo) {
        return { ...row, problem_type: 'SPELLING', spelling_kind: 'KEYWORD', spelling_actual: typo.actual, suggestion: typo.suggestion };
      }
    }
    return row;
  });

  lines.sort((a, b) => {
    const ra = PROBLEM_RANK[a.problem_type] ?? 3;
    const rb = PROBLEM_RANK[b.problem_type] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.batch_number !== b.batch_number) return a.batch_number - b.batch_number;
    if (a.item_number !== b.item_number) return a.item_number - b.item_number;
    return a.line_number - b.line_number;
  });

    logError('sageCorrections.run', new Error(`sageCorrections.run completed: ${lines.length} lines for year ${year}`), { year, total_lines: lines.length }, 'info');
    return lines;
  } catch (err) {
    logError('sageCorrections.run', err, { year });
    throw err;
  }
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

  try {
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
  } catch (err) {
    logError('sageCorrections.update_description', err, { batchNumber, itemNumber, lineNumber });
    throw err;
  }
}
