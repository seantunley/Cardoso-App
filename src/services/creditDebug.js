import db from '../db/index.js';
import { expandDataRecord, parseJsonSafely } from '../helpers.js';
import { getLocalCreditLogicState } from './creditLogic.js';
import { normaliseCreditLogicConfig } from '../lib/creditLogic.js';
import { parseCustomerTerms } from '../lib/creditAnalysis.js';

// ─── helpers (mirrors creditAnalysis.js) ───
//
// ⚠ This file re-implements the engine step by step so the Credit Debug page
// can show every intermediate number. Any behavioural change in
// src/lib/creditAnalysis.js MUST be mirrored here or the debug page lies
// about what the real engine does (June 2026: its copy of the old date-only
// pairing reported "paid 2 / unpaid 0" while the page labelled the same
// lines UNPAID). Follow-up worth doing: make the engine emit a trace and
// delete this copy.

function parseAmount(value) {
  if (!value || String(value).trim() === '') return 0;
  const numeric = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(numeric) ? 0 : numeric;
}

// Same sentinel floor as the engine: Sage's "no date" placeholder
// (1999-12-31) must not read as a real 27-year-old document.
const SENTINEL_DATE_FLOOR = new Date('2000-01-01T00:00:00Z');

function parseDateField(value) {
  if (!value) return null;
  const input = String(value).trim();
  let parsed = null;
  if (/^\d{8}$/.test(input)) parsed = new Date(`${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}`);
  if (!parsed) {
    const dmy = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) parsed = new Date(`${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`);
  }
  if (!parsed) parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed < SENTINEL_DATE_FLOOR) return null;
  return parsed;
}

