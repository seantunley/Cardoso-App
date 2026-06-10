// SYNC-2 — the per-record sync UPDATE must be skipped when nothing it controls
// changed, so unchanged rows don't get their updated_date bumped every tick
// (which made the hub re-download the whole record set on each incremental pull).

import { describe, it, expect, vi } from 'vitest';

// syncEngine imports the app DB + prepares statements at module load.
vi.mock('../src/db/index.js', () => ({ default: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })) } }));

import { isNoOpDataUpdate, autoFlagWouldChange } from '../src/services/syncEngine.js';

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

  it('flags a difference when created_by is not loaded — so the lookup MUST select it', () => {
    // Regression for SYNC-2: upd.created_by is always 'import'. If the keyed
    // lookup omits created_by, existing.created_by is undefined, never matches,
    // and NOTHING is ever skipped — defeating the whole optimization.
    const existingMissingCreatedBy = { ...base };
    delete existingMissingCreatedBy.created_by;
    expect(isNoOpDataUpdate(existingMissingCreatedBy, { ...base })).toBe(false);
    // With it loaded as the stored 'import', the unchanged row is a no-op.
    expect(isNoOpDataUpdate({ ...base, created_by: 'import' }, { ...base })).toBe(true);
  });
});

describe('autoFlagWouldChange (SYNC-2 flag-only propagation)', () => {
  const unflagged = { flag_color: null, flag_reason: null, auto_flagged: 0 };
  const flagged = { flag_color: 'red', flag_reason: 'overdue', auto_flagged: 1 };

  it('is true when a rule newly flags an unflagged row', () => {
    expect(autoFlagWouldChange(unflagged, { flag_color: 'red', flag_reason: 'overdue' })).toBe(true);
  });

  it('is false when the rule re-applies the identical flag', () => {
    expect(autoFlagWouldChange(flagged, { flag_color: 'red', flag_reason: 'overdue' })).toBe(false);
  });

  it('is true when the rule changes colour or reason', () => {
    expect(autoFlagWouldChange(flagged, { flag_color: 'amber', flag_reason: 'overdue' })).toBe(true);
    expect(autoFlagWouldChange(flagged, { flag_color: 'red', flag_reason: 'disputed' })).toBe(true);
  });

  it('is true when the same colour/reason but the row was not auto_flagged', () => {
    const manual = { flag_color: 'red', flag_reason: 'overdue', auto_flagged: 0 };
    expect(autoFlagWouldChange(manual, { flag_color: 'red', flag_reason: 'overdue' })).toBe(true);
  });

  it('clearing: true iff the row was auto_flagged', () => {
    expect(autoFlagWouldChange(flagged, null)).toBe(true);
    expect(autoFlagWouldChange(unflagged, null)).toBe(false);
  });
});
