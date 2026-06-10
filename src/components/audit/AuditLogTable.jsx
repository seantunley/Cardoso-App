import { useState, useMemo, useEffect } from "react";
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
  // New canonical action names
  create_user: "bg-green-100 text-green-800",
  update_user_permissions: "bg-blue-100 text-blue-800",
  update_user_profile: "bg-blue-100 text-blue-800",
  update_user_password: "bg-amber-100 text-amber-800",
  delete_user: "bg-red-100 text-red-800",
  create_connection: "bg-purple-100 text-purple-800",
  update_connection: "bg-purple-100 text-purple-800",
  delete_connection: "bg-red-100 text-red-800",
  create_rule: "bg-indigo-100 text-indigo-800",
  update_rule: "bg-indigo-100 text-indigo-800",
  delete_rule: "bg-red-100 text-red-800",
  create_system: "bg-slate-100 text-slate-800",
  update_system: "bg-slate-100 text-slate-800",
  delete_system: "bg-red-100 text-red-800",
  apply_auto_flags: "bg-green-100 text-green-800",
  clear_auto_flags: "bg-yellow-100 text-yellow-800",
  import_rules: "bg-indigo-100 text-indigo-800",
  publish_credit_logic: "bg-indigo-100 text-indigo-800",
  push_credit_logic_to_sites: "bg-indigo-100 text-indigo-800",
  sync_credit_logic_from_hub: "bg-indigo-100 text-indigo-800",
  bat_upload: "bg-cyan-100 text-cyan-800",
  bat_extract_invoices: "bg-cyan-100 text-cyan-800",
  ocr_pause: "bg-yellow-100 text-yellow-800",
  ocr_resume: "bg-green-100 text-green-800",
  update_bat_settings: "bg-slate-100 text-slate-800",
  hub_force_resync_all: "bg-amber-100 text-amber-800",
  hub_force_resync_site: "bg-amber-100 text-amber-800",
  hub_delete_site: "bg-red-100 text-red-800",
  hub_backup_pull_trigger: "bg-cyan-100 text-cyan-800",
  enable_hub_backups: "bg-green-100 text-green-800",
  disable_hub_backups: "bg-yellow-100 text-yellow-800",
  app_update_trigger: "bg-amber-100 text-amber-800",
  dedupe_customers: "bg-amber-100 text-amber-800",
  dedupe_customers_dryrun: "bg-slate-100 text-slate-800",
  clear_imported_data: "bg-red-100 text-red-800",
  update_ntopng_settings: "bg-slate-100 text-slate-800",
  update_collection: "bg-cyan-100 text-cyan-800",
  hub_manual_sync: "bg-cyan-100 text-cyan-800",
  update_user_allowed_sites: "bg-blue-100 text-blue-800",
  hub_push_users: "bg-purple-100 text-purple-800",
  hub_push_rules: "bg-indigo-100 text-indigo-800",
  hub_dedupe: "bg-amber-100 text-amber-800",
  hub_dedupe_dryrun: "bg-slate-100 text-slate-800",
  manual_import: "bg-cyan-100 text-cyan-800",
  bat_retry_extraction: "bg-cyan-100 text-cyan-800",
  bat_manual_invoice_override: "bg-amber-100 text-amber-800",
  bat_refresh_sage: "bg-cyan-100 text-cyan-800",
  bat_cardoso_generate: "bg-cyan-100 text-cyan-800",
  bat_replicate_supplier: "bg-amber-100 text-amber-800",
  bat_cardoso_upload: "bg-cyan-100 text-cyan-800",
  set_initial_password: "bg-green-100 text-green-800",
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
  create_user: "User Created",
  update_user_permissions: "Permissions Updated",
  update_user_profile: "Profile Updated",
  update_user_password: "Password Changed",
  delete_user: "User Deleted",
  create_connection: "Connection Created",
  update_connection: "Connection Updated",
  delete_connection: "Connection Deleted",
  create_rule: "Rule Created",
  update_rule: "Rule Updated",
  delete_rule: "Rule Deleted",
  create_system: "Item Created",
  update_system: "Item Updated",
  delete_system: "Item Deleted",
  apply_auto_flags: "Auto-flags Applied",
  clear_auto_flags: "Auto-flags Cleared",
  import_rules: "Rules Imported",
  publish_credit_logic: "Credit Logic Published",
  push_credit_logic_to_sites: "Credit Logic Pushed",
  sync_credit_logic_from_hub: "Credit Logic Synced",
  bat_upload: "BAT Upload",
  bat_extract_invoices: "BAT Extract Triggered",
  ocr_pause: "OCR Paused",
  ocr_resume: "OCR Resumed",
  update_bat_settings: "BAT Settings Updated",
  hub_force_resync_all: "Force Resync (All)",
  hub_force_resync_site: "Force Resync (Site)",
  hub_delete_site: "Site Deleted",
  hub_backup_pull_trigger: "Backup Pull Triggered",
  hub_backup_pull: "Backup Pulled (per-site)",
  bat_recompute_recon_totals: "BAT Recon Totals Recomputed",
  bat_recompute_recon_totals_dryrun: "BAT Recon Totals Dry-run",
  enable_hub_backups: "Hub Backups Enabled",
  disable_hub_backups: "Hub Backups Disabled",
  app_update_trigger: "App Update Started",
  dedupe_customers: "Dedupe Customers",
  dedupe_customers_dryrun: "Dedupe Dry-run",
  clear_imported_data: "Imported Data Cleared",
  update_ntopng_settings: "ntopng Settings",
  update_collection: "Collection Updated",
  hub_manual_sync: "Manual Sync (All Sites)",
  update_user_allowed_sites: "Allowed Sites Updated",
  hub_push_users: "Users Pushed to Sites",
  hub_push_rules: "Rules Pushed to Sites",
  hub_dedupe: "Hub Dedupe",
  hub_dedupe_dryrun: "Hub Dedupe Dry-run",
  manual_import: "Manual Sync",
  bat_retry_extraction: "BAT Retry Extraction",
  bat_manual_invoice_override: "BAT Invoice Override",
  bat_refresh_sage: "BAT Sage Refresh",
  bat_cardoso_generate: "Cardoso Invoices Generated",
  bat_replicate_supplier: "Cardoso ↤ Supplier",
  bat_cardoso_upload: "Cardoso Upload",
  set_initial_password: "Initial Password Set",
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
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortBy, setSortBy] = useState("created_date");
  const [sortOrder, setSortOrder] = useState("desc");
  const [expandedRows, setExpandedRows] = useState(() => new Set());

  // Debounce search input — avoids re-filtering N log rows on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Per-log derived index built once per logs change: lowercased searchable
  // fields, flag summary, pretty-printed changes blob. Avoids re-parsing
  // JSON and re-lowercasing strings on every render / keystroke.
  const indexedLogs = useMemo(() => {
    return logs.map((log) => {
      const flagSummary = log.action_type === "update_flag" ? renderFlagSummary(log) : null;
      const search = [
        log.user_name, log.user_email, log.resource_name,
        log.action_type, log.action_details, log.resource_type,
      ].map((s) => (s ? String(s).toLowerCase() : "")).join("\0");
      const changesPretty = typeof log.changes === "string"
        ? log.changes
        : (log.changes ? JSON.stringify(log.changes, null, 2) : "");
      return { log, flagSummary, search, changesPretty };
    });
  }, [logs]);

  const filteredAndSorted = useMemo(() => {
    const query = debouncedQuery.toLowerCase();
    const filtered = query ? indexedLogs.filter((e) => e.search.includes(query)) : indexedLogs;

    const sorted = [...filtered].sort((a, b) => {
      let aVal = a.log[sortBy];
      let bVal = b.log[sortBy];
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

    return sorted;
  }, [indexedLogs, debouncedQuery, sortBy, sortOrder]);

  const handleSort = (column) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("desc");
    }
  };

  const toggleExpanded = (id) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
            {filteredAndSorted.map(({ log, flagSummary, changesPretty }) => {
              const isExpanded = expandedRows.has(log.id);
              const isFlagUpdate = log.action_type === "update_flag";
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
                    className="text-xs text-accent hover:text-[var(--phosphor)] font-mono uppercase tracking-wider"
                  >
                    {isExpanded ? "Hide details" : "Show details"}
                  </button>
                  {isExpanded && (
                    <div className="rounded-lg border border-border bg-muted/50 p-2 text-xs text-muted-foreground">
                      <pre className="whitespace-pre-wrap break-words text-[11px]">
                        {changesPretty}
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
                {filteredAndSorted.map(({ log, flagSummary, changesPretty }) => {
                  const isExpanded = expandedRows.has(log.id);
                  const isFlagUpdate = log.action_type === "update_flag";

                  return (
                    <tr
                      key={log.id}
                      className="border-b border-border transition-colors hover:bg-muted/30"
                    >
                      <td className="px-4 py-3 text-muted-foreground align-top">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-subtle" />
                          {formatAppDate(log.created_date)}
                        </div>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="flex items-start gap-2">
                          <User className="mt-0.5 h-4 w-4 text-muted-subtle" />
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
                              className="text-xs text-accent hover:text-[var(--phosphor)] font-mono uppercase tracking-wider"
                            >
                              {isExpanded ? "Hide details" : "Show details"}
                            </button>

                            {isExpanded && (
                              <div className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                                <div className="mb-2 text-muted-foreground">
                                  {log.action_details || "-"}
                                </div>
                                <pre className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                                  {changesPretty}
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