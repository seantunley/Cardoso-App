// Tests for src/hubPostgres/importValidator.js
//
// validateImportBatch gates every record entering the hub's Postgres
// staging table. A record that gets through here ends up in
// hub_records and drives the operator's customer-balances view, the
// flag-color UI, and downstream analytics — bad shapes have a long
// tail of downstream confusion (Postgres type errors, NaN totals,
// broken flag chips). The module is small (131 lines) and pure, but
// it sits on a high-traffic write path; locking the contract down
// with vitest pays for itself the first time someone tweaks the
// allowed flag_color enum or the JSON-column shapes.
//
// Existing coverage was a single in-file smoke test that runs only
// when the module is executed directly (CLI). Promote those checks
// to vitest + add the corner cases.

import { describe, it, expect, vi } from 'vitest';
import { validateImportBatch } from '../src/hubPostgres/importValidator.js';

// Silence the module's [importValidator] summary log so test output
// stays clean. The log is structural to the module (operators read it
// when an import batch fails); it's just noise inside the test runner.
vi.spyOn(console, 'log').mockImplementation(() => {});

function makeRecord(overrides = {}) {
  return {
    site_id: 'site-erm',
    record_id: 'rec-001',
    customer_number: 'CUST-001',
    customer_name: 'Test Customer',
    ...overrides,
  };
}

