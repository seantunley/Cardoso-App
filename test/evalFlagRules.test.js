// Tests for src/lib/evalFlagRules.js
//
// evalFlagRules is the auto-flag rule evaluator. checkAutoFlagRules is
// called for every customer record on every sync — if a rule matches,
// the customer's flag colour (red/orange/green) and reason are set
// automatically, overriding the previous auto-flag (manual flags are
// untouched elsewhere). Bugs here have a wide blast radius: a customer
// silently going red, a rule that should match not matching, an
// operator change in Settings that doesn't take effect.
//
// The two pure functions to lock down:
//   evaluateCondition(condition, record)  — one condition vs one record
//   checkAutoFlagRules(record, rules)     — top-level entry; iterates
//     rules in order, returns the first match
//
// (`evaluateRuleConditions` is the internal AND/OR connector; tested
// implicitly via checkAutoFlagRules.)

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { evaluateCondition, checkAutoFlagRules } from '../src/lib/evalFlagRules.js';

// Some date-comparison conditions reference "now". Freeze the clock
// so the date tests are deterministic regardless of when the suite runs.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('evaluateCondition — text comparisons', () => {
  const record = { customer_name: 'Cardoso Witkoppen' };

  it('contains matches a substring (case-insensitive)', () => {
    expect(evaluateCondition({ field: 'customer_name', condition_type: 'contains', condition_value: 'WITKOPP' }, record)).toBe(true);
  });
  it('contains rejects a substring that does not appear', () => {
    expect(evaluateCondition({ field: 'customer_name', condition_type: 'contains', condition_value: 'sandton' }, record)).toBe(false);
  });
  it('equals matches case-insensitively', () => {
    expect(evaluateCondition({ field: 'customer_name', condition_type: 'equals', condition_value: 'cardoso witkoppen' }, record)).toBe(true);
  });
  it('starts_with matches a prefix', () => {
    expect(evaluateCondition({ field: 'customer_name', condition_type: 'starts_with', condition_value: 'CARDOSO' }, record)).toBe(true);
  });
  it('ends_with matches a suffix', () => {
    expect(evaluateCondition({ field: 'customer_name', condition_type: 'ends_with', condition_value: 'koppen' }, record)).toBe(true);
  });
  it('text comparisons treat null record value as empty string (no match against non-empty target)', () => {
    expect(evaluateCondition({ field: 'customer_name', condition_type: 'contains', condition_value: 'cardoso' }, { customer_name: null })).toBe(false);
  });
});

describe('evaluateCondition — is_empty / is_not_empty', () => {
  it('is_empty is true for null', () => {
    expect(evaluateCondition({ field: 'flag_reason', condition_type: 'is_empty' }, { flag_reason: null })).toBe(true);
  });
  it('is_empty is true for undefined', () => {
    expect(evaluateCondition({ field: 'flag_reason', condition_type: 'is_empty' }, {})).toBe(true);
  });
  it('is_empty is true for whitespace-only strings', () => {
    expect(evaluateCondition({ field: 'flag_reason', condition_type: 'is_empty' }, { flag_reason: '   ' })).toBe(true);
  });
  it('is_empty is false for a non-empty string', () => {
    expect(evaluateCondition({ field: 'flag_reason', condition_type: 'is_empty' }, { flag_reason: 'manual' })).toBe(false);
  });
  it('is_not_empty inverts the above', () => {
    expect(evaluateCondition({ field: 'flag_reason', condition_type: 'is_not_empty' }, { flag_reason: 'manual' })).toBe(true);
    expect(evaluateCondition({ field: 'flag_reason', condition_type: 'is_not_empty' }, { flag_reason: null })).toBe(false);
    expect(evaluateCondition({ field: 'flag_reason', condition_type: 'is_not_empty' }, { flag_reason: '   ' })).toBe(false);
  });
});

