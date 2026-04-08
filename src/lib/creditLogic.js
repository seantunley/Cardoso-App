import { z } from "zod";

export const CREDIT_LOGIC_SCHEMA_VERSION = 1;

const wordingSchema = z.object({
  verdicts: z.object({
    approve: z.object({ title: z.string().min(1), summary: z.string().min(1) }),
    caution: z.object({ title: z.string().min(1), summary: z.string().min(1) }),
    hold: z.object({ title: z.string().min(1), summary: z.string().min(1) }),
    dormant: z.object({ title: z.string().min(1), summary: z.string().min(1) }),
  }),
  scenarios: z.object({
    zeroBalanceTitle: z.string().min(1),
    zeroBalanceSummary: z.string().min(1),
    newCustomerTitle: z.string().min(1),
    newCustomerSummary: z.string().min(1),
    noHistoryWithBalanceTitle: z.string().min(1),
    noHistoryWithBalanceSummary: z.string().min(1),
    dormantFactor: z.string().min(1),
    dormantInactiveNote: z.string().min(1),
    longInactiveNote: z.string().min(1),
  }),
  manualOverrides: z.object({
    redTitle: z.string().min(1),
    redSummary: z.string().min(1),
    redFactor: z.string().min(1),
    orangeTitle: z.string().min(1),
    orangeSummary: z.string().min(1),
    orangeFactor: z.string().min(1),
  }),
  factors: z.object({
    zeroBalance: z.string().min(1),
    noHistoryWithBalance: z.string().min(1),
    unpaidBreach: z.string().min(1),
    approachingBreach: z.string().min(1),
    awaitingPayment: z.string().min(1),
    avgLagWithUnpaidBalance: z.string().min(1),
    avgLagWithinTerms: z.string().min(1),
    avgLagWithinBreach: z.string().min(1),
    avgLagVerySlow: z.string().min(1),
    matchedReceipts: z.string().min(1),
    exposureCap: z.string().min(1),
    historicalRedSingle: z.string().min(1),
    historicalRedRepeat: z.string().min(1),
    historicalOrangeSingle: z.string().min(1),
    historicalOrangeRepeat: z.string().min(1),
  }),
});

export const creditLogicConfigSchema = z.object({
  schemaVersion: z.literal(CREDIT_LOGIC_SCHEMA_VERSION),
  thresholds: z.object({
    paymentTermDays: z.number().int().min(1).max(365),
    breachDays: z.number().int().min(1).max(365),
    dormantThresholdDays: z.number().int().min(30).max(3650),
    dormantThresholdMonths: z.number().int().min(1).max(120),
    zeroBalanceCutoff: z.number().min(0).max(1000000),
    cautionScoreBelow: z.number().int().min(0).max(100),
    holdScoreBelow: z.number().int().min(0).max(100),
    approachingBreachDays: z.number().int().min(0).max(365),
    longInactiveYears: z.number().int().min(1).max(20),
  }),
  scoring: z.object({
    unpaidBreachDeduction: z.number().int().min(0).max(100),
    approachingBreachDeduction: z.number().int().min(0).max(100),
    awaitingPaymentDeduction: z.number().int().min(0).max(100),
    avgLagWithUnpaidBalanceDeduction: z.number().int().min(0).max(100),
    avgLagWithinBreachDeduction: z.number().int().min(0).max(100),
    avgLagVerySlowDeduction: z.number().int().min(0).max(100),
    historicalRedSingleDeduction: z.number().int().min(0).max(100),
    historicalRedRepeatDeduction: z.number().int().min(0).max(100),
    historicalOrangeSingleDeduction: z.number().int().min(0).max(100),
    historicalOrangeRepeatDeduction: z.number().int().min(0).max(100),
    noHistoryWithBalanceScore: z.number().int().min(0).max(100),
  }),
  outstandingBalanceCap: z.object({
    enabled: z.boolean(),
    multiplier: z.number().min(0).max(100),
    deduction: z.number().int().min(0).max(100),
  }),
  manualOverrides: z.object({
    redForcesHold: z.boolean(),
    orangeDowngradesApprove: z.boolean(),
  }),
  wording: wordingSchema,
});

