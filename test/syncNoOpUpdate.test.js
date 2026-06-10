// SYNC-2 — the per-record sync UPDATE must be skipped when nothing it controls
// changed, so unchanged rows don't get their updated_date bumped every tick
// (which made the hub re-download the whole record set on each incremental pull).

import { describe, it, expect, vi } from 'vitest';

// syncEngine imports the app DB + prepares statements at module load.
vi.mock('../src/db/index.js', () => ({ default: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })) } }));

import { isNoOpDataUpdate } from '../src/services/syncEngine.js';

const base = {
  created_by: 'import', customer_number: 'C1', customer_name: 'Acme',
  age_analysis: '', age_current: '', age_7_days: '', age_14_days: '', age_21_days: '',
  outstanding_balance: '100.50', source_id: 'C1', source_table: 'AR',
  data: '{"a":1}', local_fields: '{}', unpaid_invoices: '[]', receipts: '[]',
  terms: '30', sales_rep: 'R1', account_type: 'National', note: '',
  custom_field_1: null, custom_field_2: null, custom_field_3: null,
};

describe('isNoOpDataUpdate (SYNC-2)', () => {
  it('is true when every controlled column matches', () => {
    expect(isNoOpDataUpdate({ ...base }, { ...base })).toBe(true);
  });

  it('treats null / undefined / "" as equal', () => {
    expect(isNoOpDataUpdate(
      { ...base, note: null, custom_field_1: null },
      { ...base, note: '', custom_field_1: null },
    )).toBe(true);
  });

  it('only compares columns in `upd` — flags / synced_at on the row are ignored', () => {
    expect(isNoOpDataUpdate(
      { ...base, flag_color: 'red', synced_at: 'yesterday' }, // re-written/bumped, not compared
      { ...base },
    )).toBe(true);
  });

  it('detects a changed balance', () => {
    expect(isNoOpDataUpdate({ ...base }, { ...base, outstanding_balance: '200.00' })).toBe(false);
  });

  it('detects a changed data payload', () => {
    expect(isNoOpDataUpdate({ ...base }, { ...base, data: '{"a":2}' })).toBe(false);
  });

  it('detects a changed mapped column (sales_rep)', () => {
    expect(isNoOpDataUpdate({ ...base }, { ...base, sales_rep: 'R2' })).toBe(false);
  });

  it('detects a custom field going null → value', () => {
    expect(isNoOpDataUpdate({ ...base }, { ...base, custom_field_1: 'X' })).toBe(false);
  });
});