function extractSlots(record, prefix) {
  const jsonField = prefix === 'last_unpaid_invoice' ? 'unpaid_invoices' : 'receipts';
  const jsonValues = record?.[jsonField] || record?.data?.[jsonField];

  // Signed, like the engine — reversals (negative receipts) must be visible.
  const normalise = (items) => items
    .map((item) => ({
      number: item?.number || item?.num || null,
      amount: parseAmount(item?.amount),
      date: parseDateField(item?.date),
    }))
    .filter((item) => item.number || Math.abs(item.amount) > 0 || item.date);

  if (Array.isArray(jsonValues) && jsonValues.length > 0) return normalise(jsonValues);

  if (typeof jsonValues === 'string' && jsonValues.trim()) {
    try {
      const parsed = JSON.parse(jsonValues);
      if (Array.isArray(parsed)) return normalise(parsed);
    } catch { /* fall back to legacy columns */ }
  }

  return [1, 2, 3, 4, 5].map((index) => ({
    number: record?.[`${prefix}_${index}`] || record?.data?.[`${prefix}_${index}`],
    amount: parseAmount(record?.[`${prefix}_${index}_amount`] || record?.data?.[`${prefix}_${index}_amount`]),
    date: parseDateField(record?.[`${prefix}_${index}_date`] || record?.data?.[`${prefix}_${index}_date`]),
  })).filter((item) => item.number || Math.abs(item.amount) > 0 || item.date);
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

function fmtDate(d) {
  return d ? d.toISOString().slice(0, 10) : 'N/A';
}

function fmtR(n) {
  return `R ${Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
}

// ─── Default config fallback (matches creditLogic.js DEFAULT_CREDIT_LOGIC_CONFIG thresholds/scoring) ───

function getActiveConfig() {
  // Always run the result through the engine's own normaliser: the synced
  // config gains the new pairing/customerTerms defaults, and the debug page
  // can never drift from the engine's effective config again (its previous
  // hand-written fallback already had — dormantThresholdDays 180 vs the
  // engine's 90).
  try {
    const state = getLocalCreditLogicState();
    if (state?.config) return { version: state.logicVersion, config: normaliseCreditLogicConfig(state.config) };
  } catch { /* fallback */ }
  return { version: null, config: normaliseCreditLogicConfig(null) };
}

// ─── Main debug function ───

export function debugCreditForCustomer(customerNumber) {
  const steps = [];
  const step = (label, detail) => steps.push({ step: steps.length + 1, label, detail });

  // 1. Load active config
  const { version: logicVersion, config: cfg } = getActiveConfig();
  step('Load credit logic config', {
    logicVersion,
    thresholds: cfg.thresholds,
    scoring: cfg.scoring,
    outstandingBalanceCap: cfg.outstandingBalanceCap,
    manualOverrides: cfg.manualOverrides,
  });

  // 2. Look up customer
  const query = String(customerNumber).trim();
  const rawRecord = db.prepare(`
    SELECT * FROM datarecord
    WHERE TRIM(customer_number) = ?
       OR lower(customer_name) = lower(?)
    ORDER BY CASE WHEN TRIM(customer_number) = ? THEN 0 ELSE 1 END, id DESC
    LIMIT 1
  `).get(query, query, query);

  if (!rawRecord) {
    step('Customer lookup', { found: false, query });
    return { found: false, customerNumber: query, steps, verdict: null, score: null };
  }

  const record = expandDataRecord(rawRecord);
  step('Customer lookup', {
    found: true,
    id: record.id,
    customer_number: record.customer_number,
    customer_name: record.customer_name,
    outstanding_balance: record.outstanding_balance,
    flag_color: record.flag_color || 'none',
    flag_reason: record.flag_reason || null,
    flag_created_by: record.flag_created_by || null,
    auto_flagged: record.auto_flagged ? true : false,
  });

  // 3. Find sub-accounts
  const custNum = String(record.customer_number || '').trim();
  const isParent = /^\d+$/.test(custNum);
  let subAccounts = [];
  if (isParent) {
    const prefixMatches = db.prepare(`
      SELECT * FROM datarecord WHERE TRIM(customer_number) LIKE ? AND TRIM(customer_number) != ?
      ORDER BY customer_number ASC, id ASC
    `).all(`${custNum}%`, custNum);
    subAccounts = prefixMatches.map(expandDataRecord).filter((row) => {
      const cn = String(row.customer_number || '').trim();
      const match = cn.match(/^(\d+)/);
      return match && match[1] === custNum;
    });
  }
  step('Sub-accounts', {
    isParent,
    count: subAccounts.length,
    accounts: subAccounts.map(s => ({
      customer_number: s.customer_number,
      outstanding_balance: s.outstanding_balance,
    })),
  });

  // 4. Combine records
  const allRecords = [record, ...subAccounts];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 5. Extract invoices & receipts
  const invoices = dedupeByNumber(allRecords.flatMap((r) => extractSlots(r, 'last_unpaid_invoice')));
  const receipts = dedupeByNumber(allRecords.flatMap((r) => extractSlots(r, 'last_receipt')));
  step('Extract invoices', {
    count: invoices.length,
    invoices: invoices.map(i => ({ number: i.number, amount: i.amount, date: fmtDate(i.date) })),
  });
  step('Extract receipts', {
    count: receipts.length,
    receipts: receipts.map(r => ({ number: r.number, amount: r.amount, date: fmtDate(r.date) })),
  });

  // 6. Calculate balance
  const rawBalance = allRecords.reduce((sum, r) => sum + parseAmount(r.outstanding_balance || r.data?.outstanding_balance), 0);
  const outstandingBalance = rawBalance < cfg.thresholds.zeroBalanceCutoff ? 0 : rawBalance;
  step('Outstanding balance', {
    rawBalance: Math.round(rawBalance * 100) / 100,
    zeroBalanceCutoff: cfg.thresholds.zeroBalanceCutoff,
    effectiveBalance: Math.round(outstandingBalance * 100) / 100,
    balanceTreatedAsZero: outstandingBalance === 0 && rawBalance > 0,
  });

  // 6b. Customer terms (June 2026) — judge the account on its own Sage terms;
  // global thresholds remain the fallback and supply the grace gap.
  const termsRaw = record.terms || record.data?.terms || '';
  const customerTerms = cfg.customerTerms.enabled ? parseCustomerTerms(termsRaw) : null;
  const termGap = Math.max(0, cfg.thresholds.breachDays - cfg.thresholds.paymentTermDays);
  const effTermDays = customerTerms ? customerTerms.days : cfg.thresholds.paymentTermDays;
  const effBreachDays = customerTerms ? customerTerms.days + termGap : cfg.thresholds.breachDays;
  const effApproachDays = customerTerms ? customerTerms.days : cfg.thresholds.approachingBreachDays;
  const prepaidHoldApplies = cfg.customerTerms.prepaidHoldOnBalance && customerTerms?.type === 'prepaid' && outstandingBalance > 0;
  step('Customer terms', {
    termsRaw: termsRaw || '(none)',
    parsed: customerTerms ? `${customerTerms.type}${customerTerms.type === 'days' ? ` — ${customerTerms.days} days` : ''}` : 'none — global thresholds apply',
    effectiveTermDays: effTermDays,
    effectiveBreachDays: effBreachDays,
    effectiveApproachingDays: effApproachDays,
    prepaidHoldApplies,
    ...(prepaidHoldApplies ? { note: 'PREPAID WITH OUTSTANDING BALANCE — the engine short-circuits to HOLD (score 0). The steps below are shown for reference only.' } : {}),
  });

  // 7. Dormancy check
  const allDates = [...invoices, ...receipts].map(i => i.date).filter(Boolean);
  const mostRecent = allDates.length > 0 ? Math.max(...allDates.map(d => +d)) : null;
  const inactiveDays = mostRecent !== null ? Math.floor((today - mostRecent) / 86400000) : null;
  const inactiveYears = inactiveDays !== null && inactiveDays > (cfg.thresholds.longInactiveYears * 365)
    ? Math.floor(inactiveDays / 365) : null;
  const dormantMonths = inactiveDays !== null ? Math.floor(inactiveDays / 30) : null;
  const isDormantReactivation = inactiveDays !== null && inactiveDays > cfg.thresholds.dormantThresholdDays;
  step('Dormancy check', {
    mostRecentTransaction: mostRecent ? new Date(mostRecent).toISOString().slice(0, 10) : null,
    inactiveDays,
    dormantMonths,
    isDormantReactivation,
    dormantThresholdDays: cfg.thresholds.dormantThresholdDays,
    longInactiveYears: inactiveYears,
  });

  // 8. Manual flag check
  const isManualRedFlag = record.flag_color === 'red' && !record.auto_flagged;
  const isManualOrangeFlag = record.flag_color === 'orange' && !record.auto_flagged;
  step('Manual flag status', {
    flag_color: record.flag_color || 'none',
    auto_flagged: record.auto_flagged ? true : false,
    isManualRedFlag,
    isManualOrangeFlag,
    redForcesHold: cfg.manualOverrides.redForcesHold,
    orangeDowngradesApprove: cfg.manualOverrides.orangeDowngradesApprove,
  });

  // EARLY EXIT: Zero balance
  if (outstandingBalance === 0) {
    let verdict = 'approve';
    let reason = 'Balance is zero — account fully settled.';
    if (cfg.manualOverrides.redForcesHold && isManualRedFlag) {
      verdict = 'hold';
      reason = 'Balance is zero BUT manual red flag forces HOLD.';
    } else if (cfg.manualOverrides.orangeDowngradesApprove && isManualOrangeFlag) {
      verdict = 'caution';
      reason = 'Balance is zero BUT manual orange flag downgrades to CAUTION.';
    }
    step('VERDICT (zero balance early exit)', { verdict, score: 100, reason });
    return { found: true, customerNumber: custNum, customerName: record.customer_name, verdict, score: 100, steps };
  }

  // EARLY EXIT: No history with balance
  if (invoices.length === 0 && receipts.length === 0) {
    const score = cfg.scoring.noHistoryWithBalanceScore;
    const verdict = score < cfg.thresholds.cautionScoreBelow ? 'caution' : 'approve';
    step('VERDICT (no history early exit)', {
      verdict,
      score,
      reason: `Outstanding balance of ${fmtR(outstandingBalance)} with no invoice/receipt history. Score set to noHistoryWithBalanceScore (${score}).`,
    });
    return { found: true, customerNumber: custNum, customerName: record.customer_name, verdict, score, steps };
  }

  // 9. Match invoices to receipts (payment lag) — amount-aware, mirroring
  // the June 2026 engine: receipts are a pool of money applied oldest-
  // invoice-first; an invoice settles only when coverageRatio of its amount
  // actually arrived. Reversals (negative receipts) contribute nothing.
  const invByDate = [...invoices]
    .map((invoice) => ({ ...invoice, amount: Math.abs(invoice.amount) }))
    .sort((a, b) => (a.date || 0) - (b.date || 0));
  const recByDate = [...receipts].sort((a, b) => (a.date || 0) - (b.date || 0));
  const pool = recByDate.map((receipt) => ({
    receipt,
    remaining: cfg.pairing.excludeReversals ? Math.max(0, receipt.amount) : Math.abs(receipt.amount),
  }));
  const pairs = invByDate.map((invoice) => {
    if (!invoice.date) return { invoice, receipt: null, lagDays: null, allocated: 0 };
    if (!(invoice.amount > 0)) {
      const match = pool.find((entry) => entry.receipt.date && entry.receipt.date >= invoice.date);
      return match
        ? { invoice, receipt: match.receipt, lagDays: Math.floor((match.receipt.date - invoice.date) / 86400000), allocated: null }
        : { invoice, receipt: null, lagDays: null, allocated: 0 };
    }
    let allocated = 0;
    let settledBy = null;
    for (const entry of pool) {
      if (!entry.receipt.date || entry.receipt.date < invoice.date || entry.remaining <= 0) continue;
      const take = Math.min(entry.remaining, invoice.amount - allocated);
      entry.remaining -= take;
      allocated += take;
      if (allocated >= invoice.amount * cfg.pairing.coverageRatio) { settledBy = entry.receipt; break; }
    }
    return settledBy
      ? { invoice, receipt: settledBy, lagDays: Math.floor((settledBy.date - invoice.date) / 86400000), allocated }
      : { invoice, receipt: null, lagDays: null, allocated };
  });

  const paidPairs = pairs.filter(p => p.receipt !== null);
  const unpaidPairs = pairs.filter(p => p.receipt === null);
  step('Invoice/receipt matching', {
    pairingMode: cfg.pairing.amountAware ? `amount-aware (coverage ≥ ${Math.round(cfg.pairing.coverageRatio * 100)}%)` : 'legacy date-only',
    reversalsExcluded: cfg.pairing.excludeReversals,
    totalPairs: pairs.length,
    paid: paidPairs.length,
    unpaid: unpaidPairs.length,
    matches: pairs.map(p => ({
      invoice: p.invoice.number || '?',
      invoiceDate: fmtDate(p.invoice.date),
      invoiceAmount: p.invoice.amount,
      // `paid` drives the UNPAID label — a settled invoice whose completing
      // receipt has no number previously displayed as "UNPAID" while the
      // counters said paid (operator-reported contradiction).
      paid: p.receipt !== null,
      receipt: p.receipt ? (p.receipt.number || '(receipt without number)') : 'UNPAID',
      receiptDate: p.receipt ? fmtDate(p.receipt.date) : 'N/A',
      allocated: p.allocated,
      lagDays: p.lagDays,
    })),
  });

  // 10. Unpaid invoice age
  const unpaidAges = unpaidPairs
    .map(p => (p.invoice.date ? Math.floor((today - p.invoice.date) / 86400000) : null))
    .filter(d => d !== null);
  const oldestUnpaidAge = unpaidAges.length > 0 ? Math.max(...unpaidAges) : null;
  step('Unpaid invoice age', {
    unpaidInvoices: unpaidPairs.map(p => ({
      number: p.invoice.number || '?',
      date: fmtDate(p.invoice.date),
      ageDays: p.invoice.date ? Math.floor((today - p.invoice.date) / 86400000) : null,
    })),
    oldestUnpaidAge,
    breachDays: effBreachDays,
    approachingBreachDays: effApproachDays,
    inBreach: oldestUnpaidAge !== null && oldestUnpaidAge > effBreachDays,
    approachingBreach: oldestUnpaidAge !== null && oldestUnpaidAge > effApproachDays && oldestUnpaidAge <= effBreachDays,
  });

  // 11. Score calculation
  let deductions = 0;
  const deductionLog = [];

  const addDeduction = (points, reason) => {
    deductions += points;
    deductionLog.push({ points, reason, runningTotal: deductions });
  };

  // Unpaid breach — effective (terms-aware) thresholds
  if (oldestUnpaidAge !== null && oldestUnpaidAge > effBreachDays) {
    addDeduction(cfg.scoring.unpaidBreachDeduction, `Unpaid invoice ${oldestUnpaidAge} days old > breach limit ${effBreachDays} days`);
  } else if (oldestUnpaidAge !== null && oldestUnpaidAge > effApproachDays) {
    addDeduction(cfg.scoring.approachingBreachDeduction, `Unpaid invoice ${oldestUnpaidAge} days old — approaching breach limit ${effBreachDays} days`);
  } else if (unpaidPairs.length > 0 && oldestUnpaidAge !== null) {
    addDeduction(cfg.scoring.awaitingPaymentDeduction, `Invoice ${oldestUnpaidAge} days old awaiting payment`);
  }

  // Payment lag — effective (terms-aware) thresholds
  let avgLag = null;
  if (paidPairs.length > 0) {
    const laggedPairs = paidPairs.filter(p => p.lagDays !== null);
    avgLag = laggedPairs.length > 0 ? Math.round(laggedPairs.reduce((sum, p) => sum + p.lagDays, 0) / laggedPairs.length) : null;
    if (avgLag !== null) {
      if (unpaidPairs.length > 0 && outstandingBalance > 0) {
        addDeduction(cfg.scoring.avgLagWithUnpaidBalanceDeduction, `Avg payment lag ${avgLag} days + unpaid invoices + outstanding balance — unreliable payer`);
      } else if (avgLag <= effTermDays) {
        // Good — no deduction
      } else if (avgLag <= effBreachDays) {
        addDeduction(cfg.scoring.avgLagWithinBreachDeduction, `Avg payment lag ${avgLag} days — slow (target: ${effTermDays} days)`);
      } else {
        addDeduction(cfg.scoring.avgLagVerySlowDeduction, `Avg payment lag ${avgLag} days — very slow payer`);
      }
    }
  }
  step('Payment lag analysis', {
    avgLag,
    paymentTermDays: effTermDays,
    lagStatus: avgLag === null ? 'no data' : avgLag <= effTermDays ? 'within terms' : avgLag <= effBreachDays ? 'slow' : 'very slow',
  });

  // Exposure cap
  const totalInvoiced = invoices.reduce((sum, inv) => sum + inv.amount, 0);
  if (cfg.outstandingBalanceCap.enabled && totalInvoiced > 0) {
    const avgInvoice = totalInvoiced / invoices.length;
    const cap = avgInvoice * cfg.outstandingBalanceCap.multiplier;
    const exceeded = outstandingBalance > cap;
    step('Exposure cap check', {
      enabled: true,
      avgInvoice: Math.round(avgInvoice * 100) / 100,
      multiplier: cfg.outstandingBalanceCap.multiplier,
      cap: Math.round(cap * 100) / 100,
      outstandingBalance: Math.round(outstandingBalance * 100) / 100,
      exceeded,
    });
    if (exceeded) {
      addDeduction(cfg.outstandingBalanceCap.deduction, `Balance ${fmtR(outstandingBalance)} exceeds ${cfg.outstandingBalanceCap.multiplier}x avg invoice ${fmtR(avgInvoice)}`);
    }
  } else {
    step('Exposure cap check', { enabled: cfg.outstandingBalanceCap.enabled, skipped: true, reason: totalInvoiced === 0 ? 'No invoiced amount' : 'Disabled' });
  }

  // Historical flags. created_date is ISO-8601, so lexical sort matches
  // chronological — datetime() wrapper would defeat the composite index.
  const flagHistory = db.prepare(`
    SELECT action_type, changes FROM auditlog
    WHERE resource_type = 'record' AND resource_id = ?
    ORDER BY created_date DESC LIMIT 50
  `).all(String(record.id));

  const flagEntries = flagHistory
    .filter(e => e.action_type === 'update_flag')
    .map(e => {
      let new_value = null;
      try {
        const ch = typeof e.changes === 'string' ? JSON.parse(e.changes) : (e.changes || {});
        new_value = ch.flag_color || ch.to || null;
      } catch { /* ignore */ }
      return { action: 'flag_changed', new_value };
    });

  const redFlags = flagEntries.filter(e => e.new_value === 'red').length;
  const orangeFlags = flagEntries.filter(e => e.new_value === 'orange').length;

  step('Historical flag analysis', {
    totalFlagChanges: flagEntries.length,
    redFlagCount: redFlags,
    orangeFlagCount: orangeFlags,
    entries: flagEntries,
  });

  if (redFlags >= 2) addDeduction(cfg.scoring.historicalRedRepeatDeduction, `${redFlags} historical red flags (repeat)`);
  else if (redFlags === 1) addDeduction(cfg.scoring.historicalRedSingleDeduction, '1 historical red flag');
  if (orangeFlags >= 2) addDeduction(cfg.scoring.historicalOrangeRepeatDeduction, `${orangeFlags} historical orange flags (repeat)`);
  else if (orangeFlags === 1) addDeduction(cfg.scoring.historicalOrangeSingleDeduction, '1 historical orange flag');

  // 12. Final score
  const score = Math.max(0, 100 - deductions);
  step('Score calculation', {
    startingScore: 100,
    totalDeductions: deductions,
    finalScore: score,
    deductions: deductionLog,
  });

  // 13. Verdict — prepaid policy first (mirrors the engine's short-circuit),
  // then the effective (terms-aware) breach threshold.
  let verdict;
  let verdictReason;
  if (prepaidHoldApplies) {
    verdict = 'hold';
    verdictReason = `Prepaid terms (${termsRaw}) with an outstanding balance — policy hold, no exceptions (engine short-circuits with score 0)`;
  } else if (oldestUnpaidAge !== null && oldestUnpaidAge > effBreachDays) {
    verdict = 'hold';
    verdictReason = `Unpaid invoice ${oldestUnpaidAge} days old exceeds breach threshold (${effBreachDays} days)`;
  } else if (score < cfg.thresholds.cautionScoreBelow) {
    verdict = 'caution';
    verdictReason = `Score ${score} is below caution threshold (${cfg.thresholds.cautionScoreBelow})`;
  } else {
    verdict = 'approve';
    verdictReason = `Score ${score} is above caution threshold (${cfg.thresholds.cautionScoreBelow})`;
  }

  // Manual overrides
  let overrideApplied = null;
  if (cfg.manualOverrides.redForcesHold && isManualRedFlag) {
    verdict = 'hold';
    overrideApplied = 'Manual red flag forces HOLD (overrides score-based verdict)';
  } else if (cfg.manualOverrides.orangeDowngradesApprove && isManualOrangeFlag && verdict === 'approve') {
    verdict = 'caution';
    overrideApplied = 'Manual orange flag downgrades APPROVE → CAUTION';
  } else if (isDormantReactivation && verdict === 'approve') {
    verdict = 'dormant';
    overrideApplied = `No transactions in ${dormantMonths} months — dormant reactivation needed`;
  }

  step('FINAL VERDICT', {
    verdict,
    score: prepaidHoldApplies ? 0 : score,
    verdictReason,
    overrideApplied,
    avgLag,
    dormantMonths,
  });

  return {
    found: true,
    customerNumber: custNum,
    customerName: record.customer_name,
    verdict,
    score: prepaidHoldApplies ? 0 : score,
    avgLag,
    steps,
  };
}
