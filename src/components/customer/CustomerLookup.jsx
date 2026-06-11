// @ts-nocheck — legacy 1,300-line component, never in the scoped typecheck
// (tsconfig.typecheck.json). Importing it from CustomerBalances (which IS in
// scope) pulls it into the checked graph; its ~70 pre-existing inference
// errors are tracked under the legacy-typecheck debt (tech-debt register),
// to be ratcheted when this component is split.
import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";

// Recharts is heavy (~100 KB). Lazy-load the chart so the default landing page
// doesn't pull it in until the user actually selects a customer.
const PaymentHistoryCharts = lazy(() => import("./PaymentHistoryCharts"));
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Search,
  Loader2,
  User,
  Flag,
  Zap,
  Shield,
  Trash2,
  CheckCircle,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  Clock,
  ChevronDown,
} from "lucide-react";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
import { analyseInvoiceCredit } from "@/lib/creditAnalysis";
import { Tooltip as UITooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";
import { buildManualFlagFactor, buildManualFlagSummary } from "@/lib/manualFlagMessages";
import { cn } from "@/lib/utils";

const flagColors = {
  none: {
    bg: "bg-slate-500/15",
    text: "text-slate-400",
    border: "border-slate-500/30",
    label: "No Flag",
  },
  red: {
    bg: "bg-red-500/15",
    text: "text-red-400",
    border: "border-red-500/30",
    label: "Red",
  },
  green: {
    bg: "bg-green-500/15",
    text: "text-green-400",
    border: "border-green-500/30",
    label: "Green",
  },
  orange: {
    bg: "bg-orange-500/15",
    text: "text-orange-400",
    border: "border-orange-500/30",
    label: "Orange",
  },
};

function PaymentHistoryChartsLazy(props) {
  if (!props.lagData?.length && !props.timelineData?.length) return null;
  return (
    <Suspense fallback={<div className="mb-4 h-[152px] rounded-xl border border-border bg-muted/40" />}>
      <PaymentHistoryCharts {...props} />
    </Suspense>
  );
}

// ── flattenRecord — field-policy fallback ──────────────────────────────────
//
// Pre-refactor history (mid-2025): this function used a mix of `||` and `??`
// for fallback semantics, which produced inconsistent behaviour across
// fields. Code-review caught it — `outstanding_balance ?? data.outstanding_balance`
// preserves a real zero, but `age_current || data.age_current` would treat
// the string '0' as truthy yet treat `0` (number) or `''` as falsy. Each
// field had been added one at a time without thinking about the policy.
//
// The fix is one place: a small set of named policies, each with explicit
// fallback semantics. Every field declares which policy it uses; the
// flattener iterates the schema. Adding a field = one entry, not five
// `||` / `??` decisions.
//
// LEGACY FALLBACK NOTE — `record.data` is the deprecated JSON-blob column
// from a previous shape of `datarecord`. New syncs no longer write to it;
// it's preserved here as a fallback so historical rows still render correctly.
// Once `SELECT COUNT(*) FROM datarecord WHERE data IS NOT NULL AND data != '{}'
// AND data != '' AND updated_date > date('now', '-30 days')` returns 0 for
// every site, the whole `data?.X` half of every fallback can be deleted —
// `expandDataRecord` server-side already supplies the canonical fields.
//
//
// Policies:
//   text     — string-typed fields. Fallback when value is null, undefined,
//              OR empty string. Treats '' the same as missing because the
//              UI's intent for an empty customer_name is "show the fallback,"
//              not "render an empty cell."
//   numeric  — number-typed (or numeric-string) fields. Fallback ONLY when
//              null/undefined. A real `0` is preserved (R 0.00 is a valid
//              outstanding balance). Empty string from Sage's age columns
//              (which are TEXT in datarecord) IS treated as missing — the
//              canonical Sage shape for "no balance" is null, not ''.
//   nullable — like text but the final default is null instead of undefined.
//              Used for fields where the UI explicitly conditions on `=== null`.
//   enumDef  — like text but with an explicit default value (e.g. 'none' for
//              flag_color). The default applies after both record and data
//              have been checked.
const FIELD_POLICY = {
  text: 'text',
  numeric: 'numeric',
  nullable: 'nullable',
  enumDef: 'enumDef',
};

// Single source of truth for which fields get which policy. Order doesn't
// matter at runtime; alphabetical for readability.
const FIELD_POLICIES = {
  account_type:                  { policy: FIELD_POLICY.nullable },
  age_14_days:                   { policy: FIELD_POLICY.text },
  age_21_days:                   { policy: FIELD_POLICY.text },
  age_7_days:                    { policy: FIELD_POLICY.text },
  age_analysis:                  { policy: FIELD_POLICY.text },
  age_current:                   { policy: FIELD_POLICY.text },
  customer_name:                 { policy: FIELD_POLICY.text },
  customer_number:               { policy: FIELD_POLICY.text },
  flag_color:                    { policy: FIELD_POLICY.enumDef, default: 'none' },
  flag_created_by:               { policy: FIELD_POLICY.nullable },
  flag_reason:                   { policy: FIELD_POLICY.enumDef, default: '' },
  outstanding_balance:           { policy: FIELD_POLICY.numeric },
  sales_rep:                     { policy: FIELD_POLICY.nullable },
  terms:                         { policy: FIELD_POLICY.nullable },
};

// Generate the unpaid-invoice / receipt families programmatically. Five
// slots each, three sub-keys (number, amount, date) — repeating these in
// FIELD_POLICIES verbatim was the largest source of copy-paste drift in
// the original.
for (let n = 1; n <= 5; n++) {
  FIELD_POLICIES[`last_unpaid_invoice_${n}`]        = { policy: FIELD_POLICY.text };
  FIELD_POLICIES[`last_unpaid_invoice_${n}_amount`] = { policy: FIELD_POLICY.text };
  FIELD_POLICIES[`last_unpaid_invoice_${n}_date`]   = { policy: FIELD_POLICY.text };
  FIELD_POLICIES[`last_receipt_${n}`]               = { policy: FIELD_POLICY.text };
  FIELD_POLICIES[`last_receipt_${n}_amount`]        = { policy: FIELD_POLICY.text };
  FIELD_POLICIES[`last_receipt_${n}_date`]          = { policy: FIELD_POLICY.text };
}

// Two legacy shapes the original flattener handled inline: an older sync
// wrote `last_unpaid_invoice_date` (singular, no slot index) instead of
// `last_unpaid_invoice_1_date`, and `last_receipt_number` / `_amount` /
// `_date` instead of the `_1` versions. Capture them as named extras so
// the policy schema stays clean.
const LEGACY_FALLBACKS = {
  last_unpaid_invoice_1_date: ['last_unpaid_invoice_date'],
  last_receipt_1:             ['last_receipt_number'],
  last_receipt_1_amount:      ['last_receipt_amount'],
  last_receipt_1_date:        ['last_receipt_date'],
};

function _isMissingForText(value) {
  return value === undefined || value === null || value === '';
}
function _isMissingForNumeric(value) {
  // Treat empty string as missing for numeric fields too. Sage age/balance
  // columns are TEXT-typed in datarecord but the Sage convention for
  // "nothing there" is null; some upstream CSVs occasionally come through
  // as ''. Both should fall through to the fallback.
  return value === undefined || value === null || value === '';
}

function _resolveField(record, fieldName, policySpec) {
  const dataObj = record?.data;
  // Build the candidate chain in fallback order. The order MUST match the
  // pre-refactor original:
  //
  //   1. record.canonical          — newest top-level column
  //   2. record.data.canonical     — newest value inside the legacy data blob
  //   3. record.legacy             — old top-level alias (e.g. last_receipt_number)
  //   4. record.data.legacy        — old name inside the legacy data blob
  //
  // The reordering matters on upgraded DBs that still carry stale legacy
  // columns from the v2 backfill. If `record.legacy` were checked BEFORE
  // `record.data.canonical`, a stale `last_receipt_number` could shadow a
  // freshly-synced `data.last_receipt_1` and render outdated receipt /
  // invoice details. Caught in PR #212 review — an earlier draft of this
  // refactor had aliases-on-record sandwiched between `record.canonical`
  // and `data.canonical`, which inverted the original semantics.
  const aliases = LEGACY_FALLBACKS[fieldName] || [];
  const candidates = [
    record?.[fieldName],
    dataObj?.[fieldName],
    ...aliases.map((alias) => record?.[alias]),
    ...aliases.map((alias) => dataObj?.[alias]),
  ];
  const isMissing = policySpec.policy === FIELD_POLICY.numeric
    ? _isMissingForNumeric
    : _isMissingForText;

  for (const candidate of candidates) {
    if (!isMissing(candidate)) return candidate;
  }

  // Apply policy-specific final default.
  switch (policySpec.policy) {
    case FIELD_POLICY.enumDef:
      return policySpec.default;
    case FIELD_POLICY.numeric:
    case FIELD_POLICY.nullable:
      return null;
    case FIELD_POLICY.text:
    default:
      // Original behaviour: text fields with no value fall through to
      // undefined (the spread doesn't set them). Preserve that by
      // returning undefined — callers that want a string default should
      // use enumDef with default: ''.
      return undefined;
  }
}

function flattenRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const flat = { ...record };
  for (const [fieldName, policySpec] of Object.entries(FIELD_POLICIES)) {
    flat[fieldName] = _resolveField(record, fieldName, policySpec);
  }
  return flat;
}

