import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, ChevronUp, ChevronDown, Shield, Clock, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAppDate } from "@/lib/dates";

const actionColors = {
  update_flag: "bg-orange-100 text-orange-800",
  user_invited: "bg-green-100 text-green-800",
  user_permissions_updated: "bg-blue-100 text-blue-800",
  connection_created: "bg-purple-100 text-purple-800",
  connection_updated: "bg-purple-100 text-purple-800",
  connection_deleted: "bg-red-100 text-red-800",
  record_flagged: "bg-orange-100 text-orange-800",
  record_unflagged: "bg-yellow-100 text-yellow-800",
  record_edited: "bg-cyan-100 text-cyan-800",
  rule_created: "bg-indigo-100 text-indigo-800",
  rule_updated: "bg-indigo-100 text-indigo-800",
  rule_deleted: "bg-red-100 text-red-800",
  rule_applied: "bg-green-100 text-green-800",
  user_login: "bg-slate-100 text-slate-800",
  user_logout: "bg-slate-100 text-slate-800",
};

const actionLabels = {
  update_flag: "Flag Updated",
  user_invited: "User Invited",
  user_permissions_updated: "Permissions Updated",
  connection_created: "Connection Created",
  connection_updated: "Connection Updated",
  connection_deleted: "Connection Deleted",
  record_flagged: "Record Flagged",
  record_unflagged: "Record Unflagged",
  record_edited: "Record Edited",
  rule_created: "Rule Created",
  rule_updated: "Rule Updated",
  rule_deleted: "Rule Deleted",
  rule_applied: "Rules Applied",
  user_login: "User Login",
  user_logout: "User Logout",
};

function parseChanges(changes) {
  if (!changes) return null;
  if (typeof changes === "object") return changes;

  try {
    return JSON.parse(changes);
  } catch {
    return null;
  }
}

function renderFlagSummary(log) {
  const parsed = parseChanges(log.changes);
  const fieldChanges = parsed?.field_changes;

  if (!fieldChanges?.flag_color && !fieldChanges?.flag_reason) {
    return {
      colorChange: null,
      oldReason: "",
      newReason: "",
      fallback: log.action_details || "-",
    };
  }

  const oldColor = fieldChanges?.flag_color?.from ?? "none";
  const newColor = fieldChanges?.flag_color?.to ?? "none";
  const oldReason = fieldChanges?.flag_reason?.from ?? "";
  const newReason = fieldChanges?.flag_reason?.to ?? "";

  return {
    colorChange: `${oldColor || "none"} → ${newColor || "none"}`,
    oldReason,
    newReason,
    fallback: log.action_details || "-",
  };
}