describe('evaluateCondition — numeric comparisons', () => {
  const cond = (type, value, valueSecondary) =>
    ({ field: 'outstanding_balance', condition_type: type, condition_value: value, condition_value_secondary: valueSecondary });

  it('greater_than / less_than / >= / <= work with numeric strings', () => {
    const r = { outstanding_balance: '1500' };
    expect(evaluateCondition(cond('greater_than', 1000), r)).toBe(true);
    expect(evaluateCondition(cond('greater_than', 1500), r)).toBe(false);
    expect(evaluateCondition(cond('less_than', 2000), r)).toBe(true);
    expect(evaluateCondition(cond('greater_or_equal', 1500), r)).toBe(true);
    expect(evaluateCondition(cond('less_or_equal', 1500), r)).toBe(true);
  });

  it('strips South-African thousand separators (spaces + commas) before parsing', () => {
    expect(evaluateCondition(cond('greater_than', 1000), { outstanding_balance: '1 500,00' })).toBe(true);
    expect(evaluateCondition(cond('greater_than', 1000), { outstanding_balance: '1,500' })).toBe(true);
  });

  it('range_between is inclusive on both ends', () => {
    expect(evaluateCondition(cond('range_between', 1000, 2000), { outstanding_balance: '1500' })).toBe(true);
    expect(evaluateCondition(cond('range_between', 1000, 2000), { outstanding_balance: '1000' })).toBe(true);
    expect(evaluateCondition(cond('range_between', 1000, 2000), { outstanding_balance: '2000' })).toBe(true);
    expect(evaluateCondition(cond('range_between', 1000, 2000), { outstanding_balance: '999.99' })).toBe(false);
    expect(evaluateCondition(cond('range_between', 1000, 2000), { outstanding_balance: '2000.01' })).toBe(false);
  });

  it('non-numeric record values short-circuit to false (NOT throw, NOT NaN-match)', () => {
    expect(evaluateCondition(cond('greater_than', 1000), { outstanding_balance: 'not-a-number' })).toBe(false);
    expect(evaluateCondition(cond('greater_than', 1000), { outstanding_balance: null })).toBe(false);
    expect(evaluateCondition(cond('greater_than', 1000), {})).toBe(false);
  });
});

describe('evaluateCondition — date comparisons (clock frozen 2026-06-15)', () => {
  it('date_older_than counts days from a YYYY-MM-DD string', () => {
    // 30 days before 2026-06-15 is 2026-05-16; older-than-29 should be true,
    // older-than-31 false.
    const r = { last_unpaid_invoice_date: '2026-05-16' };
    expect(evaluateCondition({ field: 'last_unpaid_invoice_date', condition_type: 'date_older_than', condition_value: 29 }, r)).toBe(true);
    expect(evaluateCondition({ field: 'last_unpaid_invoice_date', condition_type: 'date_older_than', condition_value: 31 }, r)).toBe(false);
  });

  it('date_older_than understands the YYYYMMDD compact form too', () => {
    const r = { last_unpaid_invoice_date: '20260516' };
    expect(evaluateCondition({ field: 'last_unpaid_invoice_date', condition_type: 'date_older_than', condition_value: 29 }, r)).toBe(true);
  });

  it('date_newer_than is the strict inverse', () => {
    const r = { last_receipt_date: '2026-06-10' };
    expect(evaluateCondition({ field: 'last_receipt_date', condition_type: 'date_newer_than', condition_value: 30 }, r)).toBe(true);
    expect(evaluateCondition({ field: 'last_receipt_date', condition_type: 'date_newer_than', condition_value: 1 }, r)).toBe(false);
  });

  it('before_date / after_date compare against an absolute date', () => {
    const r = { last_receipt_date: '2026-05-01' };
    expect(evaluateCondition({ field: 'last_receipt_date', condition_type: 'before_date', condition_value: '2026-06-01' }, r)).toBe(true);
    expect(evaluateCondition({ field: 'last_receipt_date', condition_type: 'after_date', condition_value: '2026-06-01' }, r)).toBe(false);
  });

  it('missing / unparseable dates short-circuit to false (no crash)', () => {
    expect(evaluateCondition({ field: 'd', condition_type: 'date_older_than', condition_value: 30 }, { d: null })).toBe(false);
    expect(evaluateCondition({ field: 'd', condition_type: 'date_older_than', condition_value: 30 }, { d: 'not-a-date' })).toBe(false);
    expect(evaluateCondition({ field: 'd', condition_type: 'date_older_than', condition_value: 30 }, {})).toBe(false);
  });
});