export const DEFAULT_CREDIT_LOGIC_CONFIG = {
  schemaVersion: CREDIT_LOGIC_SCHEMA_VERSION,
  thresholds: {
    paymentTermDays: 14,
    breachDays: 21,
    dormantThresholdDays: 180,
    dormantThresholdMonths: 6,
    zeroBalanceCutoff: 1,
    cautionScoreBelow: 70,
    holdScoreBelow: 40,
    approachingBreachDays: 14,
    longInactiveYears: 2,
  },
  scoring: {
    unpaidBreachDeduction: 70,
    approachingBreachDeduction: 25,
    awaitingPaymentDeduction: 10,
    avgLagWithUnpaidBalanceDeduction: 35,
    avgLagWithinBreachDeduction: 20,
    avgLagVerySlowDeduction: 30,
    historicalRedSingleDeduction: 10,
    historicalRedRepeatDeduction: 20,
    historicalOrangeSingleDeduction: 5,
    historicalOrangeRepeatDeduction: 10,
    noHistoryWithBalanceScore: 50,
  },
  outstandingBalanceCap: {
    enabled: true,
    multiplier: 2,
    deduction: 15,
  },
  manualOverrides: {
    redForcesHold: true,
    orangeDowngradesApprove: true,
  },
  wording: {
    verdicts: {
      approve: {
        title: "Approve Invoice",
        summary: "Payment history is acceptable and there are no strong warning signs. Credit can be extended on normal terms.",
      },
      caution: {
        title: "Proceed with Caution",
        summary: "Payment behaviour shows elevated risk. Consider tighter terms or a smaller exposure until the account improves.",
      },
      hold: {
        title: "Hold — Do Not Invoice",
        summary: "There is an unpaid invoice {{oldestUnpaidAge}} days old. This exceeds the {{breachDays}}-day threshold and should be resolved before new credit is extended.",
      },
      dormant: {
        title: "Dormant Account — Reactivation",
        summary: "This customer has not bought in over {{dormantMonths}} months. Verify account details and intent before invoicing.",
      },
    },
    scenarios: {
      zeroBalanceTitle: "Approve Invoice",
      zeroBalanceSummary: "Balance is zero — account fully settled. Safe to issue a new invoice.",
      newCustomerTitle: "New Customer",
      newCustomerSummary: "No invoice or receipt history. Safe to issue a first invoice.",
      noHistoryWithBalanceTitle: "Proceed with Caution",
      noHistoryWithBalanceSummary: "Outstanding balance but no invoice/receipt history available to assess.",
      dormantFactor: "Latest invoice is over {{dormantMonths}} months after the previous one — customer was dormant.",
      dormantInactiveNote: "No transactions in over {{inactiveYears}} year{{inactiveYearsPlural}} — customer has been inactive for a long time.",
      longInactiveNote: " Customer has not transacted in over {{inactiveYears}} year{{inactiveYearsPlural}} — treat as a new account.",
    },
    manualOverrides: {
      redTitle: "Hold — Manually Flagged",
      redSummary: "This account was manually flagged red{{createdByClause}}. New credit should not be extended until the issue is reviewed.",
      redFactor: "Account is manually flagged red{{createdByClause}} — human review overrides the automated score.",
      orangeTitle: "Proceed with Caution — Manually Flagged",
      orangeSummary: "This account was manually flagged orange{{createdByClause}}. Proceed only with caution and verify the context first.",
      orangeFactor: "Account is manually flagged orange{{createdByClause}} — human review overrides a clean automated score.",
    },
    factors: {
      zeroBalance: "Outstanding balance is R0.00 — all accounts cleared.",
      noHistoryWithBalance: "Outstanding balance of R {{outstandingBalance}} with no supporting history.",
      unpaidBreach: "Unpaid invoice is {{oldestUnpaidAge}} days old — exceeds the {{breachDays}}-day limit. Resolve before issuing a new invoice.",
      approachingBreach: "Unpaid invoice is {{oldestUnpaidAge}} days old — approaching the {{breachDays}}-day limit.",
      awaitingPayment: "Latest invoice is {{oldestUnpaidAge}} day{{oldestUnpaidAgePlural}} old and awaiting payment.",
      avgLagWithUnpaidBalance: "Average payment lag {{avgLag}} day{{avgLagPlural}} on settled invoices, but there are unpaid invoices and an outstanding balance — unreliable payer.",
      avgLagWithinTerms: "Average payment lag {{avgLag}} day{{avgLagPlural}} — within {{paymentTermDays}}-day terms.",
      avgLagWithinBreach: "Average payment lag {{avgLag}} days — slow but within {{breachDays}} days (target: {{paymentTermDays}} days).",
      avgLagVerySlow: "Average payment lag {{avgLag}} days — very slow payer.",
      matchedReceipts: "{{paidPairs}} of {{pairCount}} invoice{{pairCountPlural}} matched with a receipt.",
      exposureCap: "Outstanding balance (R {{outstandingBalance}}) exceeds {{multiplier}}× the average invoice — high exposure.",
      historicalRedSingle: "Previously flagged red by staff.",
      historicalRedRepeat: "Repeatedly flagged red by staff.",
      historicalOrangeSingle: "Previously flagged orange by staff.",
      historicalOrangeRepeat: "Repeatedly flagged orange by staff.",
    },
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return deepClone(base);
  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base?.[key])) output[key] = deepMerge(base[key], value);
    else output[key] = value;
  }
  return output;
}

export function normaliseCreditLogicConfig(config) {
  const merged = deepMerge(DEFAULT_CREDIT_LOGIC_CONFIG, config || {});
  const parsed = creditLogicConfigSchema.parse(merged);
  return {
    ...parsed,
    thresholds: {
      ...parsed.thresholds,
      dormantThresholdMonths: Math.max(1, Math.round(parsed.thresholds.dormantThresholdDays / 30)),
    },
  };
}

export function validateCreditLogicConfig(config) {
  const result = creditLogicConfigSchema.safeParse(deepMerge(DEFAULT_CREDIT_LOGIC_CONFIG, config || {}));
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  return { ok: true, config: normaliseCreditLogicConfig(result.data) };
}