export default function AuditLogTable({ logs = [] }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("created_date");
  const [sortOrder, setSortOrder] = useState("desc");
  const [expandedRows, setExpandedRows] = useState({});

  const filteredAndSorted = useMemo(() => {
    const filtered = logs.filter((log) => {
      const query = searchQuery.toLowerCase();
      return (
        log.user_name?.toLowerCase().includes(query) ||
        log.user_email?.toLowerCase().includes(query) ||
        log.resource_name?.toLowerCase().includes(query) ||
        log.action_type?.toLowerCase().includes(query) ||
        log.action_details?.toLowerCase().includes(query) ||
        log.resource_type?.toLowerCase().includes(query)
      );
    });

    filtered.sort((a, b) => {
      let aVal = a[sortBy];
      let bVal = b[sortBy];

      if (aVal === undefined) aVal = "";
      if (bVal === undefined) bVal = "";

      if (typeof aVal === "string") {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }

      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

    return filtered;
  }, [logs, searchQuery, sortBy, sortOrder]);

  const handleSort = (column) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("desc");
    }
  };

  const toggleExpanded = (id) => {
    setExpandedRows((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const SortIcon = ({ column }) => {
    if (sortBy !== column) return <ChevronDown className="h-4 w-4 opacity-30" />;
    return sortOrder === "asc" ? (
      <ChevronUp className="h-4 w-4" />
    ) : (
      <ChevronDown className="h-4 w-4" />
    );
  };

  return (
    <Card className="border-border bg-card text-foreground">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Shield className="h-5 w-5" />
          Audit Log
        </CardTitle>
      </CardHeader>

      <CardContent>
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by user, resource, action..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="border-border bg-muted pl-10 text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {/* Mobile card list — visible only on small screens */}
          <div className="block sm:hidden space-y-2">
            {filteredAndSorted.map((log) => {
              const isExpanded = !!expandedRows[log.id];
              const isFlagUpdate = log.action_type === "update_flag";
              const flagSummary = isFlagUpdate ? renderFlagSummary(log) : null;
              return (
                <div key={`m-${log.id}`} className="rounded-lg border border-border bg-muted/20 p-3 text-sm space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-foreground">{log.user_name || log.user_email || "Unknown"}</div>
                      <div className="text-xs text-muted-foreground">{formatAppDate(log.created_date)}</div>
                    </div>
                    <Badge className={cn("text-xs shrink-0", actionColors[log.action_type] || "bg-muted text-muted-foreground")}>
                      {actionLabels[log.action_type] || log.action_type}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {log.resource_type && <span className="font-medium text-foreground">{log.resource_type}</span>}
                    {log.resource_name && <span className="ml-1">{log.resource_name}</span>}
                  </div>
                  {isFlagUpdate && flagSummary?.colorChange && (
                    <div className="text-xs text-orange-300 font-medium">{flagSummary.colorChange}</div>
                  )}
                  {log.action_details && (
                    <div className="text-xs text-muted-foreground truncate">{log.action_details}</div>
                  )}
                  <button
                    onClick={() => toggleExpanded(log.id)}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    {isExpanded ? "Hide details" : "Show details"}
                  </button>
                  {isExpanded && (
                    <div className="rounded-lg border border-border bg-muted/50 p-2 text-xs text-muted-foreground">
                      <pre className="whitespace-pre-wrap break-words text-[11px]">
                        {typeof log.changes === "string" ? log.changes : JSON.stringify(log.changes, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Desktop table — hidden on small screens */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left font-semibold">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSort("created_date")}
                      className="flex h-8 items-center gap-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      Date
                      <SortIcon column="created_date" />
                    </Button>
                  </th>

                  <th className="px-4 py-3 text-left font-semibold">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSort("user_email")}
                      className="flex h-8 items-center gap-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      User
                      <SortIcon column="user_email" />
                    </Button>
                  </th>

                  <th className="px-4 py-3 text-left font-semibold">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSort("action_type")}
                      className="flex h-8 items-center gap-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      Action
                      <SortIcon column="action_type" />
                    </Button>
                  </th>

                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Resource</th>
                  <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Details</th>
                  <th className="px-4 py-3 text-center font-semibold text-muted-foreground">Status</th>
                </tr>
              </thead>

              <tbody>
                {filteredAndSorted.map((log) => {
                  const isExpanded = !!expandedRows[log.id];
                  const isFlagUpdate = log.action_type === "update_flag";
                  const flagSummary = isFlagUpdate ? renderFlagSummary(log) : null;

                  return (
                    <tr
                      key={log.id}
                      className="border-b border-border transition-colors hover:bg-muted/30"
                    >
                      <td className="px-4 py-3 text-muted-foreground align-top">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-foreground/50" />
                          {formatAppDate(log.created_date)}
                        </div>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="flex items-start gap-2">
                          <User className="mt-0.5 h-4 w-4 text-muted-foreground/50" />
                          <div>
                            <div className="font-medium text-foreground">
                              {log.user_name || "Unknown"}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {log.user_email || "-"}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <Badge
                          className={cn(
                            "text-xs",
                            actionColors[log.action_type] || "bg-muted text-muted-foreground"
                          )}
                        >
                          {actionLabels[log.action_type] || log.action_type}
                        </Badge>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-foreground">
                          {log.resource_type || "-"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {log.resource_name || "-"}
                        </div>
                      </td>

                      <td className="px-4 py-3 align-top">
                        {isFlagUpdate && flagSummary ? (
                          <div className="space-y-2">
                            {flagSummary.colorChange ? (
                              <div className="font-medium text-orange-300">
                                {flagSummary.colorChange}
                              </div>
                            ) : (
                              <div className="text-muted-foreground">
                                {flagSummary.fallback}
                              </div>
                            )}

                            {flagSummary.oldReason !== flagSummary.newReason && (
                              <div className="text-xs text-muted-foreground">
                                <span className="text-muted-foreground">Reason:</span>{" "}
                                {flagSummary.oldReason ? (
                                  <>
                                    <span className="text-red-300">"{flagSummary.oldReason}"</span>
                                    <span className="mx-1 text-muted-foreground">→</span>
                                  </>
                                ) : null}
                                {flagSummary.newReason ? (
                                  <span className="text-green-300">"{flagSummary.newReason}"</span>
                                ) : (
                                  <span className="text-muted-foreground">cleared</span>
                                )}
                              </div>
                            )}

                            <button
                              onClick={() => toggleExpanded(log.id)}
                              className="text-xs text-blue-300 hover:text-blue-200"
                            >
                              {isExpanded ? "Hide details" : "Show details"}
                            </button>

                            {isExpanded && (
                              <div className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                                <div className="mb-2 text-muted-foreground">
                                  {log.action_details || "-"}
                                </div>
                                <pre className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                  {typeof log.changes === "string"
                                    ? log.changes
                                    : JSON.stringify(log.changes, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="max-w-xs text-muted-foreground">
                            {log.action_details || "-"}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 text-center align-top">
                        <Badge
                          className={
                            log.status === "success"
                              ? "bg-green-100 text-green-800"
                              : "bg-red-100 text-red-800"
                          }
                        >
                          {log.status || "success"}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>{/* end desktop table wrapper */}

          {filteredAndSorted.length === 0 && (
            <div className="py-8 text-center text-muted-foreground">
              {logs.length === 0 ? "No audit logs yet" : "No results found"}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}