#!/usr/bin/env node
/**
 * scripts/validate-import-data.js
 * Ralph-loop Slice 3: validate SQLite export against Postgres schema requirements.
 *
 * Usage: node scripts/validate-import-data.js <export-file.jsonl>
 *   or   node scripts/validate-import-data.js   (reads sample from tmp/ if no arg)
 *
 * Exits non-zero if critical validation errors are found.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const REQUIRED_FIELDS = ['site_id', 'record_id', 'customer_number', 'customer_name'];
const VALID_FLAG_COLORS = ['none', 'red', 'orange', 'green', null];
const MAX_OUTSTANDING_BALANCE = 999999999;

const exportFile = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(process.cwd(), 'tmp/hub-export-sample.jsonl');

let raw;
try {
  raw = readFileSync(exportFile, 'utf8').trim();
} catch {
  console.error(`[validate-import] file not found: ${exportFile}`);
  console.error('Usage: node scripts/validate-import-data.js <export-file.jsonl>');
  process.exit(1);
}

if (!raw) {
  console.warn('[validate-import] empty export file — nothing to validate');
  process.exit(0);
}

const lines = raw.split('\n').filter(Boolean);
const errors = [];
const warnings = [];
let validCount = 0;
let invalidCount = 0;

lines.forEach((line, idx) => {
  const lineno = idx + 1;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    errors.push({ lineno, field: '_raw', message: 'invalid JSON' });
    invalidCount++;
    return;
  }

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined || record[field] === null || record[field] === '') {
      errors.push({ lineno, field, message: `required field missing or empty: ${field}` });
    }
  }

  // flag_color enum
  if (record.flag_color !== undefined && !VALID_FLAG_COLORS.includes(record.flag_color)) {
    errors.push({ lineno, field: 'flag_color', message: `invalid flag_color: "${record.flag_color}" (expected: ${VALID_FLAG_COLORS.filter(Boolean).join('|')})` });
  }

  // outstanding_balance numeric check
  if (record.outstanding_balance !== undefined && record.outstanding_balance !== null && record.outstanding_balance !== '') {
    const val = parseFloat(record.outstanding_balance);
    if (isNaN(val)) {
      errors.push({ lineno, field: 'outstanding_balance', message: `non-numeric outstanding_balance: "${record.outstanding_balance}"` });
    } else if (Math.abs(val) > MAX_OUTSTANDING_BALANCE) {
      warnings.push({ lineno, field: 'outstanding_balance', message: `outlier balance: ${val}` });
    }
  }

  // unpaid_invoices / receipts JSON array check
  if (record.unpaid_invoices !== undefined) {
    try {
      const arr = typeof record.unpaid_invoices === 'string' ? JSON.parse(record.unpaid_invoices) : record.unpaid_invoices;
      if (!Array.isArray(arr)) {
        errors.push({ lineno, field: 'unpaid_invoices', message: 'unpaid_invoices must be a JSON array' });
      }
    } catch {
      errors.push({ lineno, field: 'unpaid_invoices', message: 'unpaid_invoices must be valid JSON' });
    }
  }

  if (record.receipts !== undefined) {
    try {
      const arr = typeof record.receipts === 'string' ? JSON.parse(record.receipts) : record.receipts;
      if (!Array.isArray(arr)) {
        errors.push({ lineno, field: 'receipts', message: 'receipts must be a JSON array' });
      }
    } catch {
      errors.push({ lineno, field: 'receipts', message: 'receipts must be valid JSON' });
    }
  }

  if (errors.filter(e => e.lineno === lineno).length === 0) {
    validCount++;
  } else {
    invalidCount++;
  }
});

// Summary
console.log(`\n[validate-import] ${exportFile}`);
console.log(`  Total records: ${lines.length}`);
console.log(`  Valid:         ${validCount}`);
console.log(`  Invalid:       ${invalidCount}`);
console.log(`  Warnings:      ${warnings.length}`);

if (errors.length > 0) {
  console.log('\n  Errors:');
  errors.slice(0, 20).forEach(e => console.log(`    line ${e.lineno}.${e.field}: ${e.message}`));
  if (errors.length > 20) console.log(`    ... and ${errors.length - 20} more`);
}

if (warnings.length > 0) {
  console.log('\n  Warnings:');
  warnings.slice(0, 10).forEach(w => console.log(`    line ${w.lineno}.${w.field}: ${w.message}`));
  if (warnings.length > 10) console.log(`    ... and ${warnings.length - 10} more`);
}

console.log('');

if (invalidCount > 0) {
  console.error(`[validate-import] FAILED — ${invalidCount} invalid record(s)`);
  process.exit(1);
} else {
  console.log('[validate-import] PASSED — all records valid');
  process.exit(0);
}