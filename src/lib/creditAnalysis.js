function parseAmount(value) {
  if (!value || String(value).trim() === "") return 0;
  const numeric = parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(numeric) ? 0 : numeric;
}

function parseDateField(value) {
  if (!value) return null;
  const input = String(value).trim();
  if (/^\d{8}$/.test(input)) {
    return new Date(`${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}`);
  }
  const dmy = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    return new Date(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`);
  }
  const mdy = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return new Date(`${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`);
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function analyseInvoiceCredit(records, flagHistory = []) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const allInvoices = records.flatMap((record) =>
    [1, 2, 3, 4, 5]
      .map((index) => ({
        number: record[`last_unpaid_invoice_${index}`] || record.data?.[`last_unpaid_invoice_${index}`],
        amount: Math.abs(parseAmount(record[`last_unpaid_invoice_${index}_amount`] || record.data?.[`last_unpaid_invoice_${index}_amount`])),
        date: parseDateField(record[`last_unpaid_invoice_${index}_date`] || record.data?.[`last_unpaid_invoice_${index}_date`]),
      }))
      .filter((item) => item.number || item.amount > 0)
  );

  const seenInvoiceNumbers = new Set();
  const invoices = allInvoices
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .filter((item) => {
      if (item.number && seenInvoiceNumbers.has(item.number)) return false;
      if (item.number) seenInvoiceNumbers.add(item.number);
      return true;
    })
    .slice(0, 5);

  const allReceipts = records.flatMap((record) =>
    [1, 2, 3, 4, 5]
      .map((index) => ({
        number: record[`last_receipt_${index}`] || record.data?.[`last_receipt_${index}`],
        amount: Math.abs(parseAmount(record[`last_receipt_${index}_amount`] || record.data?.[`last_receipt_${index}_amount`])),
        date: parseDateField(record[`last_receipt_${index}_date`] || record.data?.[`last_receipt_${index}_date`]),
      }))
      .filter((item) => item.number || item.amount > 0)
  );

  const seenReceiptNumbers = new Set();
  const receipts = allReceipts
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .filter((item) => {
      if (item.number && seenReceiptNumbers.has(item.number)) return false;
      if (item.number) seenReceiptNumbers.add(item.number);
      return true;
    })
    .slice(0, 5);

  const rawBalance = records.reduce(
    (sum, record) => sum + parseAmount(record.outstanding_balance || record.data?.outstanding_balance),
    0
  );
  const outstandingBalance = rawBalance < 1 ? 0 : rawBalance;

  const allDatesEarly = [...invoices, ...receipts].map((item) => item.date).filter(Boolean);
  const mostRecentEarly = allDatesEarly.length > 0 ? Math.max(...allDatesEarly.map((date) => +date)) : null;
  const inactiveDaysEarly = mostRecentEarly !== null ? Math.floor((today - mostRecentEarly) / 86400000) : null;
  const inactiveYearsEarly = inactiveDaysEarly !== null && inactiveDaysEarly > 730 ? Math.floor(inactiveDaysEarly / 365) : null;
  const inactiveNote = inactiveYearsEarly
    ? ` Customer has not transacted in over ${inactiveYearsEarly} year${inactiveYearsEarly > 1 ? "s" : ""} — treat as a new account.`
    : "";
  const inactiveFactor = inactiveYearsEarly
    ? [{ type: "warn", text: `No transactions in over ${inactiveYearsEarly} year${inactiveYearsEarly > 1 ? "s" : ""} — customer has been inactive for a long time.` }]
    : [];

  if (outstandingBalance === 0) {
    const hasHistory = invoices.length > 0 || receipts.length > 0;
    return {
      verdict: "approve",
      title: hasHistory ? "Approve Invoice" : "New Customer",
      summary: (hasHistory
        ? "Balance is zero — account fully settled. Safe to issue a new invoice."
        : "No invoice or receipt history. Safe to issue a first invoice.") + inactiveNote,
      factors: [{ type: "good", text: "Outstanding balance is R0.00 — all accounts cleared." }, ...inactiveFactor],
      score: 100,
      lagData: [],
      timelineData: [],
    };
  }

  if (invoices.length === 0 && receipts.length === 0) {
    return {
      verdict: "caution",
      title: "Proceed with Caution",
      summary: `Outstanding balance but no invoice/receipt history available to assess.${inactiveNote}`,
      factors: [{ type: "warn", text: `Outstanding balance of R ${outstandingBalance.toLocaleString("en-ZA", { minimumFractionDigits: 2 })} with no supporting history.` }, ...inactiveFactor],
      score: 50,
      lagData: [],
      timelineData: [],
    };
  }

  const factors = [];
  let deductions = 0;
  let avgLag = null;

  const redFlags = flagHistory.filter((entry) =>
    entry.action === "flag_changed" && (entry.new_value === "red" || entry.details?.includes("red"))
  ).length;
  const orangeFlags = flagHistory.filter((entry) =>
    entry.action === "flag_changed" && (entry.new_value === "orange" || entry.details?.includes("orange"))
  ).length;

  const invByDate = [...invoices].sort((a, b) => (a.date || 0) - (b.date || 0));
  const recByDate = [...receipts].sort((a, b) => (a.date || 0) - (b.date || 0));

  const usedReceipts = new Set();
  const pairs = invByDate.map((invoice) => {
    const matchIndex = recByDate.findIndex(
      (receipt, index) => !usedReceipts.has(index) && receipt.date && invoice.date && receipt.date >= invoice.date
    );

    if (matchIndex !== -1) {
      usedReceipts.add(matchIndex);
      const receipt = recByDate[matchIndex];
      return { invoice, receipt, lagDays: Math.floor((receipt.date - invoice.date) / 86400000) };
    }

    return { invoice, receipt: null, lagDays: null };
  });

  const paidPairs = pairs.filter((pair) => pair.receipt !== null);
  const unpaidPairs = pairs.filter((pair) => pair.receipt === null);

  const unpaidAges = unpaidPairs
    .map((pair) => (pair.invoice.date ? Math.floor((today - pair.invoice.date) / 86400000) : null))
    .filter((days) => days !== null);
  const oldestUnpaidAge = unpaidAges.length > 0 ? Math.max(...unpaidAges) : null;

  if (oldestUnpaidAge !== null && oldestUnpaidAge > 21) {
    factors.push({ type: "block", text: `Unpaid invoice is ${oldestUnpaidAge} days old — exceeds the 21-day limit. Resolve before issuing a new invoice.` });
    deductions += 70;
  } else if (oldestUnpaidAge !== null && oldestUnpaidAge > 14) {
    factors.push({ type: "warn", text: `Unpaid invoice is ${oldestUnpaidAge} days old — approaching the 21-day limit.` });
    deductions += 25;
  } else if (unpaidPairs.length > 0 && oldestUnpaidAge !== null) {
    factors.push({ type: "warn", text: `Latest invoice is ${oldestUnpaidAge} day${oldestUnpaidAge === 1 ? "" : "s"} old and awaiting payment.` });
    deductions += 10;
  }

  if (inactiveFactor.length > 0) factors.push(...inactiveFactor);

  if (paidPairs.length > 0) {
    const laggedPairs = paidPairs.filter((pair) => pair.lagDays !== null);
    avgLag = laggedPairs.length > 0
      ? Math.round(laggedPairs.reduce((sum, pair) => sum + pair.lagDays, 0) / laggedPairs.length)
      : null;

    if (avgLag !== null) {
      if (unpaidPairs.length > 0 && outstandingBalance > 0) {
        factors.push({ type: "bad", text: `Average payment lag ${avgLag} day${avgLag === 1 ? "" : "s"} on settled invoices, but has unpaid invoices and an outstanding balance — unreliable payer.` });
        deductions += 35;
      } else if (avgLag <= 14) {
        factors.push({ type: "good", text: `Average payment lag ${avgLag} day${avgLag === 1 ? "" : "s"} — within 14-day terms.` });
      } else if (avgLag <= 21) {
        factors.push({ type: "warn", text: `Average payment lag ${avgLag} days — slow but within 21 days (target: 14 days).` });
        deductions += 20;
      } else {
        factors.push({ type: "warn", text: `Average payment lag ${avgLag} days — very slow payer.` });
        deductions += 30;
      }
    } else {
      factors.push({ type: "good", text: `${paidPairs.length} of ${pairs.length} invoice${pairs.length > 1 ? "s" : ""} matched with a receipt.` });
    }
  }

  const totalInvoiced = invoices.reduce((sum, invoice) => sum + invoice.amount, 0);
  if (totalInvoiced > 0) {
    const avgInvoice = totalInvoiced / invoices.length;
    if (outstandingBalance > avgInvoice * 2) {
      factors.push({ type: "bad", text: `Outstanding balance (R ${outstandingBalance.toLocaleString("en-ZA", { minimumFractionDigits: 2 })}) exceeds 2× the average invoice — high exposure.` });
      deductions += 15;
    }
  }

  if (redFlags >= 2) {
    deductions += 20;
    factors.push({ label: "Repeatedly flagged red by staff", impact: "high" });
  } else if (redFlags === 1) {
    deductions += 10;
    factors.push({ label: "Previously flagged red", impact: "medium" });
  }

  if (orangeFlags >= 2) {
    deductions += 10;
    factors.push({ label: "Repeatedly flagged orange by staff", impact: "medium" });
  } else if (orangeFlags === 1) {
    deductions += 5;
    factors.push({ label: "Previously flagged orange", impact: "low" });
  }

  const score = Math.max(0, 100 - deductions);

  let verdict;
  let title;
  let summary;
  if (oldestUnpaidAge !== null && oldestUnpaidAge > 21) {
    verdict = "hold";
    title = "Hold — Do Not Invoice";
    summary = `There is an unpaid invoice ${oldestUnpaidAge} days old. This exceeds the 21-day threshold and should be resolved before new credit is extended.${inactiveNote}`;
  } else if (score < 70) {
    verdict = "caution";
    title = "Proceed with Caution";
    summary = `Payment behaviour shows elevated risk. Consider tighter terms or a smaller exposure until the account improves.${inactiveNote}`;
  } else {
    verdict = "approve";
    title = "Approve Invoice";
    summary = `Payment history is acceptable and there are no strong warning signs. Credit can be extended on normal terms.${inactiveNote}`;
  }

  const lagData = paidPairs
    .filter((pair) => pair.invoice?.date && pair.receipt?.date && pair.lagDays !== null)
    .map((pair, index) => ({
      label: pair.invoice.number || `Invoice ${index + 1}`,
      lagDays: pair.lagDays,
      invoiceDate: pair.invoice.date.toISOString(),
      receiptDate: pair.receipt.date.toISOString(),
    }));

  const timelineData = [
    ...invoices.map((invoice) => ({
      type: "invoice",
      label: invoice.number || "Invoice",
      date: invoice.date ? invoice.date.toISOString() : null,
      amount: invoice.amount,
    })),
    ...receipts.map((receipt) => ({
      type: "receipt",
      label: receipt.number || "Receipt",
      date: receipt.date ? receipt.date.toISOString() : null,
      amount: receipt.amount,
    })),
  ].filter((item) => item.date);

  const isDormantReactivation = inactiveDaysEarly !== null && inactiveDaysEarly > 180;
  const dormantMonths = inactiveDaysEarly !== null ? Math.floor(inactiveDaysEarly / 30) : null;

  return {
    verdict,
    title,
    summary,
    factors,
    score,
    avgLag: typeof avgLag !== "undefined" ? avgLag : null,
    lagData,
    timelineData,
    isDormantReactivation,
    dormantMonths,
  };
}

export const CREDIT_BADGE_META = {
  approve: { label: "Approve", className: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" },
  caution: { label: "Caution", className: "bg-amber-500/15 text-amber-400 border border-amber-500/30" },
  hold: { label: "Hold", className: "bg-red-500/15 text-red-400 border border-red-500/30" },
  dormant: { label: "Dormant", className: "bg-purple-500/15 text-purple-400 border border-purple-500/30" },
};
