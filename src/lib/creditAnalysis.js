import { DEFAULT_CREDIT_LOGIC_CONFIG, normaliseCreditLogicConfig } from "./creditLogic.js";

function parseAmount(value) {
  if (!value || String(value).trim() === "") return 0;
  const numeric = parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(numeric) ? 0 : numeric;
}

// Sage stores "no date" as a placeholder near its epoch (1999-12-31 shows up
// verbatim in invoice slots, surfaced via Credit Debug). Anything before this
// floor is a sentinel, not a real document date — treated as undated so it
// can neither breach (a "27-year-old unpaid invoice" forcing a permanent
// hold) nor settle anything.
const SENTINEL_DATE_FLOOR = new Date("2000-01-01T00:00:00Z");

function parseDateField(value) {
  if (!value) return null;
  const input = String(value).trim();
  let parsed = null;
  if (/^\d{8}$/.test(input)) parsed = new Date(`${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}`);
  if (!parsed) {
    const dmy = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) parsed = new Date(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`);
  }
  if (!parsed) {
    const mdy = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) parsed = new Date(`${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`);
  }
  if (!parsed) parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed < SENTINEL_DATE_FLOOR) return null;
  return parsed;
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

  // Amounts keep their SIGN — a negative receipt is a reversal, and the
  // pairing logic must be able to tell it apart from a payment. (Invoice
  // amounts are abs()'d at the use site; they were always magnitudes.)
  const normalise = (items) => items
    .map((item) => ({
      number: item?.number || item?.num || null,
      amount: parseAmount(item?.amount),
      date: parseDateField(item?.date),
    }))
    .filter((item) => item.number || Math.abs(item.amount) > 0 || item.date);

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
    amount: parseAmount(record?.[`${prefix}_${index}_amount`] || record?.data?.[`${prefix}_${index}_amount`]),
    date: parseDateField(record?.[`${prefix}_${index}_date`] || record?.data?.[`${prefix}_${index}_date`]),
  })).filter((item) => item.number || Math.abs(item.amount) > 0 || item.date);
}

// Customer-specific payment terms from Sage's terms code: "7DAYS" → 7 days,
// "14" → 14, "30 DAYS" → 30, "COD"/"CASH" → 0 (due immediately), "PP" →
// prepaid (operator policy: any outstanding balance ⇒ hold, period).
// Unknown/blank → null, caller falls back to the global thresholds.
export function parseCustomerTerms(termsRaw) {
  if (termsRaw === null || termsRaw === undefined) return null;
  const t = String(termsRaw).trim().toUpperCase();
  if (!t) return null;
  if (/^PP\b|^PREPAID/.test(t)) return { type: "prepaid", days: 0, raw: t };
  if (/^(COD|CASH)\b/.test(t)) return { type: "cod", days: 0, raw: t };
  const m = t.match(/^(\d{1,3})/);
  if (m) return { type: "days", days: parseInt(m[1], 10), raw: t };
  return null;
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

  const invoices = dedupeByNumber(records.flatMap((record) => extractSlots(record, "last_unpaid_invoice")))
    .map((invoice) => ({ ...invoice, amount: Math.abs(invoice.amount) }));
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
      // A long-dormant account is dormant even at a zero (or netted-to-zero)
      // balance — inactivity, not balance, drives this verdict.
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
    } else if (config.manualOverrides.orangeDowngradesApprove && isManualOrangeFlag) {
      result = {
        ...result,
        verdict: "caution",
        title: config.wording.manualOverrides.orangeTitle,
        summary: formatTemplate(config.wording.manualOverrides.orangeSummary, { createdByClause }),
        factors: [makeFactor("warn", formatTemplate(config.wording.manualOverrides.orangeFactor, { createdByClause })), ...result.factors],
      };
    } else if (result.isDormantReactivation) {
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

  // ── Customer-specific terms ────────────────────────────────────────────
  // Judge the account on its own Sage terms when present; the global
  // thresholds remain the fallback AND supply the grace gap (breachDays −
  // paymentTermDays) so a 7-day account breaches at 7+gap, not at the
  // global 21. Reached only when a balance exists (zero-balance returned
  // above — a prepaid account with nothing owing is simply fine).
  const termsRaw = primaryRecord.terms || primaryRecord.data?.terms || "";
  const customerTerms = config.customerTerms.enabled ? parseCustomerTerms(termsRaw) : null;
  const termGap = Math.max(0, config.thresholds.breachDays - config.thresholds.paymentTermDays);
  const effTermDays = customerTerms ? customerTerms.days : config.thresholds.paymentTermDays;
  const effBreachDays = customerTerms ? customerTerms.days + termGap : config.thresholds.breachDays;
  const effApproachDays = customerTerms ? customerTerms.days : config.thresholds.approachingBreachDays;

  // Prepaid policy (operator-confirmed, June 2026): a PP account carrying ANY
  // outstanding balance does not get a new invoice. Period. Outranks scoring;
  // manual red would only re-state the same verdict.
  if (config.customerTerms.prepaidHoldOnBalance && customerTerms?.type === "prepaid" && outstandingBalance > 0) {
    const balanceText = outstandingBalance.toLocaleString("en-ZA", { minimumFractionDigits: 2 });
    return {
      verdict: "hold",
      title: config.wording.scenarios.prepaidHoldTitle,
      summary: `${formatTemplate(config.wording.scenarios.prepaidHoldSummary, { terms: termsRaw, outstandingBalance: balanceText })}${inactiveNote}`,
      factors: [makeFactor("block", formatTemplate(config.wording.scenarios.prepaidHoldFactor, { terms: termsRaw, outstandingBalance: balanceText })), ...inactiveFactor],
      score: 0,
      avgLag: null,
      lagData: [],
      timelineData: [],
      isDormantReactivation: false,
      dormantMonths: inactiveDays !== null ? Math.floor(inactiveDays / 30) : null,
      logicVersionUsed: null,
    };
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

  let pairs;
  if (config.pairing.amountAware) {
    // Amount-aware settlement (June 2026 fix): receipts are a pool of MONEY
    // applied to invoices oldest-first, and an invoice only counts as paid
    // once enough has actually arrived (coverageRatio tolerates small
    // discounts). The old rule — any receipt dated on/after the invoice
    // settles it, amounts never compared — let a token same-day receipt
    // "pay" a R104k invoice and mark the account Approve while the entire
    // balance was overdue.
    //
    // Receipt amounts are taken by MAGNITUDE. This site stores AR receipts
    // NEGATIVE by convention (a payment credits the balance — live data:
    // PY500316 −612.01), so sign cannot distinguish payments from reversals,
    // and the slots carry no document type. An earlier draft excluded
    // negative receipts as "reversals" — that would have zeroed every normal
    // payment and mass-failed accounts to Hold.
    const pool = recByDate.map((receipt) => ({
      receipt,
      remaining: Math.abs(receipt.amount),
    }));
    pairs = invByDate.map((invoice) => {
      if (!invoice.date) return { invoice, receipt: null, lagDays: null };
      if (!(invoice.amount > 0)) {
        // Slot has a number/date but no amount — fall back to the legacy
        // date rule for this invoice only (nothing to allocate against).
        const match = pool.find((entry) => entry.receipt.date && entry.receipt.date >= invoice.date);
        return match
          ? { invoice, receipt: match.receipt, lagDays: Math.floor((match.receipt.date - invoice.date) / 86400000) }
          : { invoice, receipt: null, lagDays: null };
      }
      let allocated = 0;
      let settledBy = null;
      for (const entry of pool) {
        if (!entry.receipt.date || entry.receipt.date < invoice.date || entry.remaining <= 0) continue;
        const take = Math.min(entry.remaining, invoice.amount - allocated);
        entry.remaining -= take;
        allocated += take;
        if (allocated >= invoice.amount * config.pairing.coverageRatio) {
          settledBy = entry.receipt;
          break;
        }
      }
      return settledBy
        ? { invoice, receipt: settledBy, lagDays: Math.floor((settledBy.date - invoice.date) / 86400000) }
        : { invoice, receipt: null, lagDays: null };
    });
  } else {
    // Legacy date-only pairing, kept behind the config switch.
    const usedReceipts = new Set();
    pairs = invByDate.map((invoice) => {
      const matchIndex = recByDate.findIndex((receipt, index) => !usedReceipts.has(index) && receipt.date && invoice.date && receipt.date >= invoice.date);
      if (matchIndex !== -1) {
        usedReceipts.add(matchIndex);
        const receipt = recByDate[matchIndex];
        return { invoice, receipt, lagDays: Math.floor((receipt.date - invoice.date) / 86400000) };
      }
      return { invoice, receipt: null, lagDays: null };
    });
  }

  const paidPairs = pairs.filter((pair) => pair.receipt !== null);
  const unpaidPairs = pairs.filter((pair) => pair.receipt === null);
  // Materiality floor (operator decision): only unpaid invoices of at least
  // minMaterialInvoice can drive the verdict. A R0.30 rounding residue from
  // January was forcing Hold (153-day "breach") on a healthy R148k account.
  // Immaterial residues still sit in the balance — they just can't dictate.
  const materialUnpaid = unpaidPairs.filter((pair) => pair.invoice.amount >= config.thresholds.minMaterialInvoice);
  const immaterialUnpaid = unpaidPairs.filter((pair) => pair.invoice.amount > 0 && pair.invoice.amount < config.thresholds.minMaterialInvoice);
  if (immaterialUnpaid.length > 0) {
    const largest = Math.max(...immaterialUnpaid.map((pair) => pair.invoice.amount));
    factors.push(makeFactor("good", `Ignored ${immaterialUnpaid.length} unpaid residue${immaterialUnpaid.length === 1 ? "" : "s"} under R ${config.thresholds.minMaterialInvoice.toFixed(2)} (largest R ${largest.toFixed(2)}) — too small to drive the verdict.`));
  }
  // The OFFENDING invoice — the oldest material unpaid one. We carry its
  // number/amount/date so the verdict can name it (operator request: "which
  // invoice is 662 days old?"). It's already in the synced slots; the engine
  // just used to compute the age and discard which document it came from.
  const datedMaterial = materialUnpaid.filter((pair) => pair.invoice.date);
  const offendingPair = datedMaterial.length > 0
    ? datedMaterial.reduce((oldest, pair) => (pair.invoice.date < oldest.invoice.date ? pair : oldest))
    : null;
  const oldestUnpaidAge = offendingPair
    ? Math.floor((today.getTime() - offendingPair.invoice.date) / 86400000)
    : null;
  // Compact reference like "IN539887 · R 2 693,39 · 12 Aug 2024" for the
  // factor and the returned result, so the card and any caller can show it.
  const offendingInvoice = offendingPair ? {
    number: String(offendingPair.invoice.number || "").trim() || null,
    amount: offendingPair.invoice.amount,
    date: offendingPair.invoice.date,
  } : null;
  const offendingRef = offendingInvoice ? (() => {
    const parts = [];
    if (offendingInvoice.number) parts.push(offendingInvoice.number);
    parts.push(`R ${offendingInvoice.amount.toLocaleString("en-ZA", { minimumFractionDigits: 2 })}`);
    parts.push(offendingInvoice.date.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }));
    return ` (${parts.join(" · ")})`;
  })() : "";

  if (oldestUnpaidAge !== null && oldestUnpaidAge > effBreachDays) {
    factors.push(makeFactor("block", formatTemplate(config.wording.factors.unpaidBreach, { oldestUnpaidAge, breachDays: effBreachDays }) + offendingRef));
    deductions += config.scoring.unpaidBreachDeduction;
  } else if (oldestUnpaidAge !== null && oldestUnpaidAge > effApproachDays) {
    factors.push(makeFactor("warn", formatTemplate(config.wording.factors.approachingBreach, { oldestUnpaidAge, breachDays: effBreachDays }) + offendingRef));
    deductions += config.scoring.approachingBreachDeduction;
  } else if (materialUnpaid.length > 0 && oldestUnpaidAge !== null) {
    factors.push(makeFactor("warn", formatTemplate(config.wording.factors.awaitingPayment, { oldestUnpaidAge, oldestUnpaidAgePlural: pluralSuffix(oldestUnpaidAge) }) + offendingRef));
    deductions += config.scoring.awaitingPaymentDeduction;
  }

  if (paidPairs.length > 0) {
    const laggedPairs = paidPairs.filter((pair) => pair.lagDays !== null);
    avgLag = laggedPairs.length > 0 ? Math.round(laggedPairs.reduce((sum, pair) => sum + pair.lagDays, 0) / laggedPairs.length) : null;
    if (avgLag !== null) {
      if (materialUnpaid.length > 0 && outstandingBalance > 0) {
        factors.push(makeFactor("bad", formatTemplate(config.wording.factors.avgLagWithUnpaidBalance, { avgLag, avgLagPlural: pluralSuffix(avgLag) })));
        deductions += config.scoring.avgLagWithUnpaidBalanceDeduction;
      } else if (avgLag <= effTermDays) {
        factors.push(makeFactor("good", formatTemplate(config.wording.factors.avgLagWithinTerms, { avgLag, avgLagPlural: pluralSuffix(avgLag), paymentTermDays: effTermDays })));
      } else if (avgLag <= effBreachDays) {
        factors.push(makeFactor("warn", formatTemplate(config.wording.factors.avgLagWithinBreach, { avgLag, paymentTermDays: effTermDays, breachDays: effBreachDays })));
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

  if (oldestUnpaidAge !== null && oldestUnpaidAge > effBreachDays) {
    verdict = "hold";
    title = config.wording.verdicts.hold.title;
    summary = `${formatTemplate(config.wording.verdicts.hold.summary, { oldestUnpaidAge, breachDays: effBreachDays })}${inactiveNote}`;
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
    // Receipts carry their sign internally (reversals are negative for the
    // pairing logic); the timeline chart shows magnitudes.
    ...receipts.map((receipt) => ({ type: "receipt", label: receipt.number || "Receipt", date: receipt.date ? receipt.date.toISOString() : null, amount: Math.abs(receipt.amount) })),
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
    // The oldest material unpaid invoice driving the age/breach, named so
    // callers can show "which invoice". null when nothing material is unpaid.
    offendingInvoice,
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