describe('validateImportBatch — required fields', () => {
  it('accepts a record with all four required fields filled', () => {
    const r = validateImportBatch([makeRecord()]);
    expect(r.valid).toBe(true);
    expect(r.validCount).toBe(1);
    expect(r.invalidCount).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it.each(['site_id', 'record_id', 'customer_number', 'customer_name'])(
    'rejects when required field "%s" is missing (undefined)',
    (field) => {
      const rec = makeRecord();
      delete rec[field];
      const r = validateImportBatch([rec]);
      expect(r.valid).toBe(false);
      expect(r.errors[0].issues.some(i => i.field === field)).toBe(true);
    },
  );

  it.each(['site_id', 'record_id', 'customer_number', 'customer_name'])(
    'rejects when required field "%s" is null',
    (field) => {
      const rec = makeRecord({ [field]: null });
      const r = validateImportBatch([rec]);
      expect(r.valid).toBe(false);
      expect(r.errors[0].issues.some(i => i.field === field)).toBe(true);
    },
  );

  it.each(['site_id', 'record_id', 'customer_number', 'customer_name'])(
    'rejects when required field "%s" is the empty string',
    (field) => {
      const rec = makeRecord({ [field]: '' });
      const r = validateImportBatch([rec]);
      expect(r.valid).toBe(false);
      expect(r.errors[0].issues.some(i => i.field === field)).toBe(true);
    },
  );

  it('reports ALL missing required fields on one record (not just the first)', () => {
    const rec = makeRecord();
    delete rec.customer_number;
    delete rec.customer_name;
    const r = validateImportBatch([rec]);
    expect(r.valid).toBe(false);
    const fields = r.errors[0].issues.map(i => i.field).sort();
    expect(fields).toEqual(['customer_name', 'customer_number']);
  });
});

describe('validateImportBatch — flag_color enum', () => {
  it.each(['none', 'red', 'orange', 'green'])('accepts flag_color "%s"', (color) => {
    const r = validateImportBatch([makeRecord({ flag_color: color })]);
    expect(r.valid).toBe(true);
  });

  it('accepts flag_color null (treated as "not set")', () => {
    const r = validateImportBatch([makeRecord({ flag_color: null })]);
    expect(r.valid).toBe(true);
  });

  it('accepts missing flag_color (field not present at all)', () => {
    const rec = makeRecord();
    delete rec.flag_color;
    const r = validateImportBatch([rec]);
    expect(r.valid).toBe(true);
  });

  it('rejects an unknown flag_color value', () => {
    const r = validateImportBatch([makeRecord({ flag_color: 'purple' })]);
    expect(r.valid).toBe(false);
    expect(r.errors[0].issues[0].field).toBe('flag_color');
    expect(r.errors[0].issues[0].message).toMatch(/invalid flag_color/);
  });

  it('the error message lists the allowed enum values for the operator', () => {
    const r = validateImportBatch([makeRecord({ flag_color: 'purple' })]);
    const msg = r.errors[0].issues[0].message;
    for (const allowed of ['none', 'red', 'orange', 'green']) {
      expect(msg).toContain(allowed);
    }
  });
});

describe('validateImportBatch — outstanding_balance', () => {
  it('accepts a numeric string', () => {
    const r = validateImportBatch([makeRecord({ outstanding_balance: '1500.00' })]);
    expect(r.valid).toBe(true);
  });

  it('accepts a number primitive', () => {
    const r = validateImportBatch([makeRecord({ outstanding_balance: 1500.5 })]);
    expect(r.valid).toBe(true);
  });

  it('accepts null and empty string (skips the check)', () => {
    const r = validateImportBatch([
      makeRecord({ record_id: 'r1', outstanding_balance: null }),
      makeRecord({ record_id: 'r2', outstanding_balance: '' }),
    ]);
    expect(r.valid).toBe(true);
    expect(r.validCount).toBe(2);
  });

  it('rejects a non-numeric string with a helpful field-level error', () => {
    const r = validateImportBatch([makeRecord({ outstanding_balance: 'not-a-number' })]);
    expect(r.valid).toBe(false);
    expect(r.errors[0].issues[0].field).toBe('outstanding_balance');
    expect(r.errors[0].issues[0].message).toMatch(/non-numeric/);
  });

  it('flags an outlier > MAX_BALANCE as a WARNING but still passes the record', () => {
    const r = validateImportBatch([makeRecord({ outstanding_balance: '1e10' })]);
    expect(r.valid).toBe(true);            // not an error — record is still imported
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].field).toBe('outstanding_balance');
    expect(r.warnings[0].record_id).toBe('rec-001');
  });

  it('flags a large negative outlier as a warning too (absolute value)', () => {
    const r = validateImportBatch([makeRecord({ outstanding_balance: '-2000000000' })]);
    expect(r.valid).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('validateImportBatch — JSON-array fields', () => {
  it.each(['unpaid_invoices', 'receipts'])(
    'accepts a JSON-string array for %s',
    (field) => {
      const r = validateImportBatch([makeRecord({ [field]: '[{"id":1}]' })]);
      expect(r.valid).toBe(true);
    },
  );

  it.each(['unpaid_invoices', 'receipts'])(
    'accepts a native array for %s',
    (field) => {
      const r = validateImportBatch([makeRecord({ [field]: [{ id: 1 }] })]);
      expect(r.valid).toBe(true);
    },
  );

  it.each(['unpaid_invoices', 'receipts'])(
    'rejects a JSON-string object (not an array) for %s',
    (field) => {
      const r = validateImportBatch([makeRecord({ [field]: '{"id":1}' })]);
      expect(r.valid).toBe(false);
      expect(r.errors[0].issues[0].field).toBe(field);
      expect(r.errors[0].issues[0].message).toMatch(/must be a JSON array/);
    },
  );

  it.each(['unpaid_invoices', 'receipts'])(
    'rejects malformed JSON for %s',
    (field) => {
      const r = validateImportBatch([makeRecord({ [field]: '[broken' })]);
      expect(r.valid).toBe(false);
      expect(r.errors[0].issues[0].field).toBe(field);
      expect(r.errors[0].issues[0].message).toMatch(/must be valid JSON/);
    },
  );

  it('reports both JSON-field errors on a single record when both are bad', () => {
    const r = validateImportBatch([makeRecord({
      unpaid_invoices: '[broken',
      receipts: '{"object":"not-array"}',
    })]);
    const fields = r.errors[0].issues.map(i => i.field).sort();
    expect(fields).toEqual(['receipts', 'unpaid_invoices']);
  });
});

describe('validateImportBatch — batch / summary shape', () => {
  it('returns valid=false when ANY record in the batch is invalid', () => {
    const r = validateImportBatch([
      makeRecord({ record_id: 'good' }),
      makeRecord({ record_id: 'bad', customer_name: '' }),
      makeRecord({ record_id: 'also-good' }),
    ]);
    expect(r.valid).toBe(false);
    expect(r.validCount).toBe(2);
    expect(r.invalidCount).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].record_id).toBe('bad');
  });

  it('handles an empty batch', () => {
    const r = validateImportBatch([]);
    expect(r.valid).toBe(true);    // no invalid records ⇒ valid
    expect(r.validCount).toBe(0);
    expect(r.invalidCount).toBe(0);
    expect(r.summary.total).toBe(0);
  });

  it('truncates the summary.errors to the first 50 but keeps the full errors[] array', () => {
    const batch = [];
    for (let i = 0; i < 75; i++) {
      batch.push(makeRecord({ record_id: `rec-${i}`, customer_name: '' }));
    }
    const r = validateImportBatch(batch);
    expect(r.invalidCount).toBe(75);
    expect(r.errors).toHaveLength(75);             // full set on r.errors
    expect(r.summary.errors).toHaveLength(50);     // capped on summary.errors
    expect(r.summary.errorsTruncated).toBe(true);
  });

  it('marks errorsTruncated=false when under the cap', () => {
    const r = validateImportBatch([makeRecord({ customer_name: '' })]);
    expect(r.summary.errorsTruncated).toBe(false);
  });
});
