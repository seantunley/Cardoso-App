import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
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
  Calendar,
  Flag,
  Shield,
  Trash2,
  History,
  CheckCircle,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const flagColors = {
  none: {
    bg: "bg-slate-100",
    text: "text-slate-500",
    border: "border-slate-200",
    label: "No Flag",
  },
  red: {
    bg: "bg-red-100",
    text: "text-red-700",
    border: "border-red-200",
    label: "Red",
  },
  green: {
    bg: "bg-green-100",
    text: "text-green-700",
    border: "border-green-200",
    label: "Green",
  },
  orange: {
    bg: "bg-orange-100",
    text: "text-orange-700",
    border: "border-orange-200",
    label: "Orange",
  },
};

function flattenRecord(record) {
  return {
    ...record,
    customer_number: record.customer_number || record.data?.customer_number,
    customer_name: record.customer_name || record.data?.customer_name,
    age_analysis: record.age_analysis || record.data?.age_analysis,
    age_current: record.age_current || record.data?.age_current,
    age_7_days: record.age_7_days || record.data?.age_7_days,
    age_14_days: record.age_14_days || record.data?.age_14_days,
    age_21_days: record.age_21_days || record.data?.age_21_days,
    flag_color: record.flag_color || record.data?.flag_color || "none",
    flag_reason: record.flag_reason || record.data?.flag_reason || "",
    flag_created_by: record.flag_created_by || record.data?.flag_created_by || null,
    last_unpaid_invoice_1:
      record.last_unpaid_invoice_1 || record.data?.last_unpaid_invoice_1,
    last_unpaid_invoice_1_amount:
      record.last_unpaid_invoice_1_amount || record.data?.last_unpaid_invoice_1_amount,
    last_unpaid_invoice_date:
      record.last_unpaid_invoice_date || record.data?.last_unpaid_invoice_date,
    last_receipt_number:
      record.last_receipt_number || record.data?.last_receipt_number,
    last_receipt_amount:
      record.last_receipt_amount || record.data?.last_receipt_amount,
    last_receipt_date:
      record.last_receipt_date || record.data?.last_receipt_date,
    outstanding_balance:
      record.outstanding_balance || record.data?.outstanding_balance,
  };
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

async function fetchLocalRecords() {
  const response = await fetch("/api/datarecord", {
    method: "GET",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to fetch records");
  }

  return Array.isArray(result) ? result.map(flattenRecord) : [];
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

      return `Flag changed ${from} → ${to}`;
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

export default function CustomerLookup({
  onRecordSelect,
  triggerLookup,
  onLookupComplete,
}) {
  const [customerNumber, setCustomerNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [customer, setCustomer] = useState(null);
  const [subAccounts, setSubAccounts] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [flagReason, setFlagReason] = useState("");
  const [isUpdatingFlag, setIsUpdatingFlag] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [allRecords, setAllRecords] = useState([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [recordHistory, setRecordHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const searchInputRef = useRef(null);

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
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  const refreshRecords = useCallback(async () => {
    try {
      const records = await fetchLocalRecords();
      setAllRecords(records);
      return records;
    } catch (error) {
      console.error("Failed to fetch records:", error);
      toast.error(error.message || "Failed to fetch records");
      return [];
    }
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
    const fetchUser = async () => {
      try {
        const user = await base44.auth.me();
        setCurrentUser(user);
      } catch (error) {
        console.error("Failed to fetch user:", error);
      }
    };
    fetchUser();
  }, []);

  useEffect(() => {
    refreshRecords();
  }, [refreshRecords]);

  useEffect(() => {
    if (!triggerLookup) return;
    handleLookup(triggerLookup);
  // We intentionally only re-run when triggerLookup changes, passing the value directly
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerLookup]);

  const fuzzyMatch = (str, pattern) => {
    if (!str || !pattern) return { matches: false, score: 0 };

    const strLower = str.toLowerCase();
    const patternLower = pattern.toLowerCase();

    if (strLower === patternLower) return { matches: true, score: 1000 };
    if (strLower.includes(patternLower)) return { matches: true, score: 500 };

    let patternIdx = 0;
    let score = 0;
    let consecutiveMatches = 0;

    for (let i = 0; i < strLower.length && patternIdx < patternLower.length; i++) {
      if (strLower[i] === patternLower[patternIdx]) {
        score += 1 + consecutiveMatches;
        consecutiveMatches++;
        patternIdx++;
      } else {
        consecutiveMatches = 0;
      }
    }

    const matches = patternIdx === patternLower.length;
    return { matches, score };
  };

  useEffect(() => {
    if (customerNumber.trim().length === 0) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const searchTerm = customerNumber.trim();
    const matches = [];

    allRecords.forEach((record) => {
      const custNum = record.customer_number || "";
      const custName = record.customer_name || "";

      const numMatch = fuzzyMatch(String(custNum), searchTerm);
      const nameMatch = fuzzyMatch(String(custName), searchTerm);

      if (numMatch.matches || nameMatch.matches) {
        matches.push({
          record,
          score: Math.max(numMatch.score, nameMatch.score),
          customerNumber: String(custNum),
          customerName: String(custName),
        });
      }
    });

    matches.sort((a, b) => b.score - a.score);
    setSuggestions(matches.slice(0, 5));
    setSelectedSuggestionIndex(-1);
    setShowSuggestions(matches.length > 0);
  }, [customerNumber, allRecords]);

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
      const freshRecords = await refreshRecords();

      const record = freshRecords.find(
        (r) =>
          String(r.customer_number || "").trim() === numberToSearch ||
          String(r.customer_name || "").trim().toLowerCase() === numberToSearch.toLowerCase()
      );

      if (!record) {
        toast.error("Customer not found");
        setLoading(false);
        return;
      }

      setCustomer(record);
      setFlagReason(record.flag_reason || "");
      setIsModalOpen(true);
      loadRecordHistory(record.id);

      // If this is a parent account (purely numeric), find sub-accounts
      const custNum = String(record.customer_number || "").trim();
      if (isParentCustNum(custNum)) {
        const children = freshRecords.filter((r) => {
          const cn = String(r.customer_number || "").trim();
          return cn !== custNum && getNumericPrefix(cn) === custNum;
        });
        setSubAccounts(children);
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

  const canModifyFlag = () => {
    if (!customer || !currentUser) return false;
    if (currentUser.role === "admin") return true;
    if (customer.flag_created_by === currentUser.email) return true;
    if (!customer.flag_color || customer.flag_color === "none") return true;
    return false;
  };

  const handleFlagChange = async (color) => {
    if (!customer || !currentUser) return;

    setIsUpdatingFlag(true);

    try {
      const updateData = {
        flag_color: color,
        flag_reason: flagReason || "",
        flag_created_by: color !== "none" ? currentUser.email : null,
        auto_flagged: false,
      };

      await updateLocalRecord(customer.id, updateData);

      const updatedCustomer = {
        ...customer,
        ...updateData,
      };

      setCustomer(updatedCustomer);

      setAllRecords((prev) =>
        prev.map((record) =>
          record.id === customer.id ? { ...record, ...updateData } : record
        )
      );

      setFlagReason("");
      await loadRecordHistory(customer.id);
      toast.success("Flag updated");
    } catch (error) {
      toast.error(error.message || "Failed to update flag");
    } finally {
      setIsUpdatingFlag(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative rounded-xl border border-slate-700/50 bg-gradient-to-br from-slate-900 via-slate-800/90 to-slate-900 p-5 shadow-xl">
        {/* subtle top accent line */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent" />
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-3">Customer Lookup</p>
        <div className="flex gap-2.5">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              ref={searchInputRef}
              value={customerNumber}
              onChange={(e) => setCustomerNumber(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Customer number or name…"
              className="h-11 border border-slate-600/60 bg-slate-950/70 pl-10 text-white placeholder:text-slate-500 focus:border-indigo-500/70 focus:ring-indigo-500/20 rounded-lg text-sm"
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1.5 rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden">
                {suggestions.map((s, idx) => (
                  <button
                    key={s.record.id ?? idx}
                    onClick={() => handleSuggestionClick(s)}
                    className={cn(
                      "w-full border-b border-slate-800/60 px-4 py-2.5 text-left last:border-0 transition-colors",
                      idx === selectedSuggestionIndex
                        ? "bg-indigo-600/30 text-white"
                        : "hover:bg-slate-800/70 text-slate-200"
                    )}
                  >
                    <div className="text-sm font-medium">{s.customerName}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">#{s.customerNumber}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button
            onClick={() => handleLookup()}
            disabled={loading}
            className="h-11 px-5 bg-indigo-600 hover:bg-indigo-500 text-white border-0 rounded-lg shadow-md shadow-indigo-900/40 transition-all"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <Dialog
        open={isModalOpen}
        onOpenChange={(open) => {
          if (!open) closeAndReset();
        }}
      >
        <DialogContent
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === "Escape") && e.target.tagName !== "TEXTAREA") {
              closeAndReset();
            }
          }}
          className={cn(
            "max-w-2xl border-4 bg-gray-900 max-h-[90vh] flex flex-col",
            customer?.flag_color === "red" && "border-red-500",
            customer?.flag_color === "green" && "border-green-500",
            customer?.flag_color === "orange" && "border-orange-500",
            (!customer?.flag_color || customer?.flag_color === "none") && "border-gray-700"
          )}
        >
          <DialogHeader className="pb-0">
            <DialogTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-gray-400 shrink-0" />
              <div className="leading-tight">
                <div className="text-base text-white leading-none">{customer?.customer_name}</div>
                <div className="text-xs text-gray-400 mt-0.5">Customer #{customer?.customer_number}</div>
              </div>
              <Badge
                className={cn(
                  "ml-auto border text-xs",
                  flagColors[customer?.flag_color || "none"].bg,
                  flagColors[customer?.flag_color || "none"].text
                )}
              >
                <Flag className="mr-1 h-3 w-3" />
                {flagColors[customer?.flag_color || "none"].label}
              </Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-2 overflow-y-auto flex-1 pr-1">
            {/* ── Outstanding Balance (with sub-accounts if parent) ── */}
            {(() => {
              const allAccounts = [
                { label: String(customer?.customer_number || ""), record: customer, isMain: true },
                ...subAccounts.map((r) => ({
                  label: String(r.customer_number || ""),
                  record: r,
                  isMain: false,
                })),
              ];

              const hasSubAccounts = subAccounts.length > 0;
              const grandTotal = allAccounts.reduce((s, { record: r }) => s + parseAmount(r?.outstanding_balance), 0);

              return (
                <div className="rounded-xl border border-gray-700 bg-gray-800 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-gray-400" />
                    <h4 className="text-sm font-semibold text-gray-300">Outstanding Balance</h4>
                  </div>

                  <div className="space-y-2">
                    {/* Header */}
                    <div className="grid grid-cols-2 gap-1 text-[10px] text-gray-500 uppercase tracking-wide px-1">
                      <span>Account</span>
                      <span className="text-right">Balance</span>
                    </div>

                    {allAccounts.map(({ label, record: r, isMain }) => (
                      <div
                        key={label}
                        className={cn(
                          "grid grid-cols-2 gap-1 rounded-lg px-2 py-1.5",
                          isMain ? "bg-gray-700" : "bg-gray-900"
                        )}
                      >
                        <span className={cn("text-xs font-medium truncate", isMain ? "text-white" : "text-gray-400")}>
                          {label}
                        </span>
                        <span className={cn("text-xs text-right", parseAmount(r?.outstanding_balance) !== 0 ? "text-white" : "text-gray-600")}>
                          {formatAmount(r?.outstanding_balance)}
                        </span>
                      </div>
                    ))}

                    {hasSubAccounts && (
                      <div className="grid grid-cols-2 gap-1 rounded-lg border border-gray-600 bg-gray-800 px-2 py-1.5 mt-1">
                        <span className="text-xs font-bold text-yellow-400">TOTAL</span>
                        <span className={cn("text-xs font-bold text-right", grandTotal !== 0 ? "text-yellow-300" : "text-gray-600")}>
                          {formatAmount(String(grandTotal))}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* ── Last Unpaid Invoice (with sub-accounts if parent) ── */}
            {(() => {
              const allAccounts = [
                { label: String(customer?.customer_number || ""), record: customer, isMain: true },
                ...subAccounts.map((r) => ({
                  label: String(r.customer_number || ""),
                  record: r,
                  isMain: false,
                })),
              ];

              // Shared table renderer for invoice and receipt blocks
              const renderTransactionTable = ({ title, icon: Icon, iconColor, accounts, getFields }) => (
                <div className="rounded-xl border border-gray-700 bg-gray-800 p-3 flex-1 min-w-0">
                  <div className="mb-2 flex items-center gap-2">
                    <Icon className={cn("h-4 w-4", iconColor)} />
                    <h4 className="text-sm font-semibold text-gray-300">{title}</h4>
                  </div>
                  <div className="space-y-1.5">
                    {/* 4 cols: Account | No. | Amount | Date */}
                    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.0fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-2 text-[10px] text-gray-500 uppercase tracking-wide px-1">
                      <span>Account</span>
                      <span>No.</span>
                      <span>Amount</span>
                      <span>Date</span>
                    </div>
                    {accounts.map(({ label, record: r, isMain }) => {
                      const { ref, amt, date } = getFields(r);
                      return (
                        <div
                          key={label}
                          className={cn(
                            "grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.0fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-2 rounded-lg px-2 py-1.5",
                            isMain ? "bg-gray-700" : "bg-gray-900"
                          )}
                        >
                          <span className={cn("text-xs font-medium truncate", isMain ? "text-white" : "text-gray-400")}>
                            {label}
                          </span>
                          <span className={cn("text-xs truncate", ref ? iconColor : "text-gray-600")}>
                            {ref || "—"}
                          </span>
                          <span className={cn("text-xs font-medium truncate", parseAmount(amt) !== 0 ? "text-white" : "text-gray-600")}>
                            {formatAmount(amt)}
                          </span>
                          <span className={cn("text-xs truncate", date ? "text-gray-300" : "text-gray-600")}>
                            {date || "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );

              return (
                <div className="flex gap-3">
                  {renderTransactionTable({
                    title: "Last Invoice",
                    icon: Flag,
                    iconColor: "text-orange-400",
                    accounts: allAccounts,
                    getFields: (r) => ({
                      ref: r?.last_unpaid_invoice_1,
                      amt: r?.last_unpaid_invoice_1_amount,
                      date: r?.last_unpaid_invoice_date,
                    }),
                  })}
                  {renderTransactionTable({
                    title: "Last Receipt",
                    icon: CheckCircle,
                    iconColor: "text-emerald-400",
                    accounts: allAccounts,
                    getFields: (r) => ({
                      ref: r?.last_receipt_number,
                      amt: r?.last_receipt_amount,
                      date: r?.last_receipt_date,
                    }),
                  })}
                </div>
              );
            })()}

            <div className="rounded-xl border border-gray-700 bg-gray-800 p-3">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-gray-300">
                  Flag Management
                </h4>
                {!canModifyFlag() && customer?.flag_color !== "none" && (
                  <Badge
                    variant="outline"
                    className="border-gray-600 text-xs text-gray-400"
                  >
                    <Shield className="mr-1 h-3 w-3" />
                    Protected
                  </Badge>
                )}
              </div>

              {/* Row 1: flag buttons (left) + last 2 actions (right) */}
              <div className="flex gap-3">
                {/* Left: flag buttons */}
                <div className="flex w-24 shrink-0 flex-col">
                  <div className="flex h-full flex-col justify-between">
                    {Object.entries(flagColors)
                      .filter(([key]) => key !== "none")
                      .map(([key, config]) => (
                        <Button
                          key={key}
                          variant="outline"
                          onClick={() => handleFlagChange(key)}
                          disabled={!canModifyFlag() || isUpdatingFlag}
                          className={cn(
                            "h-7 w-full justify-start border px-2 text-xs transition-all",
                            customer?.flag_color === key
                              ? `${config.bg} ${config.text} ${config.border}`
                              : "border-gray-600 text-gray-300 hover:bg-gray-700"
                          )}
                        >
                          <div
                            className={cn(
                              "mr-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                              key === "red" && "bg-red-500",
                              key === "green" && "bg-green-500",
                              key === "orange" && "bg-orange-500"
                            )}
                          />
                          {customer?.flag_color === key ? "Active" : config.label}
                        </Button>
                      ))}

                    {customer?.flag_color !== "none" && canModifyFlag() && (
                      <Button
                        variant="outline"
                        onClick={() => handleFlagChange("none")}
                        disabled={isUpdatingFlag}
                        className="h-7 w-full justify-start border border-gray-600 px-2 text-xs text-gray-400 hover:border-rose-700 hover:bg-rose-900/20 hover:text-rose-400"
                      >
                        <Trash2 className="mr-1.5 h-3 w-3 shrink-0" />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>

                {/* Right: last 2 actions */}
                <div className="flex-1 rounded-lg border border-gray-700 bg-gray-900 p-2">
                  <div className="mb-2 flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5 text-gray-400" />
                    <p className="text-xs font-medium text-gray-300">Last 2 actions</p>
                  </div>
                  {historyLoading ? (
                    <p className="text-xs text-gray-500">Loading…</p>
                  ) : recordHistory.length === 0 ? (
                    <p className="text-xs text-gray-500">No recent actions</p>
                  ) : (
                    <div className="space-y-1.5">
                      {recordHistory.slice(0, 2).map((log) => (
                        <div
                          key={log.id}
                          className="rounded border border-gray-800 bg-gray-950 p-1.5"
                        >
                          <div className="text-xs font-medium leading-snug text-gray-200">
                            {formatHistoryAction(log)}
                          </div>
                          <div className="mt-0.5 text-[11px] text-gray-400">
                            {formatHistoryDate(log.created_date)} ·{" "}
                            {log.user_name || log.user_email || "Unknown"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Row 2: reason block (full width, below) */}
              {canModifyFlag() && (
                <div className="space-y-1 pt-1">
                  <Label className="text-xs text-gray-400">Reason (optional)</Label>
                  <Textarea
                    value={flagReason}
                    onChange={(e) => setFlagReason(e.target.value)}
                    placeholder="Add a reason..."
                    className="h-14 resize-none border-gray-700 bg-gray-900 text-sm text-gray-100 placeholder:text-gray-500"
                    disabled={isUpdatingFlag}
                  />
                  {customer?.flag_color && customer.flag_color !== "none" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1 border-gray-600 text-gray-300 hover:bg-gray-700"
                      disabled={isUpdatingFlag}
                      onClick={() => handleFlagChange(customer.flag_color)}
                    >
                      Save Reason
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}