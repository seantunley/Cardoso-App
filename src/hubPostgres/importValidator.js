/**
 * src/hubPostgres/importValidator.js
 *
 * Validates a batch of records before import into Postgres staging.
 * Exported for use by both the import script and the sync engine.
 */

const REQUIRED_FIELDS = ['site_id', 'record_id', 'customer_number', 'customer_name'];
const VALID_FLAG_COLORS = ['none', 'red', 'orange', 'green', null];
const MAX_BALANCE = 999999999;

/**
 * @param {Array<Object>} records
 * @returns {{valid: boolean, errors: Array, warnings: Array, validCount: number, invalidCount: number}}
 */
export function validateImportBatch(records) {
  const errors = [];
  const warnings = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const record of records) {
    let recordErrors = [];

    // Required fields
    for (const field of REQUIRED_FIELDS) {
      if (record[field] === undefined || record[field] === null || record[field] === '') {
        recordErrors.push({ field, message: `required field missing or empty: ${field}` });
      }
    }

    // flag_color enum
    if (record.flag_color !== undefined && !VALID_FLAG_COLORS.includes(record.flag_color)) {
      recordErrors.push({ field: 'flag_color', message: `invalid flag_color: "${record.flag_color}" (expected: ${VALID_FLAG_COLORS.filter(Boolean).join('|')})` });
    }

    // outstanding_balance numeric check
    if (record.outstanding_balance !== undefined && record.outstanding_balance !== null && record.outstanding_balance !== '') {
      const val = parseFloat(record.outstanding_balance);
      if (isNaN(val)) {
        recordErrors.push({ field: 'outstanding_balance', message: `non-numeric outstanding_balance: "${record.outstanding_balance}"` });
      } else if (Math.abs(val) > MAX_BALANCE) {
        warnings.push({ record_id: record.record_id, field: 'outstanding_balance', message: `outlier balance: ${val}` });
      }
    }

    // unpaid_invoices JSON array
    if (record.unpaid_invoices !== undefined) {
      try {
        const arr = typeof record.unpaid_invoices === 'string' ? JSON.parse(record.unpaid_invoices) : record.unpaid_invoices;
        if (!Array.isArray(arr)) {
          recordErrors.push({ field: 'unpaid_invoices', message: 'must be a JSON array' });
        }
      } catch {
        recordErrors.push({ field: 'unpaid_invoices', message: 'must be valid JSON' });
      }
    }

    // receipts JSON array
    if (record.receipts !== undefined) {
      try {
        const arr = typeof record.receipts === 'string' ? JSON.parse(record.receipts) : record.receipts;
        if (!Array.isArray(arr)) {
          recordErrors.push({ field: 'receipts', message: 'must be a JSON array' });
        }
      } catch {
        recordErrors.push({ field: 'receipts', message: 'must be valid JSON' });
      }
    }

    if (recordErrors.length === 0) {
      validCount++;
    } else {
      invalidCount++;
      errors.push({ record_id: record.record_id, site_id: record.site_id, issues: recordErrors });
    }
  }

  const summary = {
    total: records.length,
    valid: validCount,
    invalid: invalidCount,
    warnings: warnings.length,
    errors: errors.slice(0, 50),
    errorsTruncated: errors.length > 50,
  };

  console.log(
    `[importValidator] batch=${records.length} valid=${validCount} invalid=${invalidCount} warnings=${warnings.length}`
  );

  return {
    valid: invalidCount === 0,
    errors,
    warnings,
    validCount,
    invalidCount,
    summary,
  };
}

/**
 * Quick smoke test when run directly
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { validateImportBatch } = await import('./importValidator.js');

  // Valid record
  const validResult = validateImportBatch([{
    site_id: 'ermelo-001',
    record_id: 'rec-001',
    customer_number: 'CUST-001',
    customer_name: 'Test Customer',
    flag_color: 'red',
    outstanding_balance: '1500.00',
    unpaid_invoices: '[]',
    receipts: '[]',
  }]);
  console.log('Valid record result:', validResult.valid ? 'PASS' : 'FAIL');

  // Invalid record (missing required fields)
  const invalidResult = validateImportBatch([{
    site_id: 'ermelo-001',
    record_id: 'rec-002',
    // missing customer_number and customer_name
    flag_color: 'purple', // invalid enum
    outstanding_balance: 'not-a-number',
  }]);
  console.log('Invalid record result:', !invalidResult.valid ? 'PASS (correctly rejected)' : 'FAIL');

  console.log('\nAll tests passed:', validResult.valid && !invalidResult.valid);
}