describe('evaluateCondition — unknown condition_type', () => {
  it('falls through to false for an unrecognised type', () => {
    expect(evaluateCondition({ field: 'x', condition_type: 'mind_reads_operator', condition_value: 1 }, { x: 1 })).toBe(false);
  });
});

describe('checkAutoFlagRules — single condition rules', () => {
  it('returns the matching rule shape on a single-condition hit', () => {
    const record = { customer_name: 'Cardoso Witkoppen' };
    const rules = [{
      rule_name: 'witkoppen-trial',
      flag_color: 'orange',
      conditions: [{ field: 'customer_name', condition_type: 'contains', condition_value: 'witkoppen' }],
    }];
    expect(checkAutoFlagRules(record, rules)).toEqual({
      flag_color: 'orange',
      flag_reason: 'Auto-flagged: witkoppen-trial',
      auto_flagged: true,
    });
  });

  it('returns null when no rule matches', () => {
    expect(checkAutoFlagRules(
      { customer_name: 'Some Other Store' },
      [{ rule_name: 'r', flag_color: 'red', conditions: [{ field: 'customer_name', condition_type: 'contains', condition_value: 'witkoppen' }] }],
    )).toBe(null);
  });

  it('returns the FIRST matching rule (order in the array is the priority)', () => {
    const record = { outstanding_balance: '5000' };
    const rules = [
      { rule_name: 'first-match', flag_color: 'orange', conditions: [{ field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 1000 }] },
      { rule_name: 'second-match', flag_color: 'red',    conditions: [{ field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 4000 }] },
    ];
    expect(checkAutoFlagRules(record, rules).flag_color).toBe('orange');
  });
});

describe('checkAutoFlagRules — AND / OR connector logic (evaluated left-to-right)', () => {
  const record = { outstanding_balance: '1500', last_receipt_date: '2026-05-01' };

  it('two conditions both true with AND → matches', () => {
    const rules = [{ rule_name: 'r', flag_color: 'red', conditions: [
      { field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 1000 },
      { field: 'last_receipt_date',   condition_type: 'before_date',  condition_value: '2026-06-01', operator: 'AND' },
    ]}];
    expect(checkAutoFlagRules(record, rules)?.flag_color).toBe('red');
  });

  it('AND fails when the second condition is false', () => {
    const rules = [{ rule_name: 'r', flag_color: 'red', conditions: [
      { field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 1000 },
      { field: 'customer_name',       condition_type: 'contains',     condition_value: 'no-such-thing', operator: 'AND' },
    ]}];
    expect(checkAutoFlagRules(record, rules)).toBe(null);
  });

  it('OR matches when only the second condition is true', () => {
    const rules = [{ rule_name: 'r', flag_color: 'red', conditions: [
      { field: 'customer_name',       condition_type: 'contains',     condition_value: 'no-such-thing' },
      { field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 1000, operator: 'OR' },
    ]}];
    expect(checkAutoFlagRules(record, rules)?.flag_color).toBe('red');
  });

  it('A AND B OR C evaluates left-to-right as (A AND B) OR C', () => {
    // A true, B false → (A && B) = false; then OR C (true) → true overall
    const rules = [{ rule_name: 'r', flag_color: 'red', conditions: [
      { field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 1000 },                            // A: true
      { field: 'customer_name',       condition_type: 'contains',     condition_value: 'nope', operator: 'AND' },         // B: false
      { field: 'last_receipt_date',   condition_type: 'before_date',  condition_value: '2026-06-01', operator: 'OR' },    // C: true
    ]}];
    expect(checkAutoFlagRules(record, rules)?.flag_color).toBe('red');
  });

  it('A AND B AND C OR D evaluates left-to-right as ((A AND B) AND C) OR D', () => {
    // A true, B true, C false → false; OR D true → true
    const rules = [{ rule_name: 'r', flag_color: 'red', conditions: [
      { field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 1000 },                            // A: true
      { field: 'outstanding_balance', condition_type: 'less_than',    condition_value: 2000, operator: 'AND' },           // B: true
      { field: 'customer_name',       condition_type: 'contains',     condition_value: 'nope', operator: 'AND' },         // C: false
      { field: 'last_receipt_date',   condition_type: 'before_date',  condition_value: '2026-06-01', operator: 'OR' },    // D: true
    ]}];
    expect(checkAutoFlagRules(record, rules)?.flag_color).toBe('red');
  });

  it('operator defaults to AND when omitted (backward-compat)', () => {
    const rules = [{ rule_name: 'r', flag_color: 'red', conditions: [
      { field: 'outstanding_balance', condition_type: 'greater_than', condition_value: 1000 },
      { field: 'outstanding_balance', condition_type: 'less_than',    condition_value: 2000 },   // no operator → AND
    ]}];
    expect(checkAutoFlagRules(record, rules)?.flag_color).toBe('red');
  });
});

