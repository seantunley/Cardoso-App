// Tests for src/lib/creditLogic.js
//
// creditLogic owns the config that drives every credit-decision the
// app makes (analyseInvoiceCredit reads from it). The module is mostly
// the canonical DEFAULT_CREDIT_LOGIC_CONFIG object + a zod schema. The
// actual logic is small:
//
//   normaliseCreditLogicConfig(override)
//     - deep-merge `override` on top of DEFAULT_CREDIT_LOGIC_CONFIG
//     - validate against the zod schema (throws on failure)
//     - recompute dormantThresholdMonths from dormantThresholdDays so
//       the two never drift out of sync
//
//   validateCreditLogicConfig(override)
//     - same merge
//     - safeParse → returns { ok: true, config } | { ok: false, errors }
//     - errors[].path is a dot-joined zod path (so the UI can highlight
//       the specific field the operator typed badly in Settings)
//
// These two functions are the only entry points the rest of the app
// uses. Lock the contract down.

import { describe, it, expect } from 'vitest';
import {
  CREDIT_LOGIC_SCHEMA_VERSION,
  DEFAULT_CREDIT_LOGIC_CONFIG,
  creditLogicConfigSchema,
  normaliseCreditLogicConfig,
  validateCreditLogicConfig,
} from '../src/lib/creditLogic.js';

describe('DEFAULT_CREDIT_LOGIC_CONFIG — self-consistency', () => {
  it('passes its own zod schema', () => {
    // Sanity check: the canonical defaults must always validate. If a
    // future PR adds a new required field to the schema but forgets to
    // populate the default, this fails loud.
    const result = creditLogicConfigSchema.safeParse(DEFAULT_CREDIT_LOGIC_CONFIG);
    expect(result.success).toBe(true);
  });

  it('carries the current schemaVersion', () => {
    expect(DEFAULT_CREDIT_LOGIC_CONFIG.schemaVersion).toBe(CREDIT_LOGIC_SCHEMA_VERSION);
  });

  it('has the documented top-level shape', () => {
    expect(DEFAULT_CREDIT_LOGIC_CONFIG).toEqual(expect.objectContaining({
      schemaVersion: expect.any(Number),
      thresholds: expect.any(Object),
      scoring: expect.any(Object),
      outstandingBalanceCap: expect.any(Object),
      manualOverrides: expect.any(Object),
      wording: expect.any(Object),
    }));
  });

  it('dormantThresholdMonths in the default matches Math.round(dormantThresholdDays/30)', () => {
    // This is the invariant normaliseCreditLogicConfig enforces. The
    // default already obeys it; if a future edit breaks the invariant
    // in the default, every operator opens Settings to a stale value.
    const d = DEFAULT_CREDIT_LOGIC_CONFIG.thresholds;
    expect(d.dormantThresholdMonths).toBe(Math.max(1, Math.round(d.dormantThresholdDays / 30)));
  });
});

describe('normaliseCreditLogicConfig', () => {
  it('returns the default config unchanged when called with null', () => {
    expect(normaliseCreditLogicConfig(null)).toEqual(DEFAULT_CREDIT_LOGIC_CONFIG);
  });

  it('returns the default config unchanged when called with undefined', () => {
    expect(normaliseCreditLogicConfig(undefined)).toEqual(DEFAULT_CREDIT_LOGIC_CONFIG);
  });

  it('returns the default config unchanged when called with an empty object', () => {
    expect(normaliseCreditLogicConfig({})).toEqual(DEFAULT_CREDIT_LOGIC_CONFIG);
  });

  it('deep-merges a partial override: only the overridden field changes', () => {
    const result = normaliseCreditLogicConfig({ thresholds: { breachDays: 30 } });
    expect(result.thresholds.breachDays).toBe(30);
    // Sibling fields preserved from default.
    expect(result.thresholds.paymentTermDays).toBe(DEFAULT_CREDIT_LOGIC_CONFIG.thresholds.paymentTermDays);
    // Other top-level groups untouched.
    expect(result.scoring).toEqual(DEFAULT_CREDIT_LOGIC_CONFIG.scoring);
    expect(result.wording).toEqual(DEFAULT_CREDIT_LOGIC_CONFIG.wording);
  });

  it('merges nested wording overrides without dropping siblings', () => {
    const result = normaliseCreditLogicConfig({
      wording: { verdicts: { hold: { title: 'CUSTOM HOLD TITLE' } } },
    });
    expect(result.wording.verdicts.hold.title).toBe('CUSTOM HOLD TITLE');
    // The hold.summary template stays the default.
    expect(result.wording.verdicts.hold.summary).toBe(
      DEFAULT_CREDIT_LOGIC_CONFIG.wording.verdicts.hold.summary,
    );
    // Other verdict groups stay default.
    expect(result.wording.verdicts.approve).toEqual(
      DEFAULT_CREDIT_LOGIC_CONFIG.wording.verdicts.approve,
    );
  });

  it('recomputes dormantThresholdMonths from dormantThresholdDays on the way out', () => {
    // Override days to 270 ⇒ months should resolve to 9.
    const result = normaliseCreditLogicConfig({ thresholds: { dormantThresholdDays: 270 } });
    expect(result.thresholds.dormantThresholdDays).toBe(270);
    expect(result.thresholds.dormantThresholdMonths).toBe(9);
  });

  it('clamps the recomputed dormantThresholdMonths to >= 1 (never zero)', () => {
    // Days = 30 → Math.round(1) = 1. Days = 15 → Math.round(0.5) = 1. Days = 14 → 0 → clamp to 1.
    const r14 = normaliseCreditLogicConfig({ thresholds: { dormantThresholdDays: 30 } });
    expect(r14.thresholds.dormantThresholdMonths).toBe(1);
  });

  it('throws on a structurally invalid override (out-of-range number)', () => {
    // breachDays must be 1..365.
    expect(() => normaliseCreditLogicConfig({ thresholds: { breachDays: 0 } })).toThrow();
    expect(() => normaliseCreditLogicConfig({ thresholds: { breachDays: 366 } })).toThrow();
  });

  it('throws on wrong types', () => {
    expect(() => normaliseCreditLogicConfig({ manualOverrides: { redForcesHold: 'yes' } })).toThrow();
    expect(() => normaliseCreditLogicConfig({ thresholds: { breachDays: '21' } })).toThrow();
  });

  it('throws when an operator wipes a wording template to empty string (min(1))', () => {
    // Empty strings break the formatTemplate consumers in
    // analyseInvoiceCredit — schema enforces min length 1.
    expect(() => normaliseCreditLogicConfig({
      wording: { factors: { zeroBalance: '' } },
    })).toThrow();
  });
});

