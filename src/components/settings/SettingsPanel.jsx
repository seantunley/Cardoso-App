import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/lib/permissions";
import { humanizeApiError } from "@/lib/humanizeApiError";

// UI
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Icons
import {
  Zap, Plus,
  RefreshCw, AlertCircle, CheckCircle2, Clock, LogIn, ClipboardList,
  Download, Upload, GitBranch, Send, Info, Workflow, AlertTriangle,
  Lock, ShieldCheck, ShieldAlert, ExternalLink, Save, Database,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Sub-components
import AutoFlagRuleForm from "@/components/settings/AutoFlagRuleForm";
import AuditLogTable from "@/components/audit/AuditLogTable";
import ConnectionCard from "@/components/dashboard/ConnectionCard";
import ConnectionModal from "@/components/connections/ConnectionModal";
import ConnectionStatus from "@/components/connections/ConnectionStatus";



// ─── Connections Tab ──────────────────────────────────────────────────────────

async function fetchLocalConnections() {
  const r = await fetch("/api/databaseconnection", { credentials: "include" });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to fetch connections");
  return Array.isArray(d) ? d : [];
}
async function createLocalConnection(data) {
  const r = await fetch("/api/databaseconnection", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(data) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to create connection");
  return d;
}
async function updateLocalConnection(id, data) {
  const r = await fetch(`/api/databaseconnection/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(data) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to update connection");
  return d;
}
async function deleteLocalConnection(id) {
  const r = await fetch(`/api/databaseconnection/${id}`, { method: "DELETE", credentials: "include" });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to delete connection");
  return d;
}
async function runLocalImport(connectionId) {
  const r = await fetch(`/api/import/${connectionId}`, { method: "POST", credentials: "include" });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Import failed");
  return d;
}

async function fetchConnectionRoles() {
  const r = await fetch("/api/connection-roles", { credentials: "include" });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to load module routing");
  return d;
}
async function setConnectionRole(role, connectionId) {
  const r = await fetch(`/api/connection-roles/${role}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ connection_id: connectionId }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to update routing");
  return d;
}

function ModuleRoutingCard({ connections, isAdmin }) {
  const queryClient = useQueryClient();
  const { data: routing, isLoading, error } = useQuery({
    queryKey: ["connection-roles"],
    queryFn: fetchConnectionRoles,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: ({ role, connectionId }) => setConnectionRole(role, connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connection-roles"] });
      toast.success("Module routing updated");
    },
    onError: (err) => toast.error(err.message || "Update failed"),
  });

  if (error) {
    return (
      <div className="rounded-xl border border-rose-700 bg-rose-900/20 p-4 text-sm text-rose-300">
        Module routing unavailable: {error.message || "unknown error"}
      </div>
    );
  }

  const handleChange = (role, value) => {
    const id = value === "" ? null : Number(value);
    mutation.mutate({ role, connectionId: id });
  };

  return (
    <Card className="border-border bg-card">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <Workflow className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Module routing</h2>
          <span className="text-xs text-muted-foreground">
            Pin each module to a specific connection. Leave on "Auto-pick" to use the default selection logic.
          </span>
        </div>
        {isLoading || !routing ? (
          <p className="text-xs text-muted-foreground">Loading routing settings…</p>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {routing.roles.map((role) => {
                const value = routing.assigned[role.id] ?? "";
                return (
                  <div key={role.id} className="space-y-1.5">
                    <label htmlFor={`role-${role.id}`} className="text-xs font-medium text-muted-foreground">
                      {role.label}
                    </label>
                    <select
                      id={`role-${role.id}`}
                      value={value}
                      disabled={!isAdmin || mutation.isPending}
                      onChange={(e) => handleChange(role.id, e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    >
                      <option value="">Auto-pick (default)</option>
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} — {c.host}/{c.database_name}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            {!isAdmin && (
              <p className="text-xs text-muted-foreground">Read-only — only admins can change module routing.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionsTab({ currentUser }) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);

  const isAdmin = currentUser?.role === "admin";

  const { data: connections = [], isLoading, error } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchLocalConnections,
    enabled: !!currentUser,
    refetchInterval: 30000,
  });

  const createMutation = useMutation({
    mutationFn: createLocalConnection,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); setModalOpen(false); toast.success("Connection created"); },
    onError: (e) => toast.error(humanizeApiError(e, "create connection")),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateLocalConnection(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); setModalOpen(false); setEditingConnection(null); toast.success("Connection updated"); },
    onError: (e) => toast.error(humanizeApiError(e, "update connection")),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteLocalConnection,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); toast.success("Connection deleted"); },
    onError: (e) => toast.error(humanizeApiError(e, "delete connection")),
  });

  const handleSave = (data, id) => {
    const payload = { ...data, created_by: currentUser?.email };
    if (id) updateMutation.mutate({ id, data: payload }); else createMutation.mutate(payload);
  };

  const handleSyncAll = async () => {
    if (!connections.length) { toast.error("No connections to sync"); return; }
    setIsSyncingAll(true);
    try {
      let total = 0;
      for (const c of connections) { const r = await runLocalImport(c.id); total += r.imported || 0; }
      toast.success(`Sync complete. ${total} records imported.`);
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
    } catch (e) { toast.error(humanizeApiError(e, "sync all connections")); }
    finally { setIsSyncingAll(false); }
  };

  const handleSync = async (conn) => {
    setSyncingId(conn.id);
    try {
      const r = await runLocalImport(conn.id);
      toast.success(r.message || `Synced ${conn.name} (${r.imported || 0} records)`);
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
    } catch (e) { toast.error(humanizeApiError(e, `sync "${conn.name}"`)); }
    finally { setSyncingId(null); }
  };

  const handleEdit = (conn) => { setEditingConnection(conn); setModalOpen(true); };
  const handleDelete = (conn) => { setDeleteConfirmId(conn.id); };

  return (
    <div className="space-y-5">
      <div className="flex justify-end gap-2">
        <Button onClick={handleSyncAll} disabled={isSyncingAll} variant="outline" size="sm"
          className="border-border text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-4 h-4 mr-2 ${isSyncingAll ? "animate-spin" : ""}`} />
          {isSyncingAll ? "Syncing..." : "Sync All"}
        </Button>
        {isAdmin && (
          <Button onClick={() => { setEditingConnection(null); setModalOpen(true); }} size="sm"
            variant="default">
            <Plus className="w-4 h-4 mr-2" />New Connection
          </Button>
        )}
      </div>

      <ModuleRoutingCard connections={connections} isAdmin={isAdmin} />

      {error && <div className="rounded-xl border border-rose-700 bg-rose-900/20 p-4 text-sm text-rose-300">{error.message}</div>}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1,2].map(i => <div key={i} className="h-48 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : connections.length === 0 ? (
        <div className="text-center py-12 rounded-2xl border border-border bg-card">
          <p className="text-muted-foreground text-sm">
            {isAdmin ? "No connections yet. Add one to start syncing." : "No connections configured. Contact an admin."}
          </p>
          {isAdmin && (
            <Button onClick={() => setModalOpen(true)} size="sm" variant="default" className="mt-4">
              <Plus className="w-4 h-4 mr-2" />Add Connection
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {selectedConnectionId && connections.find(c => c.id === selectedConnectionId) && (
            <Card className="border-border bg-card">
              <CardContent className="p-4">
                <ConnectionStatus connection={connections.find(c => c.id === selectedConnectionId)} />
              </CardContent>
            </Card>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {connections.map(conn => (
              <div key={conn.id} onClick={() => setSelectedConnectionId(conn.id)}
                className={`cursor-pointer transition-opacity ${selectedConnectionId === conn.id ? "opacity-100" : "opacity-75 hover:opacity-100"}`}>
                <ConnectionCard connection={conn} onSync={handleSync}
                  onEdit={isAdmin ? handleEdit : null} onDelete={isAdmin ? handleDelete : null}
                  isSyncing={syncingId === conn.id} />
                {deleteConfirmId === conn.id && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm">
                    <span className="flex-1 text-rose-400">Delete this connection?</span>
                    <button onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(conn.id); setDeleteConfirmId(null); }}
                      className="rounded px-2 py-1 text-xs font-medium bg-rose-600 hover:bg-rose-700 text-white transition-colors">
                      Confirm Delete
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(null); }}
                      className="rounded px-2 py-1 text-xs font-medium border border-border text-muted-foreground hover:text-foreground transition-colors">
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConnectionModal connection={editingConnection} open={modalOpen}
        onClose={() => { setModalOpen(false); setEditingConnection(null); }}
        onSave={handleSave} isSaving={createMutation.isPending || updateMutation.isPending} />
    </div>
  );
}

// ─── Fields Tab ─────────────────────────────────────────────────────────────

const CUSTOMER_FIELDS = [
  { key: "customer_number",     label: "Customer Number",     fallbacks: "customer_number, CustomerNumber",             mode: "sync" },
  { key: "customer_name",       label: "Customer Name",       fallbacks: "customer_name, CustomerName, name",           mode: "sync" },
  { key: "age_analysis",        label: "Age Analysis",        fallbacks: "age_analysis, AgeAnalysis",                   mode: "sync" },
  { key: "outstanding_balance", label: "Outstanding Balance", fallbacks: "outstanding_balance, OutstandingBalance, AMTDUE, BalanceDue", mode: "sync" },
  { key: "age_current",         label: "Age Current",         fallbacks: "age_current, AgeCurrent, Current",            mode: "sync" },
  { key: "age_7_days",          label: "Age 7 Days",          fallbacks: "age_7_days, Age7Days, AMTDUE07",              mode: "sync" },
  { key: "age_14_days",         label: "Age 14 Days",         fallbacks: "age_14_days, Age14Days, AMTDUE14",            mode: "sync" },
  { key: "age_21_days",         label: "Age 21 Days",         fallbacks: "age_21_days, Age21Days, AMTDUE21",            mode: "sync" },
  { key: "last_unpaid_invoice_1",       label: "Invoice 1 Number",        fallbacks: "last_unpaid_invoice_1, LastUnpaidInvoice1",                       mode: "sync" },
  { key: "last_unpaid_invoice_1_amount", label: "Invoice 1 Amount",        fallbacks: "last_unpaid_invoice_1_amount, LastUnpaidInvoice1Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_1_date",   label: "Invoice 1 Date",          fallbacks: "last_unpaid_invoice_1_date, LastUnpaidInvoice1Date",                mode: "sync" },
  { key: "last_unpaid_invoice_2",       label: "Invoice 2 Number",        fallbacks: "last_unpaid_invoice_2, LastUnpaidInvoice2",                       mode: "sync" },
  { key: "last_unpaid_invoice_2_amount", label: "Invoice 2 Amount",        fallbacks: "last_unpaid_invoice_2_amount, LastUnpaidInvoice2Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_2_date",   label: "Invoice 2 Date",          fallbacks: "last_unpaid_invoice_2_date, LastUnpaidInvoice2Date",                mode: "sync" },
  { key: "last_unpaid_invoice_3",       label: "Invoice 3 Number",        fallbacks: "last_unpaid_invoice_3, LastUnpaidInvoice3",                       mode: "sync" },
  { key: "last_unpaid_invoice_3_amount", label: "Invoice 3 Amount",        fallbacks: "last_unpaid_invoice_3_amount, LastUnpaidInvoice3Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_3_date",   label: "Invoice 3 Date",          fallbacks: "last_unpaid_invoice_3_date, LastUnpaidInvoice3Date",                mode: "sync" },
  { key: "last_unpaid_invoice_4",       label: "Invoice 4 Number",        fallbacks: "last_unpaid_invoice_4, LastUnpaidInvoice4",                       mode: "sync" },
  { key: "last_unpaid_invoice_4_amount", label: "Invoice 4 Amount",        fallbacks: "last_unpaid_invoice_4_amount, LastUnpaidInvoice4Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_4_date",   label: "Invoice 4 Date",          fallbacks: "last_unpaid_invoice_4_date, LastUnpaidInvoice4Date",                mode: "sync" },
  { key: "last_unpaid_invoice_5",       label: "Invoice 5 Number",        fallbacks: "last_unpaid_invoice_5, LastUnpaidInvoice5",                       mode: "sync" },
  { key: "last_unpaid_invoice_5_amount", label: "Invoice 5 Amount",        fallbacks: "last_unpaid_invoice_5_amount, LastUnpaidInvoice5Amount",            mode: "sync" },
  { key: "last_unpaid_invoice_5_date",   label: "Invoice 5 Date",          fallbacks: "last_unpaid_invoice_5_date, LastUnpaidInvoice5Date",                mode: "sync" },
  { key: "last_receipt_1",               label: "Receipt 1 Number",        fallbacks: "last_receipt_1, LastReceipt1",                                    mode: "sync" },
  { key: "last_receipt_1_amount",        label: "Receipt 1 Amount",        fallbacks: "last_receipt_1_amount, LastReceipt1Amount",                       mode: "sync" },
  { key: "last_receipt_1_date",          label: "Receipt 1 Date",          fallbacks: "last_receipt_1_date, LastReceipt1Date",                           mode: "sync" },
  { key: "last_receipt_2",               label: "Receipt 2 Number",        fallbacks: "last_receipt_2, LastReceipt2",                                    mode: "sync" },
  { key: "last_receipt_2_amount",        label: "Receipt 2 Amount",        fallbacks: "last_receipt_2_amount, LastReceipt2Amount",                       mode: "sync" },
  { key: "last_receipt_2_date",          label: "Receipt 2 Date",          fallbacks: "last_receipt_2_date, LastReceipt2Date",                           mode: "sync" },
  { key: "last_receipt_3",               label: "Receipt 3 Number",        fallbacks: "last_receipt_3, LastReceipt3",                                    mode: "sync" },
  { key: "last_receipt_3_amount",        label: "Receipt 3 Amount",        fallbacks: "last_receipt_3_amount, LastReceipt3Amount",                       mode: "sync" },
  { key: "last_receipt_3_date",          label: "Receipt 3 Date",          fallbacks: "last_receipt_3_date, LastReceipt3Date",                           mode: "sync" },
  { key: "last_receipt_4",               label: "Receipt 4 Number",        fallbacks: "last_receipt_4, LastReceipt4",                                    mode: "sync" },
  { key: "last_receipt_4_amount",        label: "Receipt 4 Amount",        fallbacks: "last_receipt_4_amount, LastReceipt4Amount",                       mode: "sync" },
  { key: "last_receipt_4_date",          label: "Receipt 4 Date",          fallbacks: "last_receipt_4_date, LastReceipt4Date",                           mode: "sync" },
  { key: "last_receipt_5",               label: "Receipt 5 Number",        fallbacks: "last_receipt_5, LastReceipt5",                                    mode: "sync" },
  { key: "last_receipt_5_amount",        label: "Receipt 5 Amount",        fallbacks: "last_receipt_5_amount, LastReceipt5Amount",                       mode: "sync" },
  { key: "last_receipt_5_date",          label: "Receipt 5 Date",          fallbacks: "last_receipt_5_date, LastReceipt5Date",                           mode: "sync" },
  { key: "sales_rep",                    label: "Sales Rep",               fallbacks: "sales_rep, SalesRep, SALEREP, SalesRepCode, salesrep, SalesPerson, SalesPersonCode, Sales Rep, Sales Rep Code, SalesRepName, SalesPersonName, Salesman, SalesmanCode, SalesmanName, Rep, RepCode, RepName", mode: "sync" },
  { key: "account_type",                 label: "Account Type",            fallbacks: "account_type, AccountType, ACCOUNT_TYPE, accounttype, Type, CUSTOMER_TYPE, CustomerType, customer_type, Class, CustomerClass, Account Type", mode: "sync" },
  { key: "terms",               label: "Payment Terms",       fallbacks: "terms, Terms, PaymentTerms",                  mode: "sync" },
  { key: "note",                label: "Note",                fallbacks: "note, Note, notes",                           mode: "local-only" },
];

const INVENTORY_FIELDS = [
  { key: "item_number",      label: "Item Number",      fallbacks: "item_number, ItemNumber, ItemNo, ITEMNO",            mode: "sync" },
  { key: "item_description", label: "Item Description", fallbacks: "item_description, ItemDescription, Description, DESC", mode: "sync" },
  { key: "qty_on_hand",      label: "Qty on Hand",      fallbacks: "qty_on_hand, QtyOnHand, Quantity, QTY, OnHand",      mode: "sync" },
  { key: "last_cost",        label: "Last Cost",        fallbacks: "last_cost, LastCost, Cost, COST",                    mode: "sync" },
  { key: "price_list",       label: "Price List",       fallbacks: "price_list, PriceList, PRICE_LIST",                  mode: "sync" },
  { key: "price",            label: "Price",            fallbacks: "price, Price, SellPrice, UnitPrice",                 mode: "sync" },
];

const MODE_BADGE = {
  "sync":          { label: "Sync",          cls: "bg-accent/10 text-accent border-accent/30" },
  "sync-if-empty": { label: "Sync if empty", cls: "bg-yellow-900/50 text-yellow-300 border-yellow-700" },
  "local-only":    { label: "Local only",    cls: "bg-gray-700 text-gray-300 border-gray-600" },
};

function FieldsTable({ fields }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-48">Field Key</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-44">Label</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">SQL Fallback Names</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-32">Mode</th>
          </tr>
        </thead>
        <tbody>
          {fields.map(f => {
            const badge = MODE_BADGE[f.mode] || MODE_BADGE["sync"];
            return (
              <tr key={f.key} className="border-b border-border last:border-0 hover:bg-muted/20">
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{f.key}</td>
                <td className="px-4 py-2.5 text-foreground text-sm">{f.label}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground/70 leading-relaxed">{f.fallbacks}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${badge.cls}`}>
                    {badge.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FieldsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Customer Fields</h3>
        <FieldsTable fields={CUSTOMER_FIELDS} />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Inventory Fields</h3>
        <FieldsTable fields={INVENTORY_FIELDS} />
      </div>
    </div>
  );
}

// ─── Sync Log Tab ────────────────────────────────────────────────────────────

function SyncLogTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch("/api/hub/sync-log?limit=50", { credentials: "include" });
      if (res.ok) setRows(await res.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/hub/sync", { method: "POST", credentials: "include" });
      setTimeout(() => { fetchLog(); setSyncing(false); }, 3000);
    } catch { setSyncing(false); }
  };

  if (loading) return <div className="flex items-center justify-center h-40"><div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={triggerSync} disabled={syncing} variant="outline" size="sm" className="gap-2">
          <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync Now"}
        </Button>
      </div>
      {!rows.length ? (
        <div className="flex flex-col items-center justify-center h-32 text-muted-foreground gap-2"><Clock className="h-8 w-8" /><p className="text-sm">No sync events yet.</p></div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/40">
              {["Site","Status","Records","Started","Note"].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-2.5 font-medium">{row.site_slug}</td>
                  <td className="px-4 py-2.5">{row.status==="success"?<CheckCircle2 className="h-4 w-4 text-green-500"/>:row.status==="error"?<AlertCircle className="h-4 w-4 text-red-500"/>:<Clock className="h-4 w-4 text-muted-foreground"/>}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{row.records_fetched ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap text-xs">{row.started_at ? new Date(row.started_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[200px] truncate">{row.error_message || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Audit Log Tab ───────────────────────────────────────────────────────────

function AuditTab() {
  const [tab, setTab] = useState("audit");

  const { data: auditLogs = [], isLoading: auditLoading } = useQuery({
    queryKey: ["auditLogs"],
    queryFn: async () => {
      const r = await fetch("/api/auditlog", { credentials: "include" });
      const d = await r.json();
      return Array.isArray(d) ? [...d].sort((a,b) => new Date(b.created_date) - new Date(a.created_date)) : [];
    },
  });

  const { data: loginLogs = [], isLoading: loginLoading } = useQuery({
    queryKey: ["loginLogs"],
    queryFn: async () => {
      const r = await fetch("/api/login-logs", { credentials: "include" });
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    },
  });

  const fmt = (dt) => dt ? new Date(dt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="mb-4">
        <TabsTrigger value="audit"><ClipboardList className="h-3.5 w-3.5 mr-1.5" />Activity</TabsTrigger>
        <TabsTrigger value="logins"><LogIn className="h-3.5 w-3.5 mr-1.5" />Logins</TabsTrigger>
      </TabsList>

      <TabsContent value="audit">
        {auditLoading
          ? <div className="h-20 animate-pulse bg-muted rounded-xl" />
          : <AuditLogTable logs={auditLogs} />}
      </TabsContent>

      <TabsContent value="logins">
        {loginLoading ? (
          <div className="h-20 animate-pulse bg-muted rounded-xl" />
        ) : loginLogs.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm border border-dashed border-border rounded-xl">No login records yet</div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border bg-muted/40">
                {["Username","Full Name","IP Address","Logged In At"].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">{h}</th>)}
              </tr></thead>
              <tbody>
                {loginLogs.map(e => (
                  <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-2.5 font-medium text-foreground">{e.user_email}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{e.user_name || "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{e.ip_address || "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{fmt(e.logged_in_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

// ─── Auto-Flag Rules Tab ─────────────────────────────────────────────────────

function AutoFlagTab({ hubMode = false }) {
  const queryClient = useQueryClient();
  const [showNewRule, setShowNewRule] = useState(false);
  const [pushModalOpen, setPushModalOpen] = useState(false);
  const [selectedSiteIds, setSelectedSiteIds] = useState(new Set());
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const canManageRules = hasPermission(currentUser, "can_manage_rules");

  const { data: hubKpis } = useQuery({
    queryKey: ["hub-kpis-rules"],
    queryFn: () => fetch("/api/hub/kpis", { credentials: "include" }).then((response) => response.ok ? response.json() : null).catch(err => { reportClientError("SettingsPanel.hubKpis", err); return null; }),
    enabled: hubMode && canManageRules,
    retry: false,
  });
  const hubSites = hubKpis?.sites || [];

  const handleExport = async () => {
    try {
      const res = await fetch('/api/autoflagrule/export', { credentials: 'include' });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error('Export failed: ' + (e.error || res.status)); return; }
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cardoso-rules-export.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      toast.success('Rules exported');
    } catch (e) { toast.error('Export error: ' + e.message); }
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const rules = JSON.parse(ev.target.result);
        const res = await fetch('/api/autoflagrule/import', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rules),
        });
        if (!res.ok) { toast.error('Import failed'); return; }
        const { created, updated, skipped } = await res.json();
        queryClient.invalidateQueries({ queryKey: ['autoFlagRules'] });
        toast.success(`Imported: ${created} created, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`);
      } catch (err) { toast.error(`Import error: ${err.message}`); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const { data: autoFlagRules = [], isLoading } = useQuery({
    queryKey: ["autoFlagRules"],
    queryFn: () => api.entities.AutoFlagRule.list("-priority"),
  });

  const createMutation = useMutation({ mutationFn: (data) => api.entities.AutoFlagRule.create(data), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] }); toast.success("Rule created"); setShowNewRule(false); } });
  const updateMutation = useMutation({ mutationFn: ({ id, data }) => api.entities.AutoFlagRule.update(id, data), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] }); toast.success("Rule updated"); } });
  const deleteMutation = useMutation({ mutationFn: (id) => api.entities.AutoFlagRule.delete(id), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] }); toast.success("Rule deleted"); } });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/apply-auto-flags', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: ({ flagged, cleared }) => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      toast.success(`Flagged ${flagged} record(s), cleared ${cleared}`);
    },
    onError: (e) => toast.error(humanizeApiError(e, "apply auto-flag rules")),
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(hubMode ? '/api/hub/clear-auto-flags' : '/api/clear-auto-flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: ({ cleared }) => { queryClient.invalidateQueries({ queryKey: ["records"] }); toast.success(`Cleared ${cleared} auto-flagged record(s)`); },
    onError: (e) => toast.error(humanizeApiError(e, "clear auto-flag rules")),
  });

  const pushRulesMutation = useMutation({
    mutationFn: async () => {
      const site_ids = selectedSiteIds.size > 0 ? Array.from(selectedSiteIds) : [];
      const res = await fetch('/api/hub/push-rules', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    onSuccess: (data) => {
      const failed = (data.results || []).filter((result) => result.status !== 'ok');
      if (data.pushed) toast.success(`Pushed rules to ${data.pushed} site${data.pushed === 1 ? '' : 's'}`);
      // Surface the actual reason the server returned (result.error / result.detail
      // come from describeFetchError on the server side). status alone is just
      // "error" — useless for triage.
      failed.forEach((result) => {
        const reason = result.error || result.detail || result.status || 'unknown reason';
        toast.error(`Push to ${result.site} failed — ${reason}`);
      });
      setPushModalOpen(false);
      setSelectedSiteIds(new Set());
    },
    onError: (error) => toast.error(humanizeApiError(error, "push rules to sites")),
  });

  const handleSave = (data, id) => {
    if (!canManageRules) { toast.error("No permission"); return; }
    id ? updateMutation.mutate({ id, data }) : createMutation.mutate(data);
  };
  const handleDelete = (id) => {
    if (!canManageRules) { toast.error("No permission"); return; }
    if (confirm("Delete this rule?")) deleteMutation.mutate(id);
  };

  const toggleSite = (siteId) => {
    setSelectedSiteIds((current) => {
      const next = new Set(current);
      next.has(siteId) ? next.delete(siteId) : next.add(siteId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        {canManageRules && !hubMode && (
          <Button size="sm" variant="outline" onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending} className="gap-1.5">
            <Zap className="h-3.5 w-3.5" />{applyMutation.isPending ? "Applying…" : "Apply Now"}
          </Button>
        )}
        {canManageRules && (
          <Button size="sm" variant="outline" onClick={() => { if (confirm("Clear all auto-flagged records?")) clearMutation.mutate(); }} disabled={clearMutation.isPending} className="gap-1.5 border-rose-700 text-rose-400 hover:bg-rose-900/20">
            {clearMutation.isPending ? "Clearing…" : "Clear Auto Flags"}
          </Button>
        )}
        {canManageRules && hubMode && (
          <Button size="sm" variant="outline" onClick={() => setPushModalOpen(true)} className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" /> Push Rules to Sites
          </Button>
        )}
        {canManageRules && (
          <Button size="sm" variant="outline" onClick={() => setShowNewRule(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add Rule
          </Button>
        )}
        {canManageRules && (
          <Button size="sm" variant="outline" onClick={handleExport} className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
        )}
        {canManageRules && (
          <label>
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
            <Button size="sm" variant="outline" className="gap-1.5 cursor-pointer" asChild>
              <span><Upload className="h-3.5 w-3.5" /> Import</span>
            </Button>
          </label>
        )}
      </div>
      {showNewRule && canManageRules && <AutoFlagRuleForm onSave={handleSave} onDelete={() => setShowNewRule(false)} isSaving={createMutation.isPending} isAdmin={canManageRules} />}
      {isLoading ? <div className="h-20 animate-pulse bg-muted rounded-xl" /> : (
        <div className="space-y-3">
          {autoFlagRules.map(rule => (
            <AutoFlagRuleForm key={rule.id} rule={rule} onSave={handleSave} onDelete={handleDelete} isSaving={updateMutation.isPending||deleteMutation.isPending} isAdmin={canManageRules} />
          ))}
          {autoFlagRules.length === 0 && !showNewRule && (
            <div className="text-center py-10 border border-dashed border-border rounded-xl text-muted-foreground text-sm">No rules yet — add one above</div>
          )}
        </div>
      )}

      {hubMode && (
        <Dialog open={pushModalOpen} onOpenChange={setPushModalOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Push Rules to Sites</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Choose target sites. Leave all unselected to push to every registered site.
              </p>
              <div className="flex flex-wrap gap-2">
                {hubSites.map((site) => {
                  const selected = selectedSiteIds.has(site.site_id);
                  return (
                    <button
                      key={site.site_id}
                      type="button"
                      onClick={() => toggleSite(site.site_id)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                        selected
                          ? "border-[var(--phosphor)] bg-accent/10 text-accent"
                          : "border-border bg-card text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {site.site_name || site.site_slug || site.site_id}
                    </button>
                  );
                })}
                {hubSites.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                    No hub sites available.
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPushModalOpen(false)}>Cancel</Button>
                <Button onClick={() => pushRulesMutation.mutate()} disabled={pushRulesMutation.isPending || hubSites.length === 0}>
                  {pushRulesMutation.isPending ? "Pushing…" : "Confirm Push"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Main SettingsPanel ──────────────────────────────────────────────────────


// ─── Update Tab ─────────────────────────────────────────────────────────────
function MaintenanceTab() {
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [clearImportedOpen, setClearImportedOpen] = useState(false);
  const [clearingImported, setClearingImported] = useState(false);
  const [clearPassword, setClearPassword] = useState('');
  const [clearPasswordError, setClearPasswordError] = useState('');

  // Recompute-recon-totals state. Same dry-run/apply UX as the
  // dedupe-customers tool above. Why this exists: the BAT spreadsheet
  // upload upsert overwrites supplier_total per spreadsheet, so when
  // two branch spreadsheets land on the same week (Welkom + JHB, etc.)
  // the second upload's smaller fees blow away the first's. The
  // headline BAT TOTAL on the recon goes wrong with no operator-visible
  // signal. This button lets an admin scan every recon, see which ones
  // drifted, and heal them in one click without leaving the UI.
  const [reconTotalsPreview, setReconTotalsPreview] = useState(null);
  const [reconTotalsLoadingPreview, setReconTotalsLoadingPreview] = useState(false);
  const [reconTotalsApplying, setReconTotalsApplying] = useState(false);

  // Backup-now state. Mirrors the compact-database / clear-imported
  // pattern: password-confirmed, modal-gated, sticky result panel
  // shows the operator both the local outcome AND the hub-notify
  // outcome separately (one can succeed while the other fails — local
  // backup is the primary goal, hub notify is best-effort).
  const [backupOpen, setBackupOpen] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupPasswordError, setBackupPasswordError] = useState('');
  const [backupResult, setBackupResult] = useState(null);

  // Compact-database state. Originally added in PR #246 but the
  // merge of PR #248 (Backup-now) silently dropped these declarations
  // while leaving the matching dialog JSX intact, breaking the entire
  // Maintenance tab with ReferenceError on first render. Restored
  // here. Codex catch — same merge-loss class as the v62 migration
  // (PR #228), backup.js imports (PR #223), SiteCard accpac vars
  // (PR #221), and auditlog CHECK (PR #235).
  const [compactOpen, setCompactOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactPassword, setCompactPassword] = useState('');
  const [compactPasswordError, setCompactPasswordError] = useState('');
  const [compactResult, setCompactResult] = useState(null);

  const handleCompactDatabase = async () => {
    if (!compactPassword) {
      setCompactPasswordError('Password is required');
      return;
    }
    setCompactPasswordError('');
    setCompacting(true);
    try {
      const r = await fetch('/api/maintenance/compact-database', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: compactPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          setCompactPasswordError(d.error || 'Incorrect password');
          return;
        }
        throw new Error(d.error || 'Compact database failed');
      }
      setCompactResult(d);
      setCompactOpen(false);
      setCompactPassword('');
      const integrity = d.integrity_ok ? '' : ' (⚠ post-VACUUM integrity check FAILED — see audit log)';
      toast.success(
        `Database compacted: ${d.size_before_mb} MB → ${d.size_after_mb} MB ` +
        `(reclaimed ${d.reclaimed_mb} MB) in ${(d.elapsed_ms / 1000).toFixed(1)}s${integrity}`,
      );
    } catch (e) {
      toast.error(e.message || 'Compact database failed');
    } finally {
      setCompacting(false);
    }
  };

  const handleBackupNow = async () => {
    if (!backupPassword) {
      setBackupPasswordError('Password is required');
      return;
    }
    setBackupPasswordError('');
    setBackingUp(true);
    try {
      const r = await fetch('/api/maintenance/backup-now', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: backupPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          setBackupPasswordError(d.error || 'Incorrect password');
          return;
        }
        throw new Error(d.error || 'Backup failed');
      }
      setBackupResult(d);
      setBackupOpen(false);
      setBackupPassword('');
      const hubNote = d.hub_notified
        ? 'Hub pulled the new backup immediately.'
        : `Hub not notified yet (${d.hub_error || 'no detail'}). Hub will pick it up on its next scheduled cron tick.`;
      toast.success(
        `Backup created: ${d.backup_filename} (${d.size_mb} MB) in ${(d.elapsed_ms / 1000).toFixed(1)}s. ${hubNote}`,
      );
    } catch (e) {
      toast.error(e.message || 'Backup failed');
    } finally {
      setBackingUp(false);
    }
  };

  const handlePreview = async () => {
    setLoadingPreview(true);
    try {
      const r = await fetch('/api/maintenance/dedupe-customers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Dry-run failed');
      setPreview(d);
      toast.success(`Dry-run complete. ${d.groups || 0} duplicate group${d.groups === 1 ? '' : 's'} found.`);
    } catch (e) {
      toast.error(e.message || 'Dry-run failed');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const r = await fetch('/api/maintenance/dedupe-customers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Dedupe failed');
      setPreview(d);
      toast.success(`Dedupe complete. Removed ${d.totalRemoved || 0} duplicate record${d.totalRemoved === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message || 'Dedupe failed');
    } finally {
      setApplying(false);
    }
  };

  const handleReconTotalsPreview = async () => {
    setReconTotalsLoadingPreview(true);
    try {
      const r = await fetch('/api/maintenance/recompute-recon-totals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Dry-run failed');
      setReconTotalsPreview(d);
      const n = d.mismatches?.length || 0;
      if (n === 0) {
        toast.success(`Dry-run complete. All ${d.scanned || 0} recon(s) already correct — nothing to fix.`);
      } else {
        toast.success(`Dry-run complete. ${n} of ${d.scanned || 0} recon(s) need their BAT TOTAL recomputed.`);
      }
    } catch (e) {
      toast.error(e.message || 'Dry-run failed');
    } finally {
      setReconTotalsLoadingPreview(false);
    }
  };

  const handleReconTotalsApply = async () => {
    setReconTotalsApplying(true);
    try {
      const r = await fetch('/api/maintenance/recompute-recon-totals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Recompute failed');
      setReconTotalsPreview(d);
      toast.success(`Recompute complete. Updated ${d.updated || 0} recon(s).`);
    } catch (e) {
      toast.error(e.message || 'Recompute failed');
    } finally {
      setReconTotalsApplying(false);
    }
  };

  const handleClearImportedData = async () => {
    if (!clearPassword) {
      setClearPasswordError('Password is required');
      return;
    }
    setClearPasswordError('');
    setClearingImported(true);
    try {
      const r = await fetch('/api/maintenance/clear-imported-data', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: clearPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          setClearPasswordError(d.error || 'Incorrect password');
          return;
        }
        throw new Error(d.error || 'Clear imported data failed');
      }
      setPreview(null);
      setClearImportedOpen(false);
      setClearPassword('');
      const flagMsg = d.flagsPreserved ? ` ${d.flagsPreserved} flag${d.flagsPreserved === 1 ? '' : 's'} preserved for reimport.` : '';
      toast.success(`Imported data cleared. Removed ${d.totalRemoved || 0} row${d.totalRemoved === 1 ? '' : 's'}.${flagMsg}`);
    } catch (e) {
      toast.error(e.message || 'Clear imported data failed');
    } finally {
      setClearingImported(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Backup now</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Creates a fresh database snapshot in <code className="bg-muted px-1 py-0.5 rounded text-[10px]">database/backups/</code>
            {' '}immediately, instead of waiting for the daily 02:00 cron. Safe to run any time —
            backups are purely additive (a new file is created; the live database is never modified).
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            If <code className="bg-muted px-1 py-0.5 rounded text-[10px]">HUB_URL</code> is configured,
            the site also notifies the hub to pull the new file immediately so the hub mirror stays current.
            The notify is best-effort; if the hub is offline the local backup still succeeds and the hub picks
            it up on its next scheduled cron tick.
          </p>
        </div>
        {backupResult && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Last run: <code className="bg-muted px-1.5 py-0.5 rounded">{backupResult.backup_filename}</code> ({backupResult.size_mb} MB)
            </div>
            <div className="text-muted-foreground">
              Took {(backupResult.elapsed_ms / 1000).toFixed(1)}s · Hub notify: {backupResult.hub_notified ? '✓ pulled immediately' : '○ deferred to next cron'}
            </div>
            {!backupResult.hub_notified && backupResult.hub_error && (
              <div className="text-amber-700 dark:text-amber-400 text-[11px]">{backupResult.hub_error}</div>
            )}
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setBackupOpen(true)}
          disabled={loadingPreview || applying || clearingImported || backingUp}
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {backingUp ? 'Backing up...' : 'Backup now'}
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Compact database</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Reclaims disk space freed by previously-deleted records by rewriting the database
            file. <strong className="text-foreground">Non-destructive</strong> — every current row
            is preserved. The app may briefly slow down during the operation (typically a
            few seconds; up to a few minutes on a recently-bloated database).
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            A backup is taken first as a safety net, and integrity checks run before AND
            after to catch any corruption. The backup file stays on disk so you can restore
            it manually if anything else goes wrong.
          </p>
        </div>
        {compactResult && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Last run: {compactResult.size_before_mb} MB → {compactResult.size_after_mb} MB
              <span className="text-emerald-600 dark:text-emerald-400">
                (reclaimed {compactResult.reclaimed_mb} MB)
              </span>
            </div>
            <div className="text-muted-foreground">
              Took {(compactResult.elapsed_ms / 1000).toFixed(1)}s · Integrity check: {compactResult.integrity_ok ? '✓ OK' : '✗ FAILED'}
            </div>
            <div className="text-muted-foreground">
              Backup saved as <code className="bg-muted px-1.5 py-0.5 rounded">{compactResult.backup_filename}</code>
            </div>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCompactOpen(true)}
          disabled={loadingPreview || applying || clearingImported || compacting || backingUp}
        >
          <Database className="h-3.5 w-3.5 mr-1.5" />
          {compacting ? 'Compacting...' : 'Compact database'}
        </Button>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-1">Maintenance</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Site-only admin tools. Customer dedupe keeps the newest record per trimmed customer number, and removes older duplicates.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handlePreview} disabled={loadingPreview || applying || clearingImported}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loadingPreview ? 'animate-spin' : ''}`} />
            {loadingPreview ? 'Running dry-run...' : 'Dry-run dedupe'}
          </Button>
          <Button size="sm" variant="destructive" onClick={handleApply} disabled={applying || loadingPreview || clearingImported || !preview}>
            <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
            {applying ? 'Applying...' : 'Apply dedupe'}
          </Button>
        </div>
      </div>

      {/* Recompute BAT recon supplier_total. Heals recons whose
          headline BAT TOTAL drifted from the per-row data — usually
          because two branch spreadsheets uploaded to the same week
          and the second upload's smaller fees overwrote the first.
          Dry-run/apply pattern mirrors the Customer Dedupe above. */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Recompute BAT recon totals</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Resyncs each BAT reconciliation's BAT TOTAL with the sum of its non-exception POD amounts.
          Useful when the supplier sent multiple spreadsheets for one week and the headline total drifted.
          Dry-run shows which recons would change before anything is written.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReconTotalsPreview}
            disabled={reconTotalsLoadingPreview || reconTotalsApplying || loadingPreview || applying || clearingImported}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${reconTotalsLoadingPreview ? 'animate-spin' : ''}`} />
            {reconTotalsLoadingPreview ? 'Running dry-run...' : 'Dry-run recon totals'}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleReconTotalsApply}
            disabled={reconTotalsApplying || reconTotalsLoadingPreview || loadingPreview || applying || clearingImported || !reconTotalsPreview || (reconTotalsPreview?.mismatches?.length || 0) === 0}
          >
            <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
            {reconTotalsApplying ? 'Applying...' : 'Apply recon totals'}
          </Button>
        </div>

        {reconTotalsPreview && (
          <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 space-y-2">
            <div className="text-xs">
              <span className="font-medium text-foreground">
                {reconTotalsPreview.dryRun ? 'Dry-run result' : 'Applied'}:
              </span>{' '}
              <span className="text-foreground tabular-nums">
                {(reconTotalsPreview.mismatches?.length || 0)}
              </span>{' '}
              of {reconTotalsPreview.scanned || 0} recon(s) drifted
              {!reconTotalsPreview.dryRun && (
                <>; updated <span className="text-emerald-400 tabular-nums">{reconTotalsPreview.updated || 0}</span></>
              )}.
            </div>
            {(reconTotalsPreview.mismatches?.length || 0) > 0 && (
              <div className="max-h-48 overflow-y-auto pr-1">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left pr-2 pb-1 font-medium">Week</th>
                      <th className="text-right px-2 pb-1 font-medium">Current</th>
                      <th className="text-right px-2 pb-1 font-medium">Derived</th>
                      <th className="text-right pl-2 pb-1 font-medium">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconTotalsPreview.mismatches.map((m) => (
                      <tr key={m.id} className="border-b border-border/40 last:border-0">
                        <td className="pr-2 py-1 font-mono">W{String(m.week_number).padStart(2, '0')}/{m.year}</td>
                        <td className="text-right px-2 py-1">R {Number(m.current_total || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="text-right px-2 py-1">R {Number(m.derived_total || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className={`text-right pl-2 py-1 ${m.diff > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {m.diff > 0 ? '+' : ''}R {Number(m.diff || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={backupOpen} onOpenChange={(open) => { setBackupOpen(open); if (!open) { setBackupPassword(''); setBackupPasswordError(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a backup now?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              A timestamped database snapshot is written to <code className="bg-muted px-1 py-0.5 rounded text-[10px]">database/backups/</code>.
              The live database is not modified.
            </p>
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">After the local backup lands:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>The hub is notified (if <code className="bg-muted px-1 py-0.5 rounded text-[10px]">HUB_URL</code> is set) and pulls the new file within seconds</li>
                <li>If the hub is unreachable, the local backup still succeeds; the hub catches up on its next scheduled cron tick</li>
                <li>An audit-log entry records who triggered this and what was created</li>
              </ul>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="backup-password" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input
                id="backup-password"
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                value={backupPassword}
                onChange={(e) => { setBackupPassword(e.target.value); setBackupPasswordError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && backupPassword) handleBackupNow(); }}
                disabled={backingUp}
                autoComplete="current-password"
              />
              {backupPasswordError && <p className="text-xs text-destructive">{backupPasswordError}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setBackupOpen(false)} disabled={backingUp}>Cancel</Button>
              <Button onClick={handleBackupNow} disabled={backingUp || !backupPassword}>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {backingUp ? 'Backing up...' : 'Yes, back up now'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Clear imported SQL data</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Permanently removes imported customer records, imported inventory, and sync history from this site. Users and SQL connections stay intact.
          </p>
        </div>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setClearImportedOpen(true)}
          disabled={loadingPreview || applying || clearingImported}
        >
          <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
          {clearingImported ? 'Clearing...' : 'Clear imported data'}
        </Button>
      </div>

      <Dialog open={compactOpen} onOpenChange={(open) => { setCompactOpen(open); if (!open) { setCompactPassword(''); setCompactPasswordError(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Compact the database?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This rewrites the database file to reclaim disk space freed by previously-deleted
              records. <strong className="text-foreground">It does NOT remove any current data</strong>
              {' '}— every row in every table is preserved.
            </p>
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300 text-xs space-y-1">
              <div className="font-medium">During the operation:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>The database is exclusively locked — other users may briefly see slow responses</li>
                <li>Typical run is a few seconds; up to a few minutes on a heavily-bloated DB</li>
                <li>The service stays running throughout — no restart needed</li>
              </ul>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">Safety steps run automatically:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>A timestamped backup of the live database is saved to <code className="bg-muted px-1 py-0.5 rounded text-[10px]">database/</code> first</li>
                <li>Pre-VACUUM integrity check — refuses if the database is already corrupt</li>
                <li>Post-VACUUM integrity check — surfaces any new issue immediately</li>
                <li>Full audit-log entry recording the before/after sizes and your password-confirmed action</li>
              </ul>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="compact-password" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input
                id="compact-password"
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                value={compactPassword}
                onChange={(e) => { setCompactPassword(e.target.value); setCompactPasswordError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && compactPassword) handleCompactDatabase(); }}
                disabled={compacting}
                autoComplete="current-password"
              />
              {compactPasswordError && <p className="text-xs text-destructive">{compactPasswordError}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCompactOpen(false)} disabled={compacting}>Cancel</Button>
              <Button onClick={handleCompactDatabase} disabled={compacting || !compactPassword}>
                <Database className="h-3.5 w-3.5 mr-1.5" />
                {compacting ? 'Compacting...' : 'Yes, compact the database'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={clearImportedOpen} onOpenChange={(open) => { setClearImportedOpen(open); if (!open) { setClearPassword(''); setClearPasswordError(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear imported SQL data?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">
              Warning: this permanently removes imported customer records, inventory records, and sync history from this site database.
            </div>
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
              Customer flags and notes will be preserved and automatically restored when data is reimported.
            </div>
            <p className="text-muted-foreground">
              Users and SQL connections will be kept.
            </p>
            <div className="space-y-1.5">
              <label htmlFor="clear-password" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input
                id="clear-password"
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                value={clearPassword}
                onChange={(e) => { setClearPassword(e.target.value); setClearPasswordError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && clearPassword) handleClearImportedData(); }}
                disabled={clearingImported}
                autoComplete="current-password"
              />
              {clearPasswordError && <p className="text-xs text-destructive">{clearPasswordError}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setClearImportedOpen(false)} disabled={clearingImported}>Cancel</Button>
              <Button variant="destructive" onClick={handleClearImportedData} disabled={clearingImported || !clearPassword}>
                <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
                {clearingImported ? 'Clearing...' : 'Yes, clear it permanently'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {preview && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <div><span className="text-muted-foreground">Mode:</span> <span className="font-medium text-foreground">{preview.dryRun ? 'Dry-run' : 'Applied'}</span></div>
            <div><span className="text-muted-foreground">Duplicate groups:</span> <span className="font-medium text-foreground">{preview.groups ?? 0}</span></div>
            <div><span className="text-muted-foreground">Rows to remove:</span> <span className="font-medium text-foreground">{preview.totalRemoved ?? 0}</span></div>
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Customer #</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Keep ID</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Remove</th>
                </tr>
              </thead>
              <tbody>
                {(preview.report || []).slice(0, 100).map((group) => (
                  <tr key={group.customer_number} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{group.customer_number}</td>
                    <td className="px-3 py-2 text-muted-foreground">{group.kept_id}</td>
                    <td className="px-3 py-2 text-muted-foreground">{group.removed_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.groups > 100 && (
            <p className="text-xs text-muted-foreground">Showing first 100 duplicate groups.</p>
          )}
        </div>
      )}
    </div>
  );
}

// Lists hub_sites rows whose id is no longer in HUB_SITES env. Each
// row shows how much hub_records / hub_inventory data exists for it
// (so the operator knows what the Forget cascade would remove) plus
// a Forget button that DELETEs everything referencing that site.
//
// Renders nothing when there are no orphans — keeps the
// HubMaintenanceTab tidy in the healthy case.
function OrphanSitesSection() {
  const [orphans, setOrphans] = useState(null); // null = loading
  const [forgetting, setForgetting] = useState(null); // siteId being forgotten

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/hub/orphan-sites', { credentials: 'include' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setOrphans(Array.isArray(data.orphans) ? data.orphans : []);
    } catch (e) {
      reportClientError('SettingsPanel.orphanSites.load', e);
      setOrphans([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleForget = async (orphan) => {
    const recCount = orphan.record_count || 0;
    const invCount = orphan.inventory_count || 0;
    const summary = `${recCount} record(s)${invCount ? ` + ${invCount} inventory row(s)` : ''}`;
    if (!confirm(
      `Forget orphan site "${orphan.name || orphan.slug || orphan.id}"?\n\n` +
      `This will permanently delete the hub_sites row plus ${summary} from the hub. ` +
      `It does NOT touch the site itself — only the hub's cached copy.\n\n` +
      `This cannot be undone.`
    )) return;

    setForgetting(orphan.id);
    try {
      const r = await fetch(`/api/hub/sites/${encodeURIComponent(orphan.id)}/forget`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(`Forgot ${orphan.name || orphan.slug}: removed ${data.counts.records} records, ${data.counts.inventory} inventory rows.`);
      await load();
    } catch (e) {
      toast.error(humanizeApiError(e, `forget ${orphan.name || orphan.slug || orphan.id}`));
    } finally {
      setForgetting(null);
    }
  };

  if (orphans === null) return null; // loading — don't flash empty state
  if (orphans.length === 0) return null; // no orphans — hide entirely

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Orphan sites ({orphans.length})
        </h3>
        <p className="text-xs text-muted-foreground">
          These sites are still in <span className="font-mono">hub_sites</span> but no longer in <span className="font-mono">HUB_SITES</span> env.
          The schedulers don't refresh them and per-site actions refuse on them. Either re-add the site to <span className="font-mono">HUB_SITES</span> env to reactivate, or use Forget to remove the hub's cached copy.
        </p>
      </div>
      <div className="space-y-2">
        {orphans.map((o) => {
          const ageMs = o.removed_from_env_at ? Date.now() - new Date(o.removed_from_env_at).getTime() : null;
          const ageDays = ageMs != null ? Math.floor(ageMs / (24 * 60 * 60 * 1000)) : null;
          return (
            <div key={o.id} className="rounded-md border border-border bg-card p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate">{o.name || o.slug || o.id}</div>
                <div className="text-[11px] text-muted-foreground">
                  {ageDays != null ? `Orphaned ${ageDays} day${ageDays === 1 ? '' : 's'} ago · ` : ''}
                  {o.record_count || 0} record{o.record_count === 1 ? '' : 's'}
                  {o.inventory_count ? ` · ${o.inventory_count} inventory row${o.inventory_count === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleForget(o)}
                disabled={forgetting === o.id}
                className="border-amber-500/40 text-amber-500 hover:bg-amber-500/10 hover:text-amber-400 shrink-0"
              >
                {forgetting === o.id ? 'Forgetting…' : 'Forget'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HubMaintenanceTab() {
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [sites, setSites] = useState([]);
  const [deletingSite, setDeletingSite] = useState(null);

  useEffect(() => {
    fetch('/api/hub/sites', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => setSites(Array.isArray(data) ? data : data.sites || []))
      .catch(err => { toast.error(`Couldn't load sites: ${err.message}`); reportClientError("SettingsPanel.sites", err); });
  }, []);

  const handleDeleteSite = async (siteId, siteName) => {
    if (!confirm(`Delete site "${siteName}" and ALL its hub data? This cannot be undone.`)) return;
    setDeletingSite(siteId);
    try {
      const r = await fetch(`/api/hub/site/${siteId}`, { method: 'DELETE', credentials: 'include' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      toast.success(data.message);
      setSites(prev => prev.filter(s => s.id !== siteId));
    } catch (e) {
      toast.error(e.message || 'Failed to delete site');
    } finally {
      setDeletingSite(null);
    }
  };

  const handlePreview = async () => {
    setLoadingPreview(true);
    try {
      const r = await fetch('/api/hub/dedupe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPreview(data);
      toast.success(`Dry run: ${data.totalRemoved} duplicates found across ${data.groups} groups`);
    } catch (e) {
      toast.error(e.message || 'Dry run failed');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const r = await fetch('/api/hub/dedupe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPreview(data);
      toast.success(`Removed ${data.totalRemoved} duplicates across ${data.groups} groups`);
    } catch (e) {
      toast.error(e.message || 'Dedupe failed');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <OrphanSitesSection />
      <div>
        <h3 className="text-sm font-semibold mb-1">Hub Maintenance</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Remove duplicate hub records. Keeps the newest record per customer number (per site), preserving flagged records.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handlePreview} disabled={loadingPreview || applying}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loadingPreview ? 'animate-spin' : ''}`} />
            {loadingPreview ? 'Running dry-run...' : 'Dry-run dedupe'}
          </Button>
          <Button size="sm" variant="destructive" onClick={handleApply} disabled={applying || loadingPreview || !preview}>
            <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
            {applying ? 'Applying...' : 'Apply dedupe'}
          </Button>
        </div>
      </div>

      {preview && (
        <div className="space-y-2">
          <p className="text-xs font-medium">
            {preview.dryRun ? 'Preview' : 'Result'}: {preview.groups} duplicate groups, {preview.totalRemoved} records to remove
          </p>
          <div className="max-h-64 overflow-y-auto rounded border text-xs">
            <table className="w-full">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="text-left px-2 py-1">Site</th>
                  <th className="text-left px-2 py-1">Customer #</th>
                  <th className="text-left px-2 py-1">Name</th>
                  <th className="text-right px-2 py-1">Dupes</th>
                </tr>
              </thead>
              <tbody>
                {preview.report.slice(0, 100).map((g, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 text-muted-foreground">{g.site_id?.substring(0, 8)}</td>
                    <td className="px-2 py-1">{g.customer_number}</td>
                    <td className="px-2 py-1">{g.customer_name}</td>
                    <td className="px-2 py-1 text-right">{g.removed_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="border-t pt-4">
        <h3 className="text-sm font-semibold mb-1">Registered Sites</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Remove old or duplicate site registrations. Deleting a site removes all its synced records, inventory, and sync logs from the hub.
        </p>
        {sites.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sites registered.</p>
        ) : (
          <div className="rounded border text-xs">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-2 py-1.5">ID</th>
                  <th className="text-left px-2 py-1.5">Name</th>
                  <th className="text-left px-2 py-1.5">Slug</th>
                  <th className="text-left px-2 py-1.5">Status</th>
                  <th className="text-right px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {sites.map(s => (
                  <tr key={s.id} className="border-t">
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">{s.id}</td>
                    <td className="px-2 py-1.5">{s.name}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{s.slug}</td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        s.status === 'ok' ? 'bg-emerald-500/10 text-emerald-500' :
                        s.status === 'error' ? 'bg-red-500/10 text-red-500' :
                        'bg-muted text-muted-foreground'
                      }`}>{s.status || 'unknown'}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={() => handleDeleteSite(s.id, s.name)}
                        disabled={deletingSite === s.id}
                      >
                        {deletingSite === s.id ? 'Deleting...' : 'Delete'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CreditLogicTab({ hubMode = false, currentUser }) {
  const queryClient = useQueryClient();
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || currentUser?.role === "admin";
  const [draft, setDraft] = useState(null);
  const [notes, setNotes] = useState("");
  const [selectedSiteIds, setSelectedSiteIds] = useState(new Set());

  const query = useQuery({
    queryKey: [hubMode ? "hub-credit-logic" : "site-credit-logic"],
    queryFn: async () => {
      const response = await fetch(hubMode ? "/api/hub/credit-logic" : "/api/credit-logic/current", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load credit logic");
      return data;
    },
    enabled: !!currentUser,
  });

  useEffect(() => {
    const sourceConfig = hubMode ? query.data?.current?.config : query.data?.current?.config;
    if (sourceConfig) setDraft(sourceConfig);
  }, [hubMode, query.data]);

  const publishMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/hub/credit-logic/publish", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: draft, notes }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to publish credit logic");
      return data;
    },
    onSuccess: () => {
      toast.success("Credit logic published");
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["hub-credit-logic"] });
      queryClient.invalidateQueries({ queryKey: ["creditLogicCurrent"] });
    },
    onError: (error) => toast.error(error.message || "Failed to publish credit logic"),
  });

  const pushMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/hub/credit-logic/push", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_ids: selectedSiteIds.size > 0 ? Array.from(selectedSiteIds) : [] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 207) throw new Error(data.error || "Failed to push credit logic");
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Pushed v${data.version} to ${data.pushed} site${data.pushed === 1 ? "" : "s"}`);
      if (data.failed) toast.error(`${data.failed} site${data.failed === 1 ? "" : "s"} failed to update`);
      queryClient.invalidateQueries({ queryKey: ["hub-credit-logic"] });
    },
    onError: (error) => toast.error(error.message || "Failed to push credit logic"),
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/credit-logic/sync-from-hub", { method: "POST", credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 207) throw new Error(data.error || "Failed to sync credit logic");
      return data;
    },
    onSuccess: (data) => {
      if (data.ok) toast.success(`Synced credit logic v${data.logicVersion}`);
      else toast.error(data.error || "Credit logic sync completed with issues");
      queryClient.invalidateQueries({ queryKey: ["site-credit-logic"] });
      queryClient.invalidateQueries({ queryKey: ["creditLogicCurrent"] });
    },
    onError: (error) => toast.error(error.message || "Failed to sync credit logic"),
  });

  const setNested = (path, value) => {
    setDraft((current) => {
      if (!current) return current;
      const clone = structuredClone(current);
      let cursor = clone;
      for (let i = 0; i < path.length - 1; i += 1) cursor = cursor[path[i]];
      cursor[path[path.length - 1]] = value;
      return clone;
    });
  };

  const toggleSite = (siteId) => {
    setSelectedSiteIds((current) => {
      const next = new Set(current);
      next.has(siteId) ? next.delete(siteId) : next.add(siteId);
      return next;
    });
  };

  const statuses = query.data?.siteStatuses || [];
  const current = query.data?.current;
  const modeBadge = hubMode ? "Hub Source of Truth" : "Site Cache";
  const driftTone = {
    current: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    outdated: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    error: "bg-red-500/15 text-red-400 border-red-500/30",
    unreachable: "bg-red-500/15 text-red-400 border-red-500/30",
    never_synced: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  };

  if (query.isLoading || !draft) return <div className="h-32 animate-pulse rounded-xl bg-muted" />;
  if (query.error) return <div className="rounded-xl border border-rose-700 bg-rose-900/20 p-4 text-sm text-rose-300">{query.error.message}</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Centralised Credit Logic</h3>
            <Badge variant="outline" className="border-border text-muted-foreground">{modeBadge}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Active version: <span className="font-medium text-foreground">v{hubMode ? query.data?.current?.version : current?.logicVersion}</span>
            {!hubMode && current?.syncStatus ? <span> · sync status: {current.syncStatus.replaceAll("_", " ")}</span> : null}
          </p>
          {!hubMode && current?.lastError ? <p className="text-xs text-rose-400">Last sync error: {current.lastError}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {hubMode ? (
            <>
              <Button size="sm" variant="outline" onClick={() => publishMutation.mutate()} disabled={!canManageRules || publishMutation.isPending} className="gap-1.5">
                <GitBranch className="h-3.5 w-3.5" />{publishMutation.isPending ? "Publishing…" : "Publish new version"}
              </Button>
              <Button size="sm" onClick={() => pushMutation.mutate()} disabled={!canManageRules || pushMutation.isPending || statuses.length === 0} className="gap-1.5">
                <Send className="h-3.5 w-3.5" />{pushMutation.isPending ? "Pushing…" : "Push to sites"}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => syncMutation.mutate()} disabled={!canManageRules || syncMutation.isPending || !query.data?.hubSyncConfigured} className="gap-1.5">
              <RefreshCw className={cn("h-3.5 w-3.5", syncMutation.isPending && "animate-spin")} />{syncMutation.isPending ? "Syncing…" : "Sync from Hub"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Thresholds</h4>
              <p className="text-xs text-muted-foreground">These values drive the scoring thresholds enforced in analysis.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Payment term days", ["thresholds", "paymentTermDays"], "Expected payment window. Invoices paid within this many days are considered on time and score positively."],
                ["Breach days", ["thresholds", "breachDays"], "Hard overdue limit. Any unpaid invoice older than this forces a Hold verdict, regardless of score."],
                ["Approaching breach days", ["thresholds", "approachingBreachDays"], "Warning zone before the hard breach. Unpaid invoices in this range deduct points and trigger a caution flag."],
                ["Caution below score", ["thresholds", "cautionScoreBelow"], "Score threshold for the Caution verdict. Customers scoring below this value are shown as Caution instead of Approve."],
                ["Hold below score", ["thresholds", "holdScoreBelow"], "Reserved for future use. Currently Hold is triggered by breach days, not score alone."],
                ["Dormant threshold days", ["thresholds", "dormantThresholdDays"], "Inactivity cutoff. Customers with no invoice or receipt activity beyond this many days are flagged as Dormant instead of Approve."],
              ].map(([label, path, hint]) => (
                <div key={path.join(".")} className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label>{label}</Label>
                    {hint && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[260px]">{hint}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <Input type="number" value={path.reduce((acc, key) => acc?.[key], draft) ?? ""} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(path, Number(e.target.value || 0))} />
                  {hint && <p className="text-xs text-muted-foreground leading-snug">{hint}</p>}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm">
                  <Checkbox checked={Boolean(draft.outstandingBalanceCap.enabled)} disabled={!hubMode || !canManageRules} onCheckedChange={(checked) => setNested(["outstandingBalanceCap", "enabled"], Boolean(checked))} />
                  Enable exposure cap deduction
                </label>
                <p className="text-xs text-muted-foreground leading-snug px-1">When enabled, a customer whose outstanding balance exceeds their average invoice multiplied by the cap multiplier below receives a score deduction.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Exposure cap multiplier</Label>
                <Input type="number" value={draft.outstandingBalanceCap.multiplier} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(["outstandingBalanceCap", "multiplier"], Number(e.target.value || 0))} />
                <p className="text-xs text-muted-foreground leading-snug">e.g. a multiplier of 3 means: if the outstanding balance is more than 3× their average invoice, points are deducted. Lower = stricter.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Verdict wording</h4>
              <p className="text-xs text-muted-foreground">Admin-editable labels and summaries pushed from Hub to every site.</p>
            </div>
            {[
              ["approve", "Approve"],
              ["caution", "Caution"],
              ["hold", "Hold"],
              ["dormant", "Dormant"],
            ].map(([key, label]) => (
              <div key={key} className="space-y-2 rounded-xl border border-border p-3">
                <Label>{label} title</Label>
                <Input value={draft.wording.verdicts[key].title} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(["wording", "verdicts", key, "title"], e.target.value)} />
                <Label>{label} summary</Label>
                <Textarea value={draft.wording.verdicts[key].summary} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(["wording", "verdicts", key, "summary"], e.target.value)} rows={3} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {hubMode ? (
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label>Publish notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What changed in this logic version?" disabled={!canManageRules} />
              </div>
              <div className="space-y-1.5 min-w-[220px]">
                <Label>Recent versions</Label>
                <div className="rounded-xl border border-border p-3 text-sm text-muted-foreground">
                  {(query.data?.versions || []).slice(0, 5).map((version) => (
                    <div key={version.version} className="flex items-center justify-between gap-2 py-1 first:pt-0 last:pb-0">
                      <span>v{version.version}</span>
                      <span className="text-xs">{version.isActive ? "active" : "history"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-foreground">Site sync status</h4>
                <p className="text-xs text-muted-foreground">Select sites below to push a targeted update, or leave all unchecked to push everywhere.</p>
              </div>
              <div className="rounded-xl border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
                      <th className="px-4 py-2.5 text-left">Push</th>
                      <th className="px-4 py-2.5 text-left">Site</th>
                      <th className="px-4 py-2.5 text-left">Version</th>
                      <th className="px-4 py-2.5 text-left">Drift</th>
                      <th className="px-4 py-2.5 text-left">Last synced</th>
                      <th className="px-4 py-2.5 text-left">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statuses.map((site) => (
                      <tr key={site.siteId} className="border-b border-border last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-2.5"><Checkbox checked={selectedSiteIds.has(site.siteId)} onCheckedChange={() => toggleSite(site.siteId)} /></td>
                        <td className="px-4 py-2.5 font-medium text-foreground">{site.siteName || site.siteSlug}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{site.logicVersion ? `v${site.logicVersion}` : "—"}</td>
                        <td className="px-4 py-2.5"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${driftTone[site.driftStatus] || driftTone.never_synced}`}>{site.driftStatus.replaceAll("_", " ")}</span></td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{site.lastSyncedAt ? new Date(site.lastSyncedAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</td>
                        <td className="px-4 py-2.5 text-xs text-rose-400 max-w-[260px] truncate">{site.lastError || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">How scoring works</h4>
              <p className="text-xs text-muted-foreground mt-0.5">A walk-through of the logic applied to every customer analysis.</p>
            </div>
            <ol className="space-y-3 text-xs text-muted-foreground list-none">
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center font-semibold text-[10px]">1</span>
                <div><span className="font-medium text-foreground">Zero balance → instant Approve.</span> If the outstanding balance is below R1 the customer passes immediately. Score is 100. Manual red/orange flags can still override this.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-slate-500/15 text-slate-300 flex items-center justify-center font-semibold text-[10px]">2</span>
                <div><span className="font-medium text-foreground">No history with a balance → Caution.</span> If there are no invoices or receipts on record but the customer has an outstanding balance, a fixed low score is applied and the verdict is Caution.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-red-500/15 text-red-400 flex items-center justify-center font-semibold text-[10px]">3</span>
                <div><span className="font-medium text-foreground">Hard breach gate.</span> If the oldest unpaid invoice is older than <em>Breach days</em>, the verdict is forced to Hold — no score calculation matters. This is a hard block.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500/15 text-amber-400 flex items-center justify-center font-semibold text-[10px]">4</span>
                <div><span className="font-medium text-foreground">Score deductions (start at 100).</span> Points are deducted for: unpaid invoices approaching breach, average payment lag above terms, outstanding balance exceeding the exposure cap, and historical red/orange flag events. Multiple deductions stack.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-sky-500/15 text-sky-400 flex items-center justify-center font-semibold text-[10px]">5</span>
                <div><span className="font-medium text-foreground">Verdict from score.</span> Score below <em>Caution threshold</em> → Caution. Above it → Approve. (<em>Hold below score</em> is reserved for future use; Hold is currently breach-only.)</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-purple-500/15 text-purple-400 flex items-center justify-center font-semibold text-[10px]">6</span>
                <div><span className="font-medium text-foreground">Dormant check.</span> If the customer would Approve but has had no invoice or receipt activity for longer than <em>Dormant threshold days</em>, the verdict becomes Dormant instead — a prompt to re-evaluate before extending credit.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-slate-500/15 text-slate-300 flex items-center justify-center font-semibold text-[10px]">7</span>
                <div><span className="font-medium text-foreground">Manual flag overrides (final pass).</span> A manually applied red flag forces Hold. A manually applied orange flag downgrades Approve to Caution. Auto-flags do not trigger these overrides — only human-set flags do.</div>
              </li>
            </ol>
          </CardContent>
        </Card>

      <Card className="border-border bg-card">
        <CardContent className="space-y-2 p-4 text-sm text-muted-foreground">
          <p>Sites analyse credit using the locally cached config, so the last good version keeps working if Hub is unreachable.</p>
          <p>Current source: <span className="font-medium text-foreground">{current?.source || "default"}</span></p>
          <p>Last synced: <span className="font-medium text-foreground">{current?.lastSyncedAt ? new Date(current.lastSyncedAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "Never"}</span></p>
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
}

// ─── Accounting Settings Tab ──────────────────────────────────────────────
// Stores company-wide accounting parameters (currently just VAT %) used by
// the Reconciliation page to detect VAT-shaped variances between BAT and
// Sage credit notes. Backed by the bat_settings key/value table; the
// /api/bat/settings endpoint is already gated behind requireAdmin so the
// PUT here is admin-only by construction. The native confirm() before
// save is a guard so an admin doesn't fat-finger the rate (the value
// retroactively changes how every weekly variance is interpreted).
const VAT_DEFAULT = 15;
function AccountingTab() {
  const [vatPercent, setVatPercent] = useState(VAT_DEFAULT);
  const [originalVat, setOriginalVat] = useState(VAT_DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/bat/settings', { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(d => {
        const raw = d.vat_percent;
        const parsed = raw === undefined || raw === null || raw === ''
          ? VAT_DEFAULT
          : Number(raw);
        const v = Number.isFinite(parsed) ? parsed : VAT_DEFAULT;
        setVatPercent(v);
        setOriginalVat(v);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    const v = Number(vatPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      toast.error('VAT must be a number between 0 and 100');
      return;
    }
    if (v === originalVat) {
      toast.info('No change');
      return;
    }
    const ok = window.confirm(
      `Change VAT rate from ${originalVat}% to ${v}%?\n\n` +
      `This affects how every weekly BAT-vs-Sage variance is interpreted on the Reconciliation page. ` +
      `Existing reconciliations are not modified, but the "Missing VAT" indicator will recalculate using the new rate.`
    );
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch('/api/bat/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vat_percent: String(v) }),
      });
      if (res.ok) {
        toast.success(`VAT rate set to ${v}%`);
        setOriginalVat(v);
      } else {
        toast.error('Failed to save');
      }
    } catch { toast.error('Network error'); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="flex items-center justify-center py-12"><div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" /></div>;

  const dirty = Number(vatPercent) !== originalVat;

  return (
    <div className="space-y-8">
      <section className="space-y-6">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">§ Section</div>
            <h2 className="font-display text-2xl text-foreground leading-tight mt-0.5">VAT</h2>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            Used by Reconciliation · "Missing VAT" detector
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Standard VAT rate</h3>
            <p className="text-xs text-muted-foreground">
              The percentage applied when comparing BAT (excl. VAT) to Sage credit-note totals.
              When the variance for a week equals this percentage of the BAT amount, the Reconciliation
              page flags the row as <span className="font-mono">missing VAT</span>.
            </p>
          </div>

          <div className="space-y-4 pl-3 border-l-2 border-border/40">
            <div className="space-y-2 max-w-xs">
              <label className="text-xs font-medium text-foreground">VAT (%)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={vatPercent}
                  onChange={e => setVatPercent(e.target.value)}
                  className="flex-1 rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
                />
                <span className="text-sm text-muted-foreground font-mono">%</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Default <span className="font-mono">{VAT_DEFAULT}%</span>. Changes apply immediately to all weekly variance calculations.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  borderRadius: '12px',
                  borderColor: 'var(--phosphor)',
                  color: 'var(--phosphor)',
                  background: dirty ? 'hsla(33, 95%, 55%, 0.08)' : 'transparent',
                }}
              >
                {saving ? 'Saving…' : dirty ? 'Save VAT rate' : 'Saved'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── Reconciliation Settings Tab ──────────────────────────────────────────
function ReconciliationSettingsTab() {
  const [settings, setSettings] = useState({ google_vision_key: '', ocr_space_key: '', invoice_in_digit_length: '9' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showGvKey, setShowGvKey] = useState(false);
  const [showOcrKey, setShowOcrKey] = useState(false);

  useEffect(() => {
    fetch('/api/bat/settings', { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(d => { setSettings(s => ({ ...s, ...d })); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/bat/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (res.ok) toast.success('Reconciliation settings saved');
      else toast.error('Failed to save');
    } catch { toast.error('Network error'); }
    finally { setSaving(false); }
  };

  const maskKey = (key) => key ? key.substring(0, 8) + '•'.repeat(Math.max(0, key.length - 12)) + key.substring(key.length - 4) : '';

  if (loading) return <div className="flex items-center justify-center py-12"><div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" /></div>;

  return (
    <div className="space-y-8">
      {/* ── OCR ─────────────────────────────────────────────────────────── */}
      <section className="space-y-6">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">§ Section</div>
            <h2 className="font-display text-2xl text-foreground leading-tight mt-0.5">OCR</h2>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            Pipeline · Google Vision → ocr.space E1 → E3 → Tesseract → E2
          </p>
        </div>

        {/* API keys */}
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">API keys</h3>
            <p className="text-xs text-muted-foreground">Override the env-var defaults. Stored locally in <span className="font-mono">bat_settings</span>.</p>
          </div>

          <div className="space-y-4 pl-3 border-l-2 border-border/40">
            <div className="space-y-2">
              <label className="text-xs font-medium text-foreground flex items-center justify-between">
                Google Vision API Key
                <span className="text-[10px] text-accent font-mono uppercase tracking-wider">Primary OCR</span>
              </label>
              <div className="flex gap-2">
                <input
                  type={showGvKey ? 'text' : 'password'}
                  value={settings.google_vision_key || ''}
                  onChange={e => setSettings(s => ({ ...s, google_vision_key: e.target.value }))}
                  placeholder="AIzaSy..."
                  className="flex-1 rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowGvKey(v => !v)}
                  className="px-3 py-2 border border-border rounded-[2px] text-xs text-muted-foreground hover:text-foreground hover:border-[var(--phosphor)] transition-colors"
                >
                  {showGvKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                From Google Cloud Console → APIs &amp; Services → Credentials. Requires Cloud Vision API enabled with billing.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-foreground flex items-center justify-between">
                ocr.space API Key
                <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Fallback OCR</span>
              </label>
              <div className="flex gap-2">
                <input
                  type={showOcrKey ? 'text' : 'password'}
                  value={settings.ocr_space_key || ''}
                  onChange={e => setSettings(s => ({ ...s, ocr_space_key: e.target.value }))}
                  placeholder="K890..."
                  className="flex-1 rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowOcrKey(v => !v)}
                  className="px-3 py-2 border border-border rounded-[2px] text-xs text-muted-foreground hover:text-foreground hover:border-[var(--phosphor)] transition-colors"
                >
                  {showOcrKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                From ocr.space → My Account → API Key. Free key has rate limits. Paid key recommended.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
                style={{
                  borderRadius: '12px',
                  borderColor: 'var(--phosphor)',
                  color: 'var(--phosphor)',
                  background: 'hsla(33, 95%, 55%, 0.08)',
                }}
                onMouseEnter={(e) => {
                  if (e.currentTarget.disabled) return;
                  e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.18)';
                  e.currentTarget.style.boxShadow = '0 0 12px hsla(33,95%,55%,0.35)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.08)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {saving ? 'Saving…' : 'Save Keys'}
              </button>
            </div>
          </div>
        </div>

        {/* Invoice number format — drives findInvoiceNumber's pad behaviour.
            Legacy stores use IN + 9 digits (IN000xxxxxx); newer onboarded
            sites use IN + 8 digits (IN00xxxxxx). Wrong length here means
            correctly-read invoices get padded to a non-existent number and
            never match Cardoso. */}
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Invoice number format</h3>
            <p className="text-xs text-muted-foreground">
              How many digits follow the <span className="font-mono">IN</span> prefix on this site's invoices. Used to recover dropped-zero OCR errors without over-padding correctly-read shorter numbers.
            </p>
          </div>
          <div className="space-y-2 pl-3 border-l-2 border-border/40">
            <label className="text-xs font-medium text-foreground">IN digit length</label>
            <select
              value={settings.invoice_in_digit_length || '9'}
              onChange={e => setSettings(s => ({ ...s, invoice_in_digit_length: e.target.value }))}
              className="rounded-[2px] border border-input bg-background text-foreground px-3 py-2 text-sm font-mono focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
            >
              <option value="8" className="bg-background text-foreground">8 digits — IN00xxxxxx</option>
              <option value="9" className="bg-background text-foreground">9 digits — IN000xxxxxx (default)</option>
            </select>
            <p className="text-[10px] text-muted-foreground">
              Saved with the API keys above via <span className="font-mono">Save Keys</span>.
            </p>
          </div>
        </div>

        {/* Worker + Re-queue — share the same section as API keys since they
            all configure the OCR pipeline. The components handle their own
            internal layout; the wrapper just gives them consistent indentation. */}
        <div className="space-y-6">
          <OcrPauseToggle embedded />
          <ResetPendingOcrTool embedded />
        </div>
      </section>

      {/* ── Cardoso replication (not OCR — separate concern) ────────────── */}
      <section>
        <ReplicateSupplierTool embedded />
      </section>
    </div>
  );
}

// Re-queues every "not_found" / "failed" OCR row back to "pending" so the
// next worker run re-attempts them. Already-matched ("found") rows are left
// alone — no risk of redoing successful extractions.
function ResetPendingOcrTool({ embedded = false }) {
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/bat/reset-pending-count', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCount(d.count); })
      .catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const reset = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/bat/reset-pending', { method: 'POST', credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Reset failed');
      toast.success(`Re-queued ${d.reset} extraction${d.reset === 1 ? '' : 's'} for OCR.`);
      setConfirming(false);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`space-y-3 ${embedded ? '' : 'pt-4 border-t border-border'}`}>
      <div>
        <h3 className="text-sm font-semibold mb-1">Re-queue failed OCRs</h3>
        <p className="text-xs text-muted-foreground">
          Flips every <span className="font-mono">not_found</span> and <span className="font-mono">failed</span> extraction back to <span className="font-mono">pending</span> so the OCR worker re-attempts them on the next run. Already-found rows are left alone.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-sm text-muted-foreground">
          {count == null ? 'Counting…' : count === 0 ? 'Nothing to re-queue.' : `${count} extraction${count === 1 ? '' : 's'} eligible.`}
        </div>
        {!confirming ? (
          <Button
            onClick={() => setConfirming(true)}
            disabled={busy || !count}
            variant="outline"
            size="sm"
            className="border-border text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Re-queue {count || 0}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button onClick={reset} disabled={busy} variant="default" size="sm">
              {busy ? 'Working…' : `Confirm: re-queue ${count}`}
            </Button>
            <Button onClick={() => setConfirming(false)} disabled={busy} variant="outline" size="sm" className="border-border">
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function OcrPauseToggle({ embedded = false }) {
  const [status, setStatus] = useState(null); // { paused, pending }
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/bat/ocr-status', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setStatus(d); })
      .catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const toggle = async () => {
    if (!status) return;
    const next = !status.paused;
    setBusy(true);
    try {
      const r = await fetch('/api/bat/ocr-pause', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setStatus((s) => ({ ...(s || {}), paused: d.paused }));
      toast.success(d.paused ? 'OCR paused' : (d.resumed ? 'OCR resumed — worker started' : 'OCR resumed'));
      refresh();
    } catch (err) {
      toast.error(humanizeApiError(err, "toggle OCR pause"));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const paused = !!status.paused;

  return (
    <div className={`space-y-3 ${embedded ? '' : 'pt-6 mt-6 border-t border-border'}`}>
      <div>
        <h3 className="text-sm font-semibold mb-1">Worker</h3>
        <p className="text-xs text-muted-foreground">
          When paused, no new POD invoices will be processed and the worker won't auto-resume on server restart. The currently in-flight invoice (if any) finishes before the worker stops.
        </p>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground tabular-nums">
          Status:{' '}
          <span className={paused ? 'text-destructive' : 'text-[hsl(145_55%_45%)]'}>
            {paused ? '● Paused' : '● Running'}
          </span>
          {' · '}
          <span className="text-foreground">{status.pending}</span> pending invoice{status.pending === 1 ? '' : 's'}
        </p>
        <button
          onClick={toggle}
          disabled={busy}
          className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
          style={{
            borderRadius: '12px',
            borderColor: paused ? 'hsl(145 55% 45%)' : 'var(--phosphor)',
            color: paused ? 'hsl(145 55% 45%)' : 'var(--phosphor)',
            background: 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = paused ? 'hsla(145, 55%, 45%, 0.12)' : 'hsla(33, 95%, 55%, 0.12)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {busy ? 'Working…' : (paused ? 'Resume OCR' : 'Pause OCR')}
        </button>
      </div>
    </div>
  );
}

function ReplicateSupplierTool({ embedded = false }) {
  const [stats, setStats] = useState(null);
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pwd, setPwd] = useState('');

  const refresh = useCallback(() => {
    fetch('/api/bat/cardoso-invoices/overwrite-stats', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setStats(d); })
      .catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const handleRun = async (e) => {
    e?.preventDefault?.();
    if (!pwd) { toast.error('Admin password required'); return; }
    setRunning(true);
    try {
      const r = await fetch('/api/bat/cardoso-invoices/replicate-supplier', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success(`Overwrote ${d.updated} cardoso rows · ${d.totalOverwritten} total · ${d.remainingNotOverwritten} remaining`);
      setConfirmOpen(false);
      setPwd('');
      refresh();
    } catch (err) {
      toast.error(`Overwrite failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`space-y-6 ${embedded ? '' : 'pt-6 mt-6 border-t border-border'}`}>
      <div className="flex items-baseline justify-between border-b border-border pb-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">§ Section</div>
          <h2 className="font-display text-2xl text-foreground leading-tight mt-0.5">Cardoso replication</h2>
        </div>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold mb-1">Replicate Supplier → Cardoso</h3>
        <p className="text-xs text-muted-foreground">
          Copies S.Pricing and S.Discount onto matching Cardoso rows (C.Pricing / C.Discount). C.DelFee is preserved. Idempotent — only touches rows that haven't been overwritten yet. <span className="text-destructive">Admin password required.</span>
        </p>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground tabular-nums">
          {stats ? `${stats.overwritten}/${stats.total} cardoso rows overwritten · ${stats.remaining} remaining` : 'Loading…'}
        </p>
        {!confirmOpen ? (
          <button
            onClick={() => setConfirmOpen(true)}
            className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
            style={{
              borderRadius: '12px',
              borderColor: 'hsl(var(--destructive))',
              color: 'hsl(var(--destructive))',
              background: 'hsla(0, 72%, 50%, 0.08)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.18)';
              e.currentTarget.style.boxShadow = '0 0 12px hsla(0, 72%, 50%, 0.35)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.08)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            Run overwrite
          </button>
        ) : (
          <form onSubmit={handleRun} className="flex items-center gap-2">
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="Admin password"
              className="rounded-[2px] border border-input bg-transparent px-3 py-2 text-xs font-mono focus:border-destructive focus:ring-1 focus:ring-destructive outline-none w-44"
            />
            <button
              type="submit"
              disabled={running || !pwd}
              className="px-3 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
              style={{
                borderRadius: '12px',
                borderColor: 'hsl(var(--destructive))',
                color: 'hsl(var(--destructive))',
                background: 'hsla(0, 72%, 50%, 0.08)',
              }}
              onMouseEnter={(e) => {
                if (e.currentTarget.disabled) return;
                e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.18)';
                e.currentTarget.style.boxShadow = '0 0 12px hsla(0, 72%, 50%, 0.35)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.08)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {running ? 'Running…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmOpen(false); setPwd(''); }}
              disabled={running}
              className="px-3 py-2 border border-border text-muted-foreground font-mono text-[10px] uppercase tracking-[0.2em] hover:text-foreground transition-colors"
              style={{ borderRadius: '12px' }}
            >
              Cancel
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── ntopng / Network Settings Tab ────────────────────────────────────────
function NtopngTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["ntopng-settings"],
    queryFn: async () => {
      const r = await fetch("/api/hub/ntopng/settings", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load ntopng settings");
      return r.json();
    },
  });

  const [form, setForm] = useState({ ntopng_url: "", ntopng_user: "", ntopng_password: "" });
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (data) {
      setForm({
        ntopng_url: data.ntopng_url || "http://localhost:3000",
        ntopng_user: data.ntopng_user || "admin",
        // password is redacted server-side; keep blank so user can update it
        ntopng_password: "",
      });
      setDirty(false);
    }
  }, [data]);

  const handleChange = (field, value) => {
    setForm(f => ({ ...f, [field]: value }));
    setDirty(true);
    setTestResult(null);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/hub/ntopng/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error("Save failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("ntopng settings saved");
      queryClient.invalidateQueries(["ntopng-settings"]);
      setDirty(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/hub/ntopng/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      const d = await r.json();
      setTestResult(d.ok ? { ok: true, msg: "Connected — " + (d.version || "ntopng responding") } : { ok: false, msg: d.error || "Connection failed" });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-base font-semibold mb-1">ntopng Connection</h3>
        <p className="text-sm text-muted-foreground mb-4">Configure the ntopng instance running on this Hub machine. Used by the Network Devices dashboard.</p>

        <div className="space-y-4">
          <div>
            <Label className="text-sm font-medium">ntopng URL</Label>
            <Input
              className="mt-1"
              placeholder="http://localhost:3000"
              value={form.ntopng_url}
              onChange={e => handleChange("ntopng_url", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-sm font-medium">Username</Label>
            <Input
              className="mt-1"
              placeholder="admin"
              value={form.ntopng_user}
              onChange={e => handleChange("ntopng_user", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-sm font-medium">Password</Label>
            <Input
              className="mt-1"
              type="password"
              placeholder={data?.password_set ? "(password saved — leave blank to keep)" : "ntopng admin password"}
              value={form.ntopng_password}
              onChange={e => handleChange("ntopng_password", e.target.value)}
            />
          </div>
        </div>

        {testResult && (
          <p className={cn("text-sm mt-3", testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
            {testResult.ok ? "✓" : "✗"} {testResult.msg}
          </p>
        )}

        <div className="flex gap-2 mt-5">
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <h3 className="text-base font-semibold mb-1">Interface Naming Convention</h3>
        <p className="text-sm text-muted-foreground">
          Each site's nProbe instance must use <code className="text-xs bg-muted px-1 py-0.5 rounded">--interface-name nprobe-&lt;slug&gt;</code> where
          <code className="text-xs bg-muted px-1 py-0.5 rounded ml-1">&lt;slug&gt;</code> matches the site slug configured in <strong>HUB_SITES</strong>.
          For example: <code className="text-xs bg-muted px-1 py-0.5 rounded">nprobe-jhb</code>.
        </p>
      </div>
    </div>
  );
}

// ─── TLS Tab ──────────────────────────────────────────────────────────────────
// Surfaces the live state of the Hub's reverse-proxy / TLS deployment so an
// admin can see whether HTTPS is actually fronting the app, when the cert
// expires, and whether the CardosoCaddy service is running. Backed by
// /api/system/tls-status (read-only) and /api/system/tls-renew-cert (POST).
function HubConnectionSection() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState(null);
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/system/hub-url', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      setData(json);
      setDraft(json.configured || json.envSeed || '');
    } catch (e) {
      reportClientError('SettingsPanel.hubUrl.load', e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      const r = await fetch('/api/system/hub-probe', { method: 'POST', credentials: 'include' });
      const json = await r.json();
      setProbe(json);
    } catch (e) {
      setProbe({ ok: false, error: e.message });
    } finally {
      setProbing(false);
    }
  }, []);

  // Auto-probe once on first load so the operator sees green/red without
  // having to click. Subsequent probes are manual via the button.
  useEffect(() => { if (data && !probe) runProbe(); }, [data, probe, runProbe]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/system/hub-url', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: draft.trim() }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      toast.success(draft.trim() ? 'Hub URL updated' : 'Hub URL override cleared');
      setProbe(json.probe || null);
      setEditing(false);
      await load();
    } catch (e) {
      toast.error(e.message || 'Failed to save Hub URL');
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <div className="h-20 animate-pulse bg-muted rounded-xl" />;

  const probeBadge = !probe ? null : probe.ok ? (
    <Badge className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">REACHABLE</Badge>
  ) : (
    <Badge variant="destructive" className="text-[10px]">UNREACHABLE</Badge>
  );

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold mb-1">Hub connection</h3>
          <p className="text-xs text-muted-foreground">
            URL this site uses to reach the Hub for credit-logic sync, central reporting, and SSO. Override the
            installer's <code className="text-[11px] bg-muted px-1 py-0.5 rounded">.env</code> seed without editing files on disk.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {probeBadge}
          <Button variant="ghost" size="sm" onClick={runProbe} disabled={probing} title="Re-test now">
            <RefreshCw className={cn("h-3.5 w-3.5", probing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground w-28 shrink-0">Effective</span>
          <code className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded break-all">{data.effective || '— (not configured)'}</code>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground w-28 shrink-0">Override</span>
          <code className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded break-all">{data.configured || '— (none — using .env)'}</code>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground w-28 shrink-0">.env seed</span>
          <code className="font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded break-all">{data.envSeed || '—'}</code>
        </div>
        {probe && !probe.ok && (
          <div className="flex items-start gap-2 mt-2 text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="break-all">{probe.error}</span>
          </div>
        )}
      </div>

      {!editing ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit override
          </Button>
        </div>
      ) : (
        <div className="space-y-2 pt-1 border-t border-border">
          <label className="text-xs font-medium text-foreground">New hub URL</label>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://cardoso-headoffice.your-tailnet.ts.net:8443"
            className="w-full rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
          />
          <p className="text-[10px] text-muted-foreground">
            Include scheme and any non-default port (e.g. <code>:8443</code> if Caddy isn't on 443). Leave blank to clear the override.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setEditing(false); setDraft(data.configured || data.envSeed || ''); }} disabled={saving}>
              Cancel
            </Button>
            <Button variant="default" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save & probe'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TlsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/system/tls-status', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      setData(json);
    } catch (e) {
      setError(e.message || 'Failed to load TLS status');
      reportClientError('SettingsPanel.tls.load', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRenew = async () => {
    if (!confirm('Re-issue the TLS cert via tailscale and restart the CardosoCaddy service? Brief downtime (~2s) while Caddy restarts.')) return;
    setRenewing(true);
    try {
      const r = await fetch('/api/system/tls-renew-cert', { method: 'POST', credentials: 'include' });
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      toast.success(json.message || 'Cert renewed.');
      await load();
    } catch (e) {
      toast.error(e.message || 'Renewal failed');
      reportClientError('SettingsPanel.tls.renew', e);
    } finally {
      setRenewing(false);
    }
  };

  if (loading && !data) return <div className="h-20 animate-pulse bg-muted rounded-xl" />;
  if (error && !data) {
    return (
      <div className="space-y-3 max-w-3xl">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  const postureMeta = {
    tls_fronted:   { label: 'TLS fronted',     icon: ShieldCheck, tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' },
    http_lan_only: { label: 'HTTP (LAN only)', icon: Lock,        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' },
    partial:       { label: 'Partial / inconsistent', icon: ShieldAlert, tone: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30' },
  };
  const posture = postureMeta[data.posture] || postureMeta.partial;
  const PostureIcon = posture.icon;

  const isWindows = data.platform === 'win32';
  const canRenew = isWindows && data.posture === 'tls_fronted' && data.caddyfile?.hostname;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Posture summary */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-1">TLS deployment status</h3>
          <p className="text-xs text-muted-foreground">
            Live state of the Hub's reverse-proxy and TLS configuration. Read-only — install/uninstall is done via{' '}
            <code className="text-[11px] bg-muted px-1 py-0.5 rounded">scripts/install-hub-caddy.ps1</code> on the Hub server.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} title="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <div className={cn("flex items-center gap-3 rounded-lg border px-4 py-3", posture.tone)}>
        <PostureIcon className="h-5 w-5 shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-semibold">{posture.label}</div>
          <div className="text-xs opacity-80">
            Backend bound to <code className="text-[11px] bg-black/5 dark:bg-white/10 px-1 rounded">{data.bind_address}:{data.port}</code>
            {' · '}TLS_FRONTING={String(data.tls_fronting)}
          </div>
        </div>
      </div>

      {/* Hub connection — sites only. Hub URL was historically only in
          .env, which made port/scheme drift (e.g. Caddy on :8443 but .env
          says :443) invisible until a sync silently failed. Surfacing it
          here lets the operator fix it from the UI without RDP'ing. */}
      {!data.hub_mode && <HubConnectionSection />}

      {/* Runtime */}
      <Section title="Runtime">
        <Row label="Platform" value={data.platform} />
        <Row label="Hub mode" value={String(data.hub_mode)} />
        <Row label="Bind address" value={`${data.bind_address}:${data.port}`} mono />
        <Row label="TLS fronting" value={String(data.tls_fronting)} />
      </Section>

      {/* Caddy install */}
      <Section title="Caddy">
        {!isWindows ? (
          <p className="text-xs text-muted-foreground">Caddy install detection is Windows-only. (Running on {data.platform}.)</p>
        ) : !data.caddy?.installed ? (
          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Not installed. Run <code className="bg-muted px-1 py-0.5 rounded">scripts/install-hub-caddy.ps1</code> on the Hub server.
          </div>
        ) : (
          <>
            <Row label="Install dir" value={data.caddy.dir} mono />
            <Row label="Executable" value={data.caddy.exe} mono />
          </>
        )}
      </Section>

      {/* Caddyfile */}
      {isWindows && (
        <Section title="Caddyfile">
          {!data.caddyfile ? (
            <p className="text-xs text-muted-foreground">No Caddyfile found.</p>
          ) : (
            <>
              <Row label="Path" value={data.caddyfile.path} mono />
              <Row label="Hostname" value={data.caddyfile.hostname || '—'} mono />
              <Row label="Backend port" value={data.caddyfile.backend_port ?? '—'} mono />
            </>
          )}
        </Section>
      )}

      {/* Cert */}
      {isWindows && (
        <Section title="TLS certificate">
          {!data.cert ? (
            <p className="text-xs text-muted-foreground">No cert found at expected path.</p>
          ) : data.cert.error ? (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {data.cert.error}
            </div>
          ) : (
            <>
              <Row label="Subject" value={data.cert.subject} mono />
              <Row label="Issuer" value={data.cert.issuer} mono />
              <Row label="Valid from" value={data.cert.valid_from} mono />
              <Row label="Valid to" value={data.cert.valid_to} mono />
              <Row
                label="Days until expiry"
                value={
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{data.cert.days_until_expiry}</span>
                    {data.cert.warning === 'expired' && (
                      <Badge variant="destructive" className="text-[10px]">EXPIRED</Badge>
                    )}
                    {data.cert.warning === 'expiring_soon' && (
                      <Badge className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">EXPIRING SOON</Badge>
                    )}
                    {!data.cert.warning && data.cert.days_until_expiry > 0 && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </span>
                }
              />
            </>
          )}
        </Section>
      )}

      {/* Service */}
      {isWindows && (
        <Section title="Windows service">
          <Row label="Name" value={data.service?.name || 'CardosoCaddy'} mono />
          <Row
            label="Status"
            value={
              <span className="flex items-center gap-2">
                <span className="font-mono">{data.service?.status || 'unknown'}</span>
                {data.service?.status === 'running' && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                )}
                {data.service?.status === 'stopped' && (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                )}
                {data.service?.status === 'not_installed' && (
                  <Badge variant="outline" className="text-[10px]">NOT INSTALLED</Badge>
                )}
              </span>
            }
          />
        </Section>
      )}

      {/* Actions */}
      {isWindows && (
        <div className="border-t pt-4 flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={handleRenew}
            disabled={renewing || !canRenew}
            title={!canRenew ? 'Renewal requires a fully TLS-fronted Hub with a Caddyfile hostname.' : undefined}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", renewing && "animate-spin")} />
            {renewing ? 'Renewing…' : 'Renew cert now'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Re-runs <code className="text-[11px] bg-muted px-1 py-0.5 rounded">tailscale cert</code> and restarts Caddy.
          </span>
        </div>
      )}

      {/* Docs */}
      <div className="border-t pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Docs</h4>
        <ul className="space-y-1 text-xs">
          {Object.entries(data.docs || {}).map(([k, v]) => (
            <li key={k} className="flex items-center gap-1.5">
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
              <span className="capitalize text-muted-foreground">{k.replace(/_/g, ' ')}:</span>
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">{v}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border-t pt-4">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("flex-1 break-all", mono && "font-mono")}>{value}</span>
    </div>
  );
}

export default function SettingsPanel({ open, onClose, hubMode }) {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || isAdmin;

  // Build tabs based on context
  const tabs = [
    canManageUsers && { id: "users", label: "Users" },
    canManageRules && { id: "creditlogic", label: "Credit Logic" },
    { id: "autoflag", label: "Auto-Flag Rules" },
    { id: "fields", label: "Fields" },
    !hubMode && { id: "connections", label: "Connections" },
    !hubMode && isAdmin && { id: "audit", label: "Audit Log" },
    // System Log + Updates moved to the Operations page (PR #185). Kept
    // out of Settings to avoid two-places-to-look for the same data.
    isAdmin && { id: "tls", label: "TLS" },
    !hubMode && isAdmin && { id: "maintenance", label: "Maintenance" },
    hubMode && { id: "synclog", label: "Sync Log" },
    hubMode && isAdmin && { id: "hubmaintenance", label: "Maintenance" },
    hubMode && isAdmin && { id: "network", label: "Network" },
    isAdmin && { id: "reconciliation", label: "Reconciliation" },
    isAdmin && { id: "accounting", label: "Accounting" },
  ].filter(Boolean);

  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? "autoflag");

  // Reset to first tab when opened
  useEffect(() => { if (open) setActiveTab(tabs[0]?.id ?? "autoflag"); }, [open]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-6xl w-full h-[100dvh] sm:h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">
            § Settings
          </div>
          <DialogTitle className="font-display text-4xl leading-tight tracking-tight text-foreground">
            Configure the <em className="text-phosphor">ledger</em>.
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 overflow-hidden">
          <TabsList className="mx-6 mt-4 shrink-0 justify-start overflow-x-auto flex-nowrap">
            {tabs.map(t => (
              <TabsTrigger key={t.id} value={t.id} className="shrink-0">{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {tabs.map(t => (
              <TabsContent key={t.id} value={t.id} className="mt-0">
                {t.id === "users"    && <UsersTabContent />}
                {t.id === "creditlogic" && <CreditLogicTab hubMode={hubMode} currentUser={currentUser} />}
                {t.id === "autoflag" && <AutoFlagTab hubMode={hubMode} />}
                {t.id === "fields"   && <FieldsTab />}
                {t.id === "audit"    && <AuditTab />}
                {t.id === "tls"      && <TlsTab />}
                {t.id === "synclog"       && <SyncLogTab />}
                {t.id === "connections"  && <ConnectionsTab currentUser={currentUser} />}
                {t.id === "maintenance"  && <MaintenanceTab />}
                {t.id === "hubmaintenance" && <HubMaintenanceTab />}
                {t.id === "network"      && <NtopngTab />}
                {t.id === "reconciliation" && <ReconciliationSettingsTab />}
                {t.id === "accounting"     && <AccountingTab />}
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// UsersTabContent — render the Users page in embedded mode
function UsersTabContent() {
  // Dynamic import to avoid circular issues at module load time
  const [UsersPage, setUsersPage] = useState(null);
  useEffect(() => {
    import("../../pages/Users").then(m => setUsersPage(() => m.default));
  }, []);
  if (!UsersPage) return <div className="h-20 animate-pulse bg-muted rounded-xl" />;
  return <UsersPage embedded />;
}