describe('checkAutoFlagRules — string-conditions field shape (legacy DB format)', () => {
  it('parses a JSON-string conditions field', () => {
    const rules = [{
      rule_name: 'json-string',
      flag_color: 'orange',
      conditions: JSON.stringify([{ field: 'customer_name', condition_type: 'contains', condition_value: 'witkoppen' }]),
    }];
    expect(checkAutoFlagRules({ customer_name: 'Cardoso Witkoppen' }, rules)?.flag_color).toBe('orange');
  });

  it('skips a rule whose JSON-string conditions field is malformed', () => {
    const rules = [{
      rule_name: 'broken-json',
      flag_color: 'red',
      conditions: '[not-valid-json',
    }];
    expect(checkAutoFlagRules({ customer_name: 'x' }, rules)).toBe(null);
  });

  it('skips a rule whose conditions parses to a non-array', () => {
    const rules = [{
      rule_name: 'object-not-array',
      flag_color: 'red',
      conditions: '{"field":"x"}',
    }];
    expect(checkAutoFlagRules({ customer_name: 'x' }, rules)).toBe(null);
  });
});

describe('checkAutoFlagRules — edge cases', () => {
  it('returns null when rules is empty', () => {
    expect(checkAutoFlagRules({ x: 1 }, [])).toBe(null);
  });

  it('skips a rule with an empty conditions array (no implicit match)', () => {
    const rules = [{ rule_name: 'empty', flag_color: 'red', conditions: [] }];
    expect(checkAutoFlagRules({ x: 1 }, rules)).toBe(null);
  });

  it('skips a rule with missing conditions (undefined)', () => {
    const rules = [{ rule_name: 'no-conditions', flag_color: 'red' }];
    expect(checkAutoFlagRules({ x: 1 }, rules)).toBe(null);
  });

  it('operator value is case-insensitive ("or", "and", "Or", "AnD" all work)', () => {
    const record = { x: 5 };
    // 5 > 10? no. OR 5 < 10? yes. → match
    const rules = [{ rule_name: 'r', flag_color: 'red', conditions: [
      { field: 'x', condition_type: 'greater_than', condition_value: 10 },
      { field: 'x', condition_type: 'less_than',    condition_value: 10, operator: 'or' },
    ]}];
    expect(checkAutoFlagRules(record, rules)?.flag_color).toBe('red');
  });
});
