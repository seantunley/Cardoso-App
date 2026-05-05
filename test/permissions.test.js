// Tests for src/lib/permissions.js — both `hasPermission` and the new
// `explainPermission` diagnostic. The critical contract is: for every
// (user, key) input, explainPermission().allowed === hasPermission().
// If they ever drift, the diagnostic lies — that's worse than no
// diagnostic. Properties below check the matrix.

import { describe, it, expect } from 'vitest';
import { hasPermission, explainPermission } from '../src/lib/permissions.js';

const adminAllOn = { role: 'admin', can_access_records: 1, can_access_reconciliation: 1 };
const adminBatOff = { role: 'admin', can_access_reconciliation: 0 };
const adminUnsetField = { role: 'admin' };
const userBatOnly = { role: 'user', can_access_reconciliation: 1, can_access_records: 0 };
const userNothing = { role: 'user' };

describe('hasPermission ↔ explainPermission contract', () => {
  // The matrix that matters for this app. If we add a new permission key
  // or role, this list grows; the contract assertion stays the same.
  const cases = [
    [null, 'can_access_records'],
    [undefined, 'can_access_records'],
    [adminAllOn, 'can_access_records'],
    [adminAllOn, 'can_access_reconciliation'],
    [adminAllOn, ''],
    [adminAllOn, null],
    [adminBatOff, 'can_access_reconciliation'],
    [adminBatOff, 'can_access_records'],
    [adminUnsetField, 'can_access_records'],
    [userBatOnly, 'can_access_reconciliation'],
    [userBatOnly, 'can_access_records'],
    [userNothing, 'can_access_reconciliation'],
    [userNothing, 'can_access_records'],
    [userNothing, ''],
    [userBatOnly, undefined],
  ];

  it.each(cases)('matches for user=%j key=%j', (user, key) => {
    const explained = explainPermission(user, key);
    expect(explained.allowed).toBe(hasPermission(user, key));
  });
});

describe('explainPermission — source labels', () => {
  it('no_user when user is missing', () => {
    expect(explainPermission(null, 'can_access_records')).toMatchObject({
      allowed: false,
      source: 'no_user',
    });
  });

  it('no_key when permission key is missing', () => {
    expect(explainPermission(adminAllOn, '')).toMatchObject({
      allowed: false,
      source: 'no_key',
    });
    expect(explainPermission(adminAllOn, null)).toMatchObject({
      allowed: false,
      source: 'no_key',
    });
  });

  it('admin_default when admin has no explicit value (column unset)', () => {
    expect(explainPermission(adminUnsetField, 'can_access_records')).toMatchObject({
      allowed: true,
      source: 'admin_default',
    });
  });

  it('admin_default when admin has value 1', () => {
    expect(explainPermission(adminAllOn, 'can_access_records')).toMatchObject({
      allowed: true,
      source: 'admin_default',
    });
  });

  it('admin_explicit_off when admin has value 0', () => {
    const e = explainPermission(adminBatOff, 'can_access_reconciliation');
    expect(e.allowed).toBe(false);
    expect(e.source).toBe('admin_explicit_off');
    expect(e.reason).toMatch(/explicitly turned off/i);
  });

  it('user_grant when non-admin has value 1', () => {
    expect(explainPermission(userBatOnly, 'can_access_reconciliation')).toMatchObject({
      allowed: true,
      source: 'user_grant',
    });
  });

  it('user_deny when non-admin has value 0', () => {
    const e = explainPermission(userBatOnly, 'can_access_records');
    expect(e.allowed).toBe(false);
    expect(e.source).toBe('user_deny');
    // Reason should mention what value the user actually has.
    expect(e.reason).toMatch(/0/);
  });

  it('user_deny when non-admin has the column unset (undefined)', () => {
    const e = explainPermission(userNothing, 'can_access_records');
    expect(e.allowed).toBe(false);
    expect(e.source).toBe('user_deny');
    expect(e.reason).toMatch(/undefined/);
  });
});
