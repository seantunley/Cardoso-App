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
    label: "Red Flag",
  },
  green: {
    bg: "bg-green-100",
    text: "text-green-700",
    border: "border-green-200",
    label: "Green Flag",
  },
  orange: {
    bg: "bg-orange-100",
    text: "text-orange-700",
    border: "border-orange-200",
    label: "Orange Flag",
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
    last_unpaid_invoice_2:
      record.last_unpaid_invoice_2 || record.data?.last_unpaid_invoice_2,
    last_unpaid_invoice_2_amount:
      record.last_unpaid_invoice_2_amount || record.data?.last_unpaid_invoice_2_amount,
    last_unpaid_invoice_3:
      record.last_unpaid_invoice_3 || record.data?.last_unpaid_invoice_3,
    last_unpaid_invoice_3_amount:
      record.last_unpaid_invoice_3_amount || record.data?.last_unpaid_invoice_3_amount,
  };
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
      <Card className="border-gray-700 bg-gradient-to-br from-gray-800 to-gray-900">
        <CardContent className="pt-6">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-white" />
              <Input
                ref={searchInputRef}
                value={customerNumber}
                onChange={(e) => setCustomerNumber(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter customer number or name..."
                className="h-12 border-2 border-white/30 bg-gray-950 pl-11 text-white"
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-2 rounded-lg border bg-gray-900">
                  {suggestions.map((s, idx) => (
                    <button
                      key={s.record.id ?? idx}
                      onClick={() => handleSuggestionClick(s)}
                      className={cn(
                        "w-full border-b border-gray-800 px-4 py-3 text-left",
                        idx === selectedSuggestionIndex
                          ? "bg-gray-700"
                          : "hover:bg-gray-800"
                      )}
                    >
                      <div className="text-white">{s.customerName}</div>
                      <div className="text-xs text-gray-400">
                        #{s.customerNumber}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Button
              onClick={() => handleLookup()}
              disabled={loading}
              className="bg-white text-black"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

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
            "max-w-2xl border-4 bg-gray-900",
            customer?.flag_color === "red" && "border-red-500",
            customer?.flag_color === "green" && "border-green-500",
            customer?.flag_color === "orange" && "border-orange-500",
            (!customer?.flag_color || customer?.flag_color === "none") && "border-gray-700"
          )}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <User className="h-5 w-5 text-gray-400" />
              <div>
                <div className="text-lg text-white">{customer?.customer_name}</div>
                <div className="text-sm text-gray-400">
                  Customer #{customer?.customer_number}
                </div>
              </div>

              <Badge
                className={cn(
                  "ml-auto border",
                  flagColors[customer?.flag_color || "none"].bg,
                  flagColors[customer?.flag_color || "none"].text
                )}
              >
                <Flag className="mr-1 h-3 w-3" />
                {flagColors[customer?.flag_color || "none"].label}
              </Badge>
            </DialogTitle>

            <DialogDescription>
              Customer details and flag management.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 pt-4">
            <div className="rounded-xl border border-gray-700 bg-gray-800 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Calendar className="h-4 w-4 text-gray-400" />
                <h4 className="text-sm font-semibold text-gray-300">Age Analysis</h4>
              </div>

              {(() => {
                const buckets = [
                  { label: "Current", value: customer?.age_current },
                  { label: "7 Days", value: customer?.age_7_days },
                  { label: "14 Days", value: customer?.age_14_days },
                  { label: "21+ Days", value: customer?.age_21_days },
                ];
                const hasAnyData = buckets.some((b) => b.value && b.value.trim() !== "");

                if (!hasAnyData) {
                  return <p className="text-sm text-gray-400">No age analysis data</p>;
                }

                return (
                  <div className="grid grid-cols-4 gap-2">
                    {buckets.map(({ label, value }) => {
                      const display = value && value.trim() !== "" ? value : "—";
                      return (
                        <div
                          key={label}
                          className="flex flex-col rounded-lg border border-gray-700 bg-gray-900 p-2"
                        >
                          <span className="mb-1 text-xs text-gray-500">{label}</span>
                          <span
                            className={cn(
                              "text-sm font-semibold",
                              display !== "—" ? "text-white" : "text-gray-600"
                            )}
                          >
                            {display}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            <div className="rounded-xl border border-gray-700 bg-gray-800 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Flag className="h-4 w-4 text-orange-400" />
                <h4 className="text-sm font-semibold text-gray-300">
                  Last Unpaid Invoices
                </h4>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  {
                    label: "Invoice 1",
                    number: customer?.last_unpaid_invoice_1,
                    amount: customer?.last_unpaid_invoice_1_amount,
                  },
                  {
                    label: "Invoice 2",
                    number: customer?.last_unpaid_invoice_2,
                    amount: customer?.last_unpaid_invoice_2_amount,
                  },
                  {
                    label: "Invoice 3",
                    number: customer?.last_unpaid_invoice_3,
                    amount: customer?.last_unpaid_invoice_3_amount,
                  },
                ].map(({ label, number, amount }) => (
                  <div
                    key={label}
                    className="flex flex-col rounded-lg border border-gray-700 bg-gray-900 p-2 gap-1"
                  >
                    <span className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</span>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-gray-500">No.</span>
                      <span
                        className={cn(
                          "text-sm font-medium",
                          number && number.trim() !== "" ? "text-orange-300" : "text-gray-600"
                        )}
                      >
                        {number && number.trim() !== "" ? number : "—"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-gray-500">Val.</span>
                      <span
                        className={cn(
                          "text-xs",
                          amount && amount.trim() !== "" ? "text-gray-200" : "text-gray-600"
                        )}
                      >
                        {amount && amount.trim() !== "" ? amount : "—"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-gray-700 bg-gray-800 p-4">
              <div className="flex items-center justify-between">
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

              {customer?.flag_color !== "none" && customer?.flag_created_by && (
                <div className="rounded-lg border border-gray-700 bg-gray-900 p-2">
                  <p className="text-xs text-gray-400">
                    Flagged by:{" "}
                    <span className="font-medium text-gray-300">
                      {customer.flag_created_by}
                    </span>
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <History className="h-4 w-4 text-gray-400" />
                  <p className="text-xs font-medium text-gray-300">
                    Last 2 actions on this record
                  </p>
                </div>

                {historyLoading ? (
                  <p className="text-xs text-gray-500">Loading history...</p>
                ) : recordHistory.length === 0 ? (
                  <p className="text-xs text-gray-500">No recent actions found</p>
                ) : (
                  <div className="space-y-2">
                    {recordHistory.map((log) => (
                      <div
                        key={log.id}
                        className="rounded-md border border-gray-800 bg-gray-950 p-2"
                      >
                        <div className="text-xs font-medium text-gray-200">
                          {formatHistoryAction(log)}
                        </div>
                        <div className="mt-1 text-[11px] text-gray-400">
                          {formatHistoryDate(log.created_date)} ·{" "}
                          {log.user_name || log.user_email || "Unknown"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {Object.entries(flagColors)
                  .filter(([key]) => key !== "none")
                  .map(([key, config]) => (
                    <Button
                      key={key}
                      variant="outline"
                      size="sm"
                      onClick={() => handleFlagChange(key)}
                      disabled={!canModifyFlag() || isUpdatingFlag}
                      className={cn(
                        "border-2 transition-all",
                        customer?.flag_color === key
                          ? `${config.bg} ${config.text} ${config.border}`
                          : "border-gray-600 text-gray-300 hover:bg-gray-700"
                      )}
                    >
                      <div
                        className={cn(
                          "mr-2 h-3 w-3 rounded-full",
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
                    size="sm"
                    onClick={() => handleFlagChange("none")}
                    disabled={isUpdatingFlag}
                    className="border-2 border-gray-600 text-gray-400 hover:border-rose-700 hover:bg-rose-900/20 hover:text-rose-400"
                  >
                    <Trash2 className="mr-2 h-3 w-3" />
                    Remove Flag
                  </Button>
                )}
              </div>

              {canModifyFlag() && (
                <div className="space-y-1">
                  <Label className="text-xs text-gray-400">Reason (optional)</Label>
                  <Textarea
                    value={flagReason}
                    onChange={(e) => setFlagReason(e.target.value)}
                    placeholder="Add a reason..."
                    className="h-16 resize-none border-gray-700 bg-gray-900 text-sm text-gray-100 placeholder:text-gray-500"
                    disabled={isUpdatingFlag}
                  />
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}