function getVisibleAccountType(accountType) {
  const value = String(accountType || "").trim().toUpperCase();
  if (!value || value === "SUB_ACCOUNT") return null;
  return value;
}

// Returns the numeric prefix of a customer number (e.g. "157OC" → "157", "157" → "157")
function getNumericPrefix(custNum) {
  const m = String(custNum || "").match(/^(\d+)/);
  return m ? m[1] : null;
}

// True if the customer number is purely numeric (it's a parent)
function isParentCustNum(custNum) {
  return /^\d+$/.test(String(custNum || "").trim());
}

// Parse a numeric string to float, return 0 if invalid
function parseAmount(val) {
  if (!val || String(val).trim() === "") return 0;
  const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function formatAmount(val) {
  const n = parseAmount(val);
  if (n === 0 && (val === undefined || val === null || String(val).trim() === "")) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-R ${abs}` : `R ${abs}`;
}

async function fetchCustomerLookup(query) {
  const result = await api.records.customerLookup(query);
  return {
    record: result?.record ? flattenRecord(result.record) : null,
    subAccounts: Array.isArray(result?.subAccounts)
      ? result.subAccounts.map(flattenRecord)
      : [],
  };
}

async function fetchCustomerLookupSuggestions(query) {
  const result = await api.records.customerLookupSuggestions({ query, limit: 50 });
  return Array.isArray(result?.suggestions)
    ? result.suggestions.map(flattenRecord)
    : [];
}

async function updateLocalRecord(recordId, updateData) {
  const response = await fetch(`/api/datarecord/${recordId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(updateData),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to update record");
  }

  return result;
}

async function fetchRecordHistory(recordId) {
  const response = await fetch(`/api/datarecord/${recordId}/history`, {
    method: "GET",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to fetch record history");
  }

  return Array.isArray(result) ? result : [];
}

function formatHistoryAction(log) {
  if (!log) return "-";

  if (log.action_type === "update_flag") {
    try {
      const parsed =
        typeof log.changes === "string" ? JSON.parse(log.changes) : log.changes;

      const from = parsed?.field_changes?.flag_color?.from ?? "none";
      const to = parsed?.field_changes?.flag_color?.to ?? "none";
      const reason = parsed?.field_changes?.flag_reason?.to;

      let label = `Flag: ${from} → ${to}`;
      if (reason) label += ` · "${reason}"`;
      return label;
    } catch {
      return log.action_details || "Flag updated";
    }
  }

  return log.action_details || log.action_type || "Updated";
}

function formatHistoryDate(value) {
  if (!value) return "-";

  try {
    return new Date(value).toLocaleString("en-ZA", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function getHistoryFlagColor(log) {
  if (!log || log.action_type !== "update_flag") return null;
  try {
    const parsed =
      typeof log.changes === "string" ? JSON.parse(log.changes) : log.changes;
    return parsed?.field_changes?.flag_color?.to ?? null;
  } catch {
    return null;
  }
}

function getHistoryReasonSnippet(log) {
  if (!log || log.action_type !== "update_flag") return null;
  try {
    const parsed =
      typeof log.changes === "string" ? JSON.parse(log.changes) : log.changes;
    const reason = parsed?.field_changes?.flag_reason?.to;
    if (!reason) return null;
    return reason.length > 60 ? reason.slice(0, 57) + "…" : reason;
  } catch {
    return null;
  }
}


// ── Invoice Credit Analysis ────────────────────────────────────────────────

const verdictBannerStyles = {
  approve: "dark:bg-emerald-500/20 bg-emerald-50 border-emerald-500/40 dark:text-emerald-200 text-emerald-700",
  caution: "dark:bg-amber-500/20 bg-amber-50 border-amber-500/40 dark:text-amber-200 text-amber-700",
  hold: "dark:bg-red-500/20 bg-red-50 border-red-500/40 dark:text-red-200 text-red-700",
  dormant: "dark:bg-purple-500/20 bg-purple-50 border-purple-500/40 dark:text-purple-200 text-purple-700",
};

const verdictIcons = {
  approve: ShieldCheck,
  caution: AlertTriangle,
  hold: XCircle,
  dormant: Clock,
};

const verdictScoreStyles = {
  approve: "dark:bg-emerald-800/60 bg-emerald-100 dark:text-emerald-200 text-emerald-700 ring-1 ring-emerald-600/40",
  caution: "dark:bg-amber-800/60 bg-amber-100 dark:text-amber-200 text-amber-700 ring-1 ring-amber-600/40",
  hold: "dark:bg-red-800/60 bg-red-100 dark:text-red-200 text-red-700 ring-1 ring-red-600/40",
  dormant: "dark:bg-purple-800/60 bg-purple-100 dark:text-purple-200 text-purple-700 ring-1 ring-purple-600/40",
};

const flagDotColor = {
  none: "bg-slate-400",
  green: "bg-green-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
};

const flagPillStyles = {
  none: { base: "border-border text-muted-foreground", active: "dark:bg-slate-700 bg-slate-200 dark:border-slate-400 border-slate-400 dark:text-white text-slate-800 ring-2 ring-slate-400" },
  green: { base: "border-border text-muted-foreground", active: "dark:bg-green-900 bg-green-100 border-green-500 dark:text-green-200 text-green-800 ring-2 ring-green-500" },
  orange: { base: "border-border text-muted-foreground", active: "dark:bg-orange-900 bg-orange-100 border-orange-500 dark:text-orange-200 text-orange-800 ring-2 ring-orange-500" },
  red: { base: "border-border text-muted-foreground", active: "dark:bg-red-900 bg-red-100 border-red-500 dark:text-red-200 text-red-800 ring-2 ring-red-500" },
};

export default function CustomerLookup({
  onRecordSelect = null,
  triggerLookup,
  onLookupComplete,
  onFlagChange,
  currentUser: currentUserProp = null,
  // Embedded mode (Customer Balances row drill): mount only the modal
  // machinery — no search bar. The host page drives it via triggerLookup,
  // and closing the popup leaves the operator exactly where they were.
  hideSearchInput = false,
}) {
  const [customerNumber, setCustomerNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [customer, setCustomer] = useState(null);
  const [subAccounts, setSubAccounts] = useState([]);
  const [currentUser, setCurrentUser] = useState(currentUserProp);
  const [flagReason, setFlagReason] = useState("");
  const [isUpdatingFlag, setIsUpdatingFlag] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showRemovalModal, setShowRemovalModal] = useState(false);
  const [removalReason, setRemovalReason] = useState("");
  const [showPaymentLag, setShowPaymentLag] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [recordHistory, setRecordHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pendingFlagColor, setPendingFlagColor] = useState(null);
  const searchInputRef = useRef(null);
  const suggestionRequestIdRef = useRef(0);

  const closeAndReset = useCallback(() => {
    setCustomer(null);
    setSubAccounts([]);
    setCustomerNumber("");
    setFlagReason("");
    setIsModalOpen(false);
    setSuggestions([]);
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    setRecordHistory([]);
    setPendingFlagColor(null);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  const loadRecordHistory = useCallback(async (recordId) => {
    if (!recordId) return;

    setHistoryLoading(true);
    try {
      const history = await fetchRecordHistory(recordId);
      setRecordHistory(history);
    } catch (error) {
      console.error("Failed to fetch record history:", error);
      setRecordHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUserProp) {
      setCurrentUser(currentUserProp);
      return;
    }
    if (currentUser) return;
    const fetchUser = async () => {
      try {
        const user = await api.auth.me();
        setCurrentUser(user);
      } catch (error) {
        console.error("Failed to fetch user:", error);
      }
    };
    fetchUser();
  }, [currentUser, currentUserProp]);

  useEffect(() => {
    if (!triggerLookup) return;
    handleLookup(triggerLookup);
  // We intentionally only re-run when triggerLookup changes, passing the value directly
   
  }, [triggerLookup]);

  useEffect(() => {
    if (customerNumber.trim().length === 0) {
      suggestionRequestIdRef.current += 1;
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const requestId = suggestionRequestIdRef.current + 1;
    suggestionRequestIdRef.current = requestId;

    const timer = setTimeout(() => {
      fetchCustomerLookupSuggestions(customerNumber)
        .then((matches) => {
          if (suggestionRequestIdRef.current !== requestId) return;
          const nextSuggestions = matches.map((record) => ({
            record,
            customerNumber: String(record.customer_number || ""),
            customerName: String(record.customer_name || ""),
          }));
          setSuggestions(nextSuggestions);
          setSelectedSuggestionIndex(-1);
          setShowSuggestions(nextSuggestions.length > 0);
        })
        .catch((error) => {
          if (suggestionRequestIdRef.current !== requestId) return;
          console.error("Failed to fetch customer lookup suggestions:", error);
          setSuggestions([]);
          setShowSuggestions(false);
        });
    }, 200);

    return () => clearTimeout(timer);
  }, [customerNumber]);

  const handleLookup = async (customNumber = null) => {
    const numberToSearch = String(
      customNumber !== null && customNumber !== undefined
        ? customNumber
        : customerNumber
    ).trim();

    if (!numberToSearch) {
      toast.error("Please enter a customer number");
      return;
    }

    setLoading(true);
    setShowSuggestions(false);

    try {
      const { record, subAccounts: matchedSubAccounts } = await fetchCustomerLookup(numberToSearch);

      if (!record) {
        toast.error("Customer not found");
        setLoading(false);
        return;
      }

      setCustomer(record);
      setFlagReason(record.flag_reason || "");
      setIsModalOpen(true);
      loadRecordHistory(record.id);

      const custNum = String(record.customer_number || "").trim();
      const prefix = getNumericPrefix(custNum);
      if (prefix) {
        setSubAccounts(matchedSubAccounts.filter((r) => {
          const cn = String(r.customer_number || "").trim();
          return cn !== custNum && getNumericPrefix(cn) === prefix;
        }));
      } else {
        setSubAccounts([]);
      }

      if (onRecordSelect) onRecordSelect(record);
      if (onLookupComplete) onLookupComplete(record);
    } catch (error) {
      toast.error(error.message || "Lookup failed");
    }

    setLoading(false);
  };

  const handleSuggestionClick = (suggestion) => {
    setCustomerNumber(suggestion.customerNumber);
    setShowSuggestions(false);
    handleLookup(suggestion.customerNumber);
  };

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestionIndex((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : prev
      );
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : -1));
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (selectedSuggestionIndex >= 0) {
        const suggestion = suggestions[selectedSuggestionIndex];
        handleSuggestionClick(suggestion);
      } else {
        handleLookup();
      }
    }

    if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  const { data: creditLogicState } = useQuery({
    queryKey: ["creditLogicCurrent"],
    queryFn: async () => {
      const response = await fetch("/api/credit-logic/current", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load credit logic");
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  // Memoize credit analysis so it doesn't recalculate on every render
  const creditAnalysis = useMemo(() => {
    if (!customer) return null;
    const allAccountRecords = [customer, ...subAccounts].filter(Boolean);
    // Map auditlog entries to the shape analyseInvoiceCredit expects: { action, new_value }
    const flagHistory = recordHistory
      .filter(e => e.action_type === 'update_flag')
      .map(e => {
        let new_value = null;
        try {
          const ch = typeof e.changes === 'string' ? JSON.parse(e.changes) : (e.changes || {});
          new_value = ch.flag_color || ch.to || null;
        } catch {} // eslint-disable-line no-empty -- JSON parse fallback; null new_value is the documented contract
        return { action: 'flag_changed', new_value };
      });
    const activeLogicConfig = creditLogicState?.analysis?.config || DEFAULT_CREDIT_LOGIC_CONFIG;
    const activeLogicVersion = creditLogicState?.analysis?.version || null;
    const analysis = {
      ...analyseInvoiceCredit(allAccountRecords, flagHistory, activeLogicConfig),
      logicVersionUsed: activeLogicVersion,
    };

    // User-set flags are hard overrides — no analysis can outrank a human decision.
    // auto_flagged = true means the flag was set by rules, not a human; human flags always win.
    // Check the entire account family (parent + children) so a manual flag on any
    // member applies regardless of which account was looked up.
    const manualRedRecord = allAccountRecords.find(r => r.flag_color === "red" && !r.auto_flagged);
    const manualOrangeRecord = !manualRedRecord
      ? allAccountRecords.find(r => r.flag_color === "orange" && !r.auto_flagged)
      : null;

    if (manualRedRecord && analysis.verdict !== "hold") {
      return {
        ...analysis,
        verdict: "hold",
        title: "Hold — Manually Flagged",
        summary: buildManualFlagSummary("red", manualRedRecord.flag_created_by),
        factors: [
          { type: "block", text: buildManualFlagFactor("red", manualRedRecord.flag_created_by) },
          ...analysis.factors,
        ],
      };
    }

    if (manualOrangeRecord && analysis.verdict === "approve") {
      return {
        ...analysis,
        verdict: "caution",
        title: "Proceed with Caution — Manually Flagged",
        summary: buildManualFlagSummary("orange", manualOrangeRecord.flag_created_by),
        factors: [
          { type: "warn", text: buildManualFlagFactor("orange", manualOrangeRecord.flag_created_by) },
          ...analysis.factors,
        ],
      };
    }

    // Dormant reactivation: latest invoice >12 months after previous invoice.
    // Only applied if the analysis is already Approve (red/orange override first).
    if (
      analysis.isDormantReactivation &&
      analysis.verdict === "approve" &&
      !manualRedRecord &&
      !manualOrangeRecord
    ) {
      return {
        ...analysis,
        verdict: "dormant",
        title: "Dormant Account — Reactivation",
        summary: `This customer has not bought in over ${analysis.dormantMonths} months. Verify account details and intent before invoicing.`,
        factors: [
          { type: "warn", text: `Latest invoice is over ${analysis.dormantMonths} months after the previous one — customer was dormant.` },
          ...analysis.factors,
        ],
      };
    }

    return analysis;
  }, [customer, subAccounts, recordHistory, creditLogicState]);

  const canModifyFlag = () => {
    if (!customer || !currentUser) return false;
    if (currentUser.role === "admin") return true;
    if (customer.flag_created_by === currentUser.email) return true;
    if (!customer.flag_color || customer.flag_color === "none") return true;
    return false;
  };

  const handleFlagChange = async (color, explicitReason) => {
    if (!customer || !currentUser) return;

    setIsUpdatingFlag(true);

    try {
      const updateData = {
        flag_color: color,
        flag_reason: explicitReason !== undefined ? explicitReason : (flagReason || ""),
        flag_created_by: color !== "none" ? currentUser.email : null,
        auto_flagged: false,
      };

      await updateLocalRecord(customer.id, updateData);

      const updatedCustomer = {
        ...customer,
        ...updateData,
      };

      setCustomer(updatedCustomer);

      await loadRecordHistory(customer.id);
      setFlagReason("");
      setPendingFlagColor(null);
      if (onFlagChange) onFlagChange({ id: customer.id, ...updateData });
      toast.success("Flag updated");
    } catch (error) {
      toast.error(error.message || "Failed to update flag");
    } finally {
      setIsUpdatingFlag(false);
    }
  };

  // Intercept Remove for orange/red — require a mandatory reason
  const handleRemoveFlagClick = () => {
    const color = customer?.flag_color;
    if (color === "orange" || color === "red") {
      setRemovalReason("");
      setShowRemovalModal(true);
    } else {
      handleFlagChange("none");
    }
  };

  const handleRemovalConfirm = async () => {
    if (!removalReason.trim()) return;
    setShowRemovalModal(false);
    await handleFlagChange("none", removalReason.trim());
    setRemovalReason("");
  };

  const handleApplyFlag = () => {
    if (!pendingFlagColor) return;
    if (pendingFlagColor === "none") {
      handleRemoveFlagClick();
    } else {
      handleFlagChange(pendingFlagColor);
    }
  };

  // ── Derived data for modal body ──────────────────────────────────────────
  const allAccounts = customer
    ? [
        { label: String(customer.customer_number || ""), record: customer, isMain: true },
        ...subAccounts.map((r) => ({
          label: String(r.customer_number || ""),
          record: r,
          isMain: false,
        })),
      ]
    : [];

  const hasSubAccounts = subAccounts.length > 0;
  const grandTotal = allAccounts.reduce((s, { record: r }) => s + parseAmount(r?.outstanding_balance), 0);

  const invoiceSlots = [1,2,3].map(i => ({
    numField: `last_unpaid_invoice_${i}`,
    amtField: `last_unpaid_invoice_${i}_amount`,
    dateField: `last_unpaid_invoice_${i}_date`,
  }));
  const receiptSlots = [1,2,3].map(i => ({
    numField: `last_receipt_${i}`,
    amtField: `last_receipt_${i}_amount`,
    dateField: `last_receipt_${i}_date`,
  }));

  const renderGroupedTable = ({ title, icon: Icon, iconColor, accounts: allAccts, slots }) => {
    // Only show accounts with a real net balance. If the open items net to
    // ~zero (e.g. an invoice offset by an unapplied credit), nothing is truly
    // outstanding, so show nothing for that account.
    const accounts = allAccts.filter(({ record: r }) => Math.abs(parseAmount(r?.outstanding_balance)) > 0.02);
    const activeSlots = slots.filter(({ numField }) =>
      accounts.some(({ record: r }) => r?.[numField])
    );
    if (activeSlots.length === 0) return null;
    return (
      <div className="bg-card border border-border rounded-xl p-4 mb-3">
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
          <Icon className={cn("h-4 w-4", iconColor)} />
          {title}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-sm font-semibold text-muted-foreground uppercase tracking-wide pb-2 pr-4">Number</th>
                <th className="text-right text-sm font-semibold text-muted-foreground uppercase tracking-wide pb-2 pr-4">Amount</th>
                <th className="text-right text-sm font-semibold text-muted-foreground uppercase tracking-wide pb-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(({ label, record: r }) => {
                const rows = activeSlots
                  .map(({ numField, amtField, dateField }, i) => {
                    const ref = r?.[numField];
                    const amt = r?.[amtField];
                    const date = r?.[dateField];
                    // Only show genuine open items: must have a document number,
                    // and skip rounding-level residue (|amount| <= R0.02). This
                    // also drops stale member rows that carry a date but no doc.
                    if (!ref || Math.abs(parseAmount(amt)) <= 0.02) return null;
                    return (
                      <tr key={`${label}-${i}`} className="border-b border-border/50 last:border-0">
                        <td className={cn("text-sm py-1 pr-4 font-mono max-w-[120px] truncate", iconColor)}>{ref || "—"}</td>
                        <td className={cn("text-sm py-1 pr-4 text-right", parseAmount(amt) !== 0 ? "text-foreground" : "text-muted-foreground")}>{formatAmount(amt)}</td>
                        <td className={cn("text-sm py-1 text-right", date ? "text-foreground" : "text-muted-foreground")}>{date || "—"}</td>
                      </tr>
                    );
                  })
                  .filter(Boolean);
                if (rows.length === 0) return null;
                return [
                  accounts.length > 1 && (
                    <tr key={`sep-${label}`}>
                      <td colSpan={3} className="pt-2 pb-1">
                        <span className="text-sm font-medium text-muted-foreground">{label}</span>
                      </td>
                    </tr>
                  ),
                  ...rows,
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className={hideSearchInput ? undefined : "space-y-4"}>
      {/* ── Search bar ── */}
      {!hideSearchInput && (
      <div className="relative bg-card p-5" style={{ borderRadius: "12px" }}>
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-3">Customer Lookup</p>
        <div className="flex gap-2.5">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              ref={searchInputRef}
              value={customerNumber}
              onChange={(e) => setCustomerNumber(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Customer number or name…"
              className="h-11 border border-border bg-background pl-10 text-foreground placeholder:text-muted-subtle focus:border-[var(--phosphor)] focus:ring-[var(--phosphor)]/30 text-sm font-mono"
              style={{ borderRadius: "12px" }}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div
                className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden bg-background"
                style={{
                  borderRadius: "12px",
                  border: "1px solid hsl(var(--border))",
                  boxShadow: "0 12px 32px rgba(0,0,0,0.55), 0 0 0 1px hsla(33,95%,55%,0.12), 0 0 24px hsla(33,95%,55%,0.08)",
                }}
              >
                {suggestions.map((s, idx) => (
                  <button
                    key={s.record.id ?? idx}
                    onClick={() => handleSuggestionClick(s)}
                    className={cn(
                      "w-full border-b border-border/60 px-4 py-3 text-left last:border-0 transition-colors relative",
                      idx === selectedSuggestionIndex
                        ? "bg-accent/15 text-foreground"
                        : "hover:bg-muted/40 text-foreground"
                    )}
                  >
                    {idx === selectedSuggestionIndex && (
                      <span className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: "var(--phosphor)", boxShadow: "0 0 10px hsla(33,95%,55%,0.4)" }} />
                    )}
                    <div className="text-sm font-semibold leading-tight">{s.customerName || <span className="text-muted-foreground italic">(no name)</span>}</div>
                    <div className="font-mono text-[11px] tracking-wider text-muted-foreground mt-1">
                      {s.customerNumber ? `#${s.customerNumber}` : '—'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button
            onClick={() => handleLookup()}
            disabled={loading}
            className="h-11 px-5 transition-all"
            style={{
              borderRadius: "12px",
              border: "1px solid var(--phosphor)",
              color: "var(--phosphor)",
              background: "hsla(33, 95%, 55%, 0.10)",
            }}
            onMouseEnter={(e) => {
              if (e.currentTarget.disabled) return;
              e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.20)";
              e.currentTarget.style.boxShadow = "0 0 12px hsla(33,95%,55%,0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.10)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
      )}

      {/* ── Main Customer Modal ── */}
      <Dialog
        open={isModalOpen}
        onOpenChange={(open) => {
          if (!open) closeAndReset();
        }}
      >
        <DialogContent
          onKeyDown={(e) => {
            if (e.key === "Escape" && e.target.tagName !== "TEXTAREA") {
              closeAndReset();
            }
          }}
          className="max-w-[960px] w-full p-0 flex flex-col max-h-[90dvh] border border-border bg-background"
          style={{
            // Customer flag colour is communicated via the left strip when set;
            // unflagged customers get a neutral border (no amber accent).
            borderLeftWidth: customer?.flag_color && customer.flag_color !== 'none' ? '3px' : '1px',
            borderLeftColor: customer?.flag_color === 'red'    ? 'hsl(0 72% 50%)'
                            : customer?.flag_color === 'orange' ? 'var(--phosphor)'
                            : customer?.flag_color === 'green'  ? 'hsl(145 55% 45%)'
                            : 'hsl(var(--border))',
            boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{customer?.customer_name || "Customer"}</DialogTitle>
          </DialogHeader>

          {/* ── 1. Verdict Banner ── */}
          {creditAnalysis ? (
            <div className={cn(
              "w-full px-5 py-4 border-b shrink-0",
              verdictBannerStyles[creditAnalysis.verdict] || "bg-muted/30 border-border text-muted-foreground"
            )}>
              <div className="flex items-start gap-2 sm:gap-3.5 flex-wrap sm:flex-nowrap">
                {creditAnalysis.verdict === "approve" && <ShieldCheck className="h-8 w-8 shrink-0 opacity-90 mt-0.5" strokeWidth={1.75} />}
                {creditAnalysis.verdict === "caution" && <AlertTriangle className="h-8 w-8 shrink-0 opacity-90 mt-0.5" strokeWidth={1.75} />}
                {creditAnalysis.verdict === "hold" && <XCircle className="h-8 w-8 shrink-0 opacity-90 mt-0.5" strokeWidth={1.75} />}
                {creditAnalysis.verdict === "dormant" && <Clock className="h-8 w-8 shrink-0 opacity-90 mt-0.5" strokeWidth={1.75} />}
                <div className="flex-1 min-w-0">
                  <span className="text-base sm:text-lg font-extrabold tracking-tight leading-tight">{creditAnalysis.title}</span>
                  {creditAnalysis.summary && (
                    <p className="text-xs sm:text-sm font-semibold mt-1 leading-snug opacity-90">{creditAnalysis.summary}</p>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2 sm:gap-4 shrink-0 pr-10 sm:pr-14">
                  {creditAnalysis.avgLag !== null && creditAnalysis.avgLag !== undefined && (
                    <UITooltip>
                      <TooltipTrigger asChild>
                        <span className={cn("hidden sm:inline-flex text-base font-bold px-4 py-1.5 rounded-full cursor-default", verdictScoreStyles[creditAnalysis.verdict] || "bg-muted text-muted-foreground")}>
                          ⏱ {creditAnalysis.avgLag}d avg
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Average days between invoice and receipt payment for this customer</TooltipContent>
                    </UITooltip>
                  )}
                  <UITooltip>
                    <TooltipTrigger asChild>
                      <span className={cn(
                        "text-xs font-semibold px-3 py-1.5 rounded-full cursor-default",
                        verdictScoreStyles[creditAnalysis.verdict] || "bg-muted text-muted-foreground"
                      )}>
                        {creditAnalysis.score}/100
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Credit score: {creditAnalysis.score}/100 — higher is better creditworthiness</TooltipContent>
                  </UITooltip>
                </div>
              </div>
            </div>
          ) : (
            <div className="w-full px-5 py-4 border-b border-border bg-muted/30 shrink-0">
              <div className="flex items-center gap-4 animate-pulse">
                <div className="h-8 w-12 bg-muted rounded" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 bg-muted rounded" />
                  <div className="h-3 w-48 bg-muted rounded" />
                </div>
              </div>
            </div>
          )}

          {/* ── 2. Pinned header + scrollable invoices/receipts ── */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Pinned: customer header card */}
            <div className="shrink-0 px-5 pt-4 pb-0">
            <div className="bg-card border border-border rounded-xl p-4 mb-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <User className="hidden sm:block h-6 w-6 text-muted-foreground shrink-0 mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="text-xl font-bold text-foreground leading-tight">{customer?.customer_name}</div>
                  <div className="text-sm text-muted-foreground mt-0.5">Account #{customer?.customer_number}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {customer?.sales_rep && (
                      <Badge variant="outline" className="text-xs cursor-default">
                        Sales Rep: {customer.sales_rep}
                      </Badge>
                    )}
                    {getVisibleAccountType(customer?.account_type) && (
                      <Badge variant="outline" className="text-xs cursor-default">
                        Account Type: {getVisibleAccountType(customer.account_type)}
                      </Badge>
                    )}
                  </div>
                  {hasSubAccounts && (
                    <div className="mt-3 space-y-1">
                      {allAccounts.map(({ label, record: r, isMain }) => (
                        <div key={label} className="flex justify-between text-sm">
                          <span className={isMain ? "text-foreground font-medium" : "text-muted-foreground"}>{label}</span>
                          <span className={parseAmount(r?.outstanding_balance) !== 0 ? "text-foreground" : "text-muted-foreground"}>
                            {formatAmount(r?.outstanding_balance)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <p className={cn("text-2xl sm:text-3xl font-bold tabular-nums", grandTotal !== 0 ? "text-foreground" : "text-muted-foreground")}>
                    {formatAmount(String(hasSubAccounts ? grandTotal : (customer?.outstanding_balance ?? 0)))}
                  </p>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">Outstanding</p>
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    {customer?.terms && (
                      <UITooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="text-xs cursor-default">
                            {customer.terms}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>Payment terms agreed with this customer</TooltipContent>
                      </UITooltip>
                    )}
                    {hasSubAccounts && (
                      <Badge variant="outline" className="text-xs border-accent/50 text-accent">
                        Hub · {subAccounts.length} sub-account{subAccounts.length > 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Auto-flag banner */}
            {!!customer?.auto_flagged && (
              <div className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium mb-3",
                customer?.flag_color === "red" && "dark:bg-red-950/70 bg-red-50 border-red-700 dark:text-red-300 text-red-700",
                customer?.flag_color === "green" && "dark:bg-green-950/70 bg-green-50 border-green-700 dark:text-green-300 text-green-700",
                customer?.flag_color === "orange" && "dark:bg-orange-950/70 bg-orange-50 border-orange-700 dark:text-orange-300 text-orange-700",
                (!customer?.flag_color || customer?.flag_color === "none") && "dark:bg-slate-800 bg-slate-100 dark:border-slate-600 border-slate-300 dark:text-slate-300 text-slate-700",
              )}>
                <Zap className="w-4 h-4 shrink-0" />
                <span>Auto-flagged</span>
                {customer?.flag_reason && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="opacity-80">{customer.flag_reason.replace(/^Auto-flagged:\s*/i, "")}</span>
                  </>
                )}
              </div>
            )}

            </div>{/* end pinned header */}

            {/* Scrollable: invoices + receipts */}
            <div className="flex-1 overflow-y-auto px-5 pt-1 pb-3">

            {/* Invoices + Receipts side by side */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
              <div>{renderGroupedTable({
                title: "Invoices",
                icon: Flag,
                iconColor: "text-orange-400",
                accounts: allAccounts,
                slots: invoiceSlots,
              })}</div>
              <div>{renderGroupedTable({
                title: "Receipts",
                icon: CheckCircle,
                iconColor: "text-emerald-400",
                accounts: allAccounts,
                slots: receiptSlots,
              })}</div>
            </div>

            {/* Payment History Charts — collapsible */}
            {creditAnalysis && (creditAnalysis.lagData?.length > 0 || creditAnalysis.timelineData?.length > 0) && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowPaymentLag(prev => !prev)}
                  className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-2"
                >
                  <ChevronDown className={cn("w-4 h-4 transition-transform", !showPaymentLag && "-rotate-90")} />
                  Payment History
                </button>
                {showPaymentLag && (
                  <PaymentHistoryChartsLazy
                    lagData={creditAnalysis.lagData || []}
                    timelineData={creditAnalysis.timelineData || []}
                  />
                )}
              </div>
            )}

            </div>{/* end scrollable invoices/receipts */}
          </div>{/* end pinned+scroll wrapper */}

          {/* ── 3. Sticky Flag Bar ── */}
          <div className="shrink-0 bg-card border-t border-border px-4 py-3">
            <div className="flex items-center gap-2 flex-wrap">
              {!canModifyFlag() && customer?.flag_color !== "none" && (
                <Badge variant="outline" className="border-border text-sm text-muted-foreground mr-2">
                  <Shield className="mr-1 h-3 w-3" />
                  Protected
                </Badge>
              )}
              {["none", "green", "orange", "red"].map((color) => {
                const isActive = pendingFlagColor === color;
                const isCurrent = customer?.flag_color === color || (!customer?.flag_color && color === "none");
                const styles = flagPillStyles[color];
                const tipMap = {
                  none: "Clear flag — remove any existing flag from this customer",
                  green: "Green — mark customer as approved / good standing",
                  orange: "Orange — mark customer as requiring attention or caution",
                  red: "Red — mark customer as blocked or high-risk",
                };
                return (
                  <UITooltip key={color}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setPendingFlagColor(color)}
                        disabled={!canModifyFlag() || isUpdatingFlag}
                        className={cn(
                          "rounded-full px-4 py-2.5 text-sm font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed min-w-[72px] min-h-[44px] justify-center",
                          isActive ? styles.active : styles.base,
                          isCurrent && !isActive && "ring-1 ring-white/30"
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", flagDotColor[color])} />
                          {flagColors[color].label}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{tipMap[color]}</TooltipContent>
                  </UITooltip>
                );
              })}
            </div>

            {pendingFlagColor && (
              <div className="mt-3 space-y-2">
                <Textarea
                  value={flagReason}
                  onChange={(e) => setFlagReason(e.target.value)}
                  placeholder="Reason for flag change..."
                  className="h-16 resize-none border-border bg-background text-sm placeholder:text-muted-foreground"
                  disabled={isUpdatingFlag}
                />
                <Button
                  onClick={handleApplyFlag}
                  disabled={isUpdatingFlag}
                >
                  {isUpdatingFlag ? (
                    <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Applying…</>
                  ) : (
                    "Apply"
                  )}
                </Button>
              </div>
            )}

            {/* Last 3 flag history entries */}
            {recordHistory.length > 0 && (
              <div className={cn("space-y-1 border-t border-border/40 pt-2", pendingFlagColor ? "mt-3" : "mt-2")}>
                {recordHistory.slice(0, 3).map((log) => {
                  const toColor = getHistoryFlagColor(log);
                  const snippet = getHistoryReasonSnippet(log);
                  return (
                    <div key={log.id} className="flex items-center gap-2 text-muted-foreground">
                      <span className="text-xs shrink-0">{formatHistoryDate(log.created_date)}</span>
                      <span className="text-xs shrink-0">{log.user_name || log.user_email || "?"}</span>
                      {toColor && <span className={cn("h-2 w-2 rounded-full shrink-0", flagDotColor[toColor] || "bg-slate-400")} />}
                      {snippet && <span className="text-xs truncate max-w-[200px]">{snippet}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {historyLoading && <p className="text-sm text-muted-foreground mt-2">Loading history…</p>}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Flag Removal Reason Modal ── */}
      <Dialog open={showRemovalModal} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-md bg-card border-rose-700 [&>button]:hidden"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Trash2 className="h-4 w-4 text-rose-400" />
              Remove Flag — Reason Required
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              You are removing a{" "}
              <span className={customer?.flag_color === "red" ? "font-semibold text-red-400" : "font-semibold text-orange-400"}>
                {customer?.flag_color}
              </span>{" "}
              flag. A reason is mandatory before this can be completed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <Label className="text-sm text-gray-300">
                Removal reason <span className="text-rose-400">*</span>
              </Label>
              <Textarea
                value={removalReason}
                onChange={(e) => setRemovalReason(e.target.value)}
                placeholder="Enter the reason for removing this flag…"
                className="h-24 resize-none border-border bg-muted text-sm text-foreground placeholder:text-muted-foreground focus:border-rose-600"
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  setShowRemovalModal(false);
                  setRemovalReason("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleRemovalConfirm}
                disabled={!removalReason.trim() || isUpdatingFlag}
                className="bg-rose-700 hover:bg-rose-600 text-white disabled:opacity-50"
              >
                {isUpdatingFlag ? (
                  <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Removing…</>
                ) : (
                  <>Confirm Removal</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