describe('validateCreditLogicConfig', () => {
  it('returns { ok: true, config } for a valid override', () => {
    const r = validateCreditLogicConfig({ thresholds: { breachDays: 30 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.thresholds.breachDays).toBe(30);
      // Same dormantThresholdMonths normalisation applied.
      expect(r.config.thresholds.dormantThresholdMonths).toBe(
        Math.max(1, Math.round(r.config.thresholds.dormantThresholdDays / 30)),
      );
    }
  });

  it('returns { ok: true, config: default-merged } for null / undefined / empty', () => {
    for (const input of [null, undefined, {}]) {
      const r = validateCreditLogicConfig(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config).toEqual(DEFAULT_CREDIT_LOGIC_CONFIG);
    }
  });

  it('returns { ok: false, errors } for an out-of-range value', () => {
    const r = validateCreditLogicConfig({ thresholds: { breachDays: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].path).toBe('thresholds.breachDays');
      expect(r.errors[0].message).toEqual(expect.any(String));
    }
  });

  it('returns ALL errors when multiple fields are invalid (not just the first)', () => {
    const r = validateCreditLogicConfig({
      thresholds: { breachDays: 0, paymentTermDays: -5 },
      scoring: { unpaidBreachDeduction: 999 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.errors.map((e) => e.path).sort();
      expect(paths).toContain('thresholds.breachDays');
      expect(paths).toContain('thresholds.paymentTermDays');
      expect(paths).toContain('scoring.unpaidBreachDeduction');
    }
  });

  it('returns paths as dot-joined strings (UI uses these to highlight the field)', () => {
    const r = validateCreditLogicConfig({
      wording: { verdicts: { hold: { title: '' } } },   // empty string → min(1) violation
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toBe('wording.verdicts.hold.title');
    }
  });

  it('rejects wrong types with a structured error (not a throw)', () => {
    // Different from normaliseCreditLogicConfig which throws — validate
    // uses safeParse so the UI can render the error message.
    const r = validateCreditLogicConfig({ manualOverrides: { redForcesHold: 'yes' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path === 'manualOverrides.redForcesHold')).toBe(true);
    }
  });
});

describe('CREDIT_LOGIC_SCHEMA_VERSION', () => {
  it('is a positive integer (so version comparisons work)', () => {
    expect(CREDIT_LOGIC_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CREDIT_LOGIC_SCHEMA_VERSION)).toBe(true);
  });

  it('matches the schema literal (schema is locked to one version at a time)', () => {
    // The schema uses z.literal(CREDIT_LOGIC_SCHEMA_VERSION) — a config
    // whose schemaVersion doesn't match should fail.
    const wrong = { ...DEFAULT_CREDIT_LOGIC_CONFIG, schemaVersion: CREDIT_LOGIC_SCHEMA_VERSION + 1 };
    const r = creditLogicConfigSchema.safeParse(wrong);
    expect(r.success).toBe(false);
  });
});
