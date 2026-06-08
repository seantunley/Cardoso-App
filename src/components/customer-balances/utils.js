// Shared formatters + account-type helpers for the CustomerBalances
// page and its extracted components. Both the on-screen virtualised row,
// the credit badge, the printable table, and the page itself rely on
// these — keeping them here avoids duplication and matches the previous
// inline organisation of CustomerBalances.jsx.

export function parseAmount(val) {
  if (val === null || val === undefined || val === "") return 0;
  const cleaned = String(val).replace(/,/g, "").replace(/\s/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

export function formatAmount(val) {
  const num = parseAmount(val);
  return num.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function getVisibleAccountType(accountType) {
  const value = String(accountType || "").trim().toUpperCase();
  if (!value || value === "SUB_ACCOUNT") return null;
  // Short labels so the pill fits its fixed-width slot without overlapping the
  // customer name (NATIONAL_ACCOUNT is too long otherwise).
  if (value.includes("NATIONAL")) return "NATIONAL";
  if (value.includes("STANDARD")) return "STANDARD";
  return value;
}

export function getAccountTypePillClasses(accountType) {
  const value = getVisibleAccountType(accountType);
  if (!value) return "";
  if (value.includes("STANDARD")) {
    return "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (value.includes("NATIONAL")) {
    return "border-sky-500/40 bg-sky-500/12 text-sky-700 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-300";
  }
  return "border-slate-400 bg-slate-500/10 text-slate-700 dark:border-slate-500 dark:bg-slate-500/10 dark:text-slate-300";
}
