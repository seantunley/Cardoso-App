import { DEFAULT_CREDIT_LOGIC_CONFIG, normaliseCreditLogicConfig } from "./creditLogic.js";

function parseAmount(value) {
  if (!value || String(value).trim() === "") return 0;
  const numeric = parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(numeric) ? 0 : numeric;
}

function parseDateField(value) {
  if (!value) return null;
  const input = String(value).trim();
  if (/^\d{8}$/.test(input)) return new Date(`${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}`);
  const dmy = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return new Date(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`);
  const mdy = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return new Date(`${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`);
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTemplate(template, variables = {}) {
  return String(template || "").replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const value = variables[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function pluralSuffix(value) {
  return Number(value) === 1 ? "" : "s";
}

function buildCreatedByClause(createdBy) {
  return createdBy ? ` by ${createdBy}` : "";
}

function extractSlots(record, prefix) {
  const jsonField = prefix === "last_unpaid_invoice" ? "unpaid_invoices" : "receipts";
  const jsonValues = record?.[jsonField] || record?.data?.[jsonField];

  const normalise = (items) => items
    .map((item) => ({
      number: item?.number || item?.num || null,
      amount: Math.abs(parseAmount(item?.amount)),
      date: parseDateField(item?.date),
    }))
    .filter((item) => item.number || item.amount > 0 || item.date);

  if (Array.isArray(jsonValues) && jsonValues.length > 0) return normalise(jsonValues);

  if (typeof jsonValues === "string" && jsonValues.trim()) {
    try {
      const parsed = JSON.parse(jsonValues);
      if (Array.isArray(parsed)) return normalise(parsed);
    } catch {
      // fall back to legacy columns
    }
  }

  return [1, 2, 3, 4, 5].map((index) => ({
    number: record?.[`${prefix}_${index}`] || record?.data?.[`${prefix}_${index}`],
    amount: Math.abs(parseAmount(record?.[`${prefix}_${index}_amount`] || record?.data?.[`${prefix}_${index}_amount`])),
    date: parseDateField(record?.[`${prefix}_${index}_date`] || record?.data?.[`${prefix}_${index}_date`]),
  })).filter((item) => item.number || item.amount > 0 || item.date);
}

function dedupeByNumber(items) {
  const seen = new Set();
  return items
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .filter((item) => {
      if (item.number && seen.has(item.number)) return false;
      if (item.number) seen.add(item.number);
      return true;
    })
    .slice(0, 5);
}

function makeFactor(type, text) {
  return { type, text };
}

export function analyseInvoiceCredit(records, flagHistory = [], configOverride = null) {
  const config = normaliseCreditLogicConfig(configOverride || DEFAULT_CREDIT_LOGIC_CONFIG);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const invoices = dedupeByNumber(records.flatMap((record) => extractSlots(record, "last_unpaid_invoice")));
  const receipts = dedupeByNumber(records.flatMap((record) => extractSlots(record, "last_receipt")));

  const rawBalance = records.reduce((sum, record) => sum + parseAmount(record.outstanding_balance || record.data?.outstanding_balance), 0);
  const outstandingBalance = rawBalance < config.thresholds.zeroBalanceCutoff ? 0 : rawBalance;

  const allDates = [...invoices, ...receipts].map((item) => item.date).filter(Boolean);
  const mostRecent = allDates.length > 0 ? Math.max(...allDates.map((date) => +date)) : null;
  const inactiveDays = mostRecent !== null ? Math.floor((today.getTime() - mostRecent) / 86400000) : null;
  const inactiveYears = inactiveDays !== null && inactiveDays > (config.thresholds.longInactiveYears * 365)
    ? Math.floor(inactiveDays / 365)
    : null;
  const inactiveNote = inactiveYears
    ? formatTemplate(config.wording.scenarios.longInactiveNote, { inactiveYears, inactiveYearsPlural: pluralSuffix(inactiveYears) })
    : "";
  const inactiveFactor = inactiveYears
    ? [makeFactor("warn", formatTemplate(config.wording.scenarios.dormantInactiveNote, { inactiveYears, inactiveYearsPlural: pluralSuffix(inactiveYears) }))]
    : [];

  const primaryRecord = records[0] || {};
  const isManualRedFlag = primaryRecord.flag_color === "red" && !primaryRecord.auto_flagged;
  const isManualOrangeFlag = primaryRecord.flag_color === "orange" && !primaryRecord.auto_flagged;
  const createdByClause = buildCreatedByClause(primaryRecord.flag_created_by);

  if (outstandingBalance === 0) {
    const hasHistory = invoices.length > 0 || receipts.length > 0;
    let result = {
      verdict: "approve",
      title: hasHistory ? config.wording.scenarios.zeroBalanceTitle : config.wording.scenarios.newCustomerTitle,
      summary: `${hasHistory ? config.wording.scenarios.zeroBalanceSummary : config.wording.scenarios.newCustomerSummary}${inactiveNote}`,
      factors: [makeFactor("good", config.wording.factors.zeroBalance), ...inactiveFactor],
      score: 100,
      avgLag: null,
      lagData: [],
      timelineData: [],
      isDormantReactivation: false,
      dormantMonths: inactiveDays !== null ? Math.floor(inactiveDays / 30) : null,
      logicVersionUsed: null,
    };

    if (config.manualOverrides.redForcesHold && isManualRedFlag) {
      result = {
        ...result,
        verdict: "hold",
        title: config.wording.manualOverrides.redTitle,
        summary: formatTemplate(config.wording.manualOverrides.redSummary, { createdByClause }),
        factors: [makeFactor("block", formatTemplate(config.wording.manualOverrides.redFactor, { createdByClause })), ...result.factors],
      };
    } else if (config.manualOverrides.orangeDowngradesApprove && isManualOrangeFlag) {
      result = {
        ...result,
        verdict: "caution",
        title: config.wording.manualOverrides.orangeTitle,
        summary: formatTemplate(config.wording.manualOverrides.orangeSummary, { createdByClause }),
        factors: [makeFactor("warn", formatTemplate(config.wording.manualOverrides.orangeFactor, { createdByClause })), ...result.factors],
      };
    }

    return result;
  }

  if (invoices.length === 0 && receipts.length === 0) {
    const score = config.scoring.noHistoryWithBalanceScore;
    return {
      verdict: score < config.thresholds.cautionScoreBelow ? "caution" : "approve",
      title: config.wording.scenarios.noHistoryWithBalanceTitle,
      summary: `${config.wording.scenarios.noHistoryWithBalanceSummary}${inactiveNote}`,
      factors: [makeFactor("warn", formatTemplate(config.wording.factors.noHistoryWithBalance, {
        outstandingBalance: outstandingBalance.toLocaleString("en-ZA", { minimumFractionDigits: 2 }),
      })), ...inactiveFactor],
      score,
      avgLag: null,
      lagData: [],
      timelineData: [],
      isDormantReactivation: false,
      dormantMonths: inactiveDays !== null ? Math.floor(inactiveDays / 30) : null,
      logicVersionUsed: null,
    };
  }

  const factors = [...inactiveFactor];
  let deductions = 0;
  let avgLag = null;

  const redFlags = flagHistory.filter((entry) => entry.action === "flag_changed" && (entry.new_value === "red" || entry.details?.includes("red"))).length;
  const orangeFlags = flagHistory.filter((entry) => entry.action === "flag_changed" && (entry.new_value === "orange" || entry.details?.includes("orange"))).length;

  const invByDate = [...invoices].sort((a, b) => (a.date || 0) - (b.date || 0));
  const recByDate = [...receipts].sort((a, b) => (a.date || 0) - (b.date || 0));
  const usedReceipts = new Set();
  const pairs = invByDate.map((invoice) => {
    const matchIndex = recByDate.findIndex((receipt, index) => !usedReceipts.has(index) && receipt.date && invoice.date && receipt.date >= invoice.date);
    if (matchIndex !== -1) {
      usedReceipts.add(matchIndex);
      const receipt = recByDate[matchIndex];
      return { invoice, receipt, lagDays: Math.floor((receipt.date - invoice.date) / 86400000) };
    }
    return { invoice, receipt: null, lagDays: null };
  });

  const paidPairs = pairs.filter((pair) => pair.receipt !== null);
  const unpaidPairs = pairs.filter((pair) => pair.receipt === null);
  const unpaidAges = unpaidPairs.map((pair) => (pair.invoice.date ? Math.floor((today.getTime() - pair.invoice.date) / 86400000) : null)).filter((days) => days !== null);
  const oldestUnpaidAge = unpaidAges.length > 0 ? Math.max(...unpaidAges) : null;

  if (oldestUnpaidAge !== null && oldestUnpaidAge > config.thresholds.breachDays) {
    factors.push(makeFactor("block", formatTemplate(config.wording.factors.unpaidBreach, { oldestUnpaidAge, breachDays: config.thresholds.breachDays })));
    deductions += config.scoring.unpaidBreachDeduction;
  } else if (oldestUnpaidAge !== null && oldestUnpaidAge > config.thresholds.approachingBreachDays) {
    factors.push(makeFactor("warn", formatTemplate(config.wording.factors.approachingBreach, { oldestUnpaidAge, breachDays: config.thresholds.breachDays })));
    deductions += config.scoring.approachingBreachDeduction;
  } else if (unpaidPairs.length > 0 && oldestUnpaidAge !== null) {
    factors.push(makeFactor("warn", formatTemplate(config.wording.factors.awaitingPayment, { oldestUnpaidAge, oldestUnpaidAgePlural: pluralSuffix(oldestUnpaidAge) })));
    deductions += config.scoring.awaitingPaymentDeduction;
  }

  if (paidPairs.length > 0) {
    const laggedPairs = paidPairs.filter((pair) => pair.lagDays !== null);
    avgLag = laggedPairs.length > 0 ? Math.round(laggedPairs.reduce((sum, pair) => sum + pair.lagDays, 0) / laggedPairs.length) : null;
    if (avgLag !== null) {
      if (unpaidPairs.length > 0 && outstandingBalance > 0) {
        factors.push(makeFactor("bad", formatTemplate(config.wording.factors.avgLagWithUnpaidBalance, { avgLag, avgLagPlural: pluralSuffix(avgLag) })));
        deductions += config.scoring.avgLagWithUnpaidBalanceDeduction;
      } else if (avgLag <= config.thresholds.paymentTermDays) {
        factors.push(makeFactor("good", formatTemplate(config.wording.factors.avgLagWithinTerms, { avgLag, avgLagPlural: pluralSuffix(avgLag), paymentTermDays: config.thresholds.paymentTermDays })));
      } else if (avgLag <= config.thresholds.breachDays) {
        factors.push(makeFactor("warn", formatTemplate(config.wording.factors.avgLagWithinBreach, { avgLag, paymentTermDays: config.thresholds.paymentTermDays, breachDays: config.thresholds.breachDays })));
        deductions += config.scoring.avgLagWithinBreachDeduction;
      } else {
        factors.push(makeFactor("warn", formatTemplate(config.wording.factors.avgLagVerySlow, { avgLag })));
        deductions += config.scoring.avgLagVerySlowDeduction;
      }
    } else {
      factors.push(makeFactor("good", formatTemplate(config.wording.factors.matchedReceipts, { paidPairs: paidPairs.length, pairCount: pairs.length, pairCountPlural: pluralSuffix(pairs.length) })));
    }
  }

  const totalInvoiced = invoices.reduce((sum, invoice) => sum + invoice.amount, 0);
  if (config.outstandingBalanceCap.enabled && totalInvoiced > 0) {
    const avgInvoice = totalInvoiced / invoices.length;
    if (outstandingBalance > avgInvoice * config.outstandingBalanceCap.multiplier) {
      factors.push(makeFactor("bad", formatTemplate(config.wording.factors.exposureCap, {
        outstandingBalance: outstandingBalance.toLocaleString("en-ZA", { minimumFractionDigits: 2 }),
        multiplier: config.outstandingBalanceCap.multiplier,
      })));
      deductions += config.outstandingBalanceCap.deduction;
    }
  }

  if (redFlags >= 2) {
    deductions += config.scoring.historicalRedRepeatDeduction;
    factors.push(makeFactor("bad", config.wording.factors.historicalRedRepeat));
  } else if (redFlags === 1) {
    deductions += config.scoring.historicalRedSingleDeduction;
    factors.push(makeFactor("warn", config.wording.factors.historicalRedSingle));
  }

  if (orangeFlags >= 2) {
    deductions += config.scoring.historicalOrangeRepeatDeduction;
    factors.push(makeFactor("warn", config.wording.factors.historicalOrangeRepeat));
  } else if (orangeFlags === 1) {
    deductions += config.scoring.historicalOrangeSingleDeduction;
    factors.push(makeFactor("warn", config.wording.factors.historicalOrangeSingle));
  }

  const score = Math.max(0, 100 - deductions);
  let verdict;
  let title;
  let summary;

  if (oldestUnpaidAge !== null && oldestUnpaidAge > config.thresholds.breachDays) {
    verdict = "hold";
    title = config.wording.verdicts.hold.title;
    summary = `${formatTemplate(config.wording.verdicts.hold.summary, { oldestUnpaidAge, breachDays: config.thresholds.breachDays })}${inactiveNote}`;
  } else if (score < config.thresholds.cautionScoreBelow) {
    verdict = "caution";
    title = config.wording.verdicts.caution.title;
    summary = `${config.wording.verdicts.caution.summary}${inactiveNote}`;
  } else {
    verdict = "approve";
    title = config.wording.verdicts.approve.title;
    summary = `${config.wording.verdicts.approve.summary}${inactiveNote}`;
  }

  const lagData = paidPairs.filter((pair) => pair.invoice?.date && pair.receipt?.date && pair.lagDays !== null).map((pair, index) => ({
    label: pair.invoice.number || `Invoice ${index + 1}`,
    lagDays: pair.lagDays,
    invoiceDate: pair.invoice.date.toISOString(),
    receiptDate: pair.receipt.date.toISOString(),
  }));

  const timelineData = [
    ...invoices.map((invoice) => ({ type: "invoice", label: invoice.number || "Invoice", date: invoice.date ? invoice.date.toISOString() : null, amount: invoice.amount })),
    ...receipts.map((receipt) => ({ type: "receipt", label: receipt.number || "Receipt", date: receipt.date ? receipt.date.toISOString() : null, amount: receipt.amount })),
  ].filter((item) => item.date);

  let result = {
    verdict,
    title,
    summary,
    factors,
    score,
    avgLag,
    lagData,
    timelineData,
    isDormantReactivation: inactiveDays !== null && inactiveDays > config.thresholds.dormantThresholdDays,
    dormantMonths: inactiveDays !== null ? Math.floor(inactiveDays / 30) : null,
    logicVersionUsed: null,
  };

  if (config.manualOverrides.redForcesHold && isManualRedFlag) {
    result = {
      ...result,
      verdict: "hold",
      title: config.wording.manualOverrides.redTitle,
      summary: formatTemplate(config.wording.manualOverrides.redSummary, { createdByClause }),
      factors: [makeFactor("block", formatTemplate(config.wording.manualOverrides.redFactor, { createdByClause })), ...result.factors],
    };
  } else if (config.manualOverrides.orangeDowngradesApprove && isManualOrangeFlag && result.verdict === "approve") {
    result = {
      ...result,
      verdict: "caution",
      title: config.wording.manualOverrides.orangeTitle,
      summary: formatTemplate(config.wording.manualOverrides.orangeSummary, { createdByClause }),
      factors: [makeFactor("warn", formatTemplate(config.wording.manualOverrides.orangeFactor, { createdByClause })), ...result.factors],
    };
  } else if (result.isDormantReactivation && result.verdict === "approve") {
    result = {
      ...result,
      verdict: "dormant",
      title: config.wording.verdicts.dormant.title,
      summary: formatTemplate(config.wording.verdicts.dormant.summary, { dormantMonths: result.dormantMonths }),
      factors: [makeFactor("warn", formatTemplate(config.wording.scenarios.dormantFactor, { dormantMonths: result.dormantMonths })), ...result.factors],
    };
  }

  return result;
}

export const CREDIT_BADGE_META = {
  approve: { label: "Approve", className: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" },
  caution: { label: "Caution", className: "bg-amber-500/15 text-amber-400 border border-amber-500/30" },
  hold: { label: "Hold", className: "bg-red-500/15 text-red-400 border border-red-500/30" },
  dormant: { label: "Dormant", className: "bg-purple-500/15 text-purple-400 border border-purple-500/30" },
};
