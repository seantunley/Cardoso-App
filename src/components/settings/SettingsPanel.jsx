import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/lib/permissions";

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
  Lock, ShieldCheck, ShieldAlert, ExternalLink,
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
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateLocalConnection(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); setModalOpen(false); setEditingConnection(null); toast.success("Connection updated"); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteLocalConnection,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); toast.success("Connection deleted"); },
    onError: (e) => toast.error(`Failed: ${e.message}`),
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
    } catch (e) { toast.error(`Sync failed: ${e.message}`); }
    finally { setIsSyncingAll(false); }
  };

  const handleSync = async (conn) => {
    setSyncingId(conn.id);
    try {
      const r = await runLocalImport(conn.id);
      toast.success(r.message || `Synced ${conn.name} (${r.imported || 0} records)`);
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
    } catch (e) { toast.error(`Failed: ${e.message}`); }
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

// ─── System Log Tab ──────────────────────────────────────────────────────────
// Reads the error_log table populated by src/lib/errorLog.js. Surfaces server
// crashes, OCR failures, Sage pool errors, and browser-side errors so an
// off-site operator can diagnose without terminal access.

function SystemLogTab() {
  const [sourceFilter, setSourceFilter] = useState("");
  const [sinceHours, setSinceHours] = useState(24 * 7);
  const [expandedId, setExpandedId] = useState(null);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["error-log", sourceFilter, sinceHours],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "500");
      params.set("sinceHours", String(sinceHours));
      if (sourceFilter) params.set("source", sourceFilter);
      const r = await fetch(`/api/error-log?${params}`, { credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to load");
      return d;
    },
    refetchInterval: 30_000,
  });

  const fmt = (dt) => {
    if (!dt) return "—";
    // logError writes ISO strings (with trailing Z), but SQLite's
    // datetime('now') default uses space-separated UTC (no Z). Normalise:
    // if no Z/offset, treat as UTC by appending Z so the toLocaleString
    // call below converts to the user's display zone correctly.
    const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dt)
      ? dt
      : dt.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return dt; // last resort — show raw rather than "Invalid Date"
    return d.toLocaleString("en-ZA", {
      timeZone: "Africa/Johannesburg",
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  };
  const rows = data?.rows || [];
  const sources = data?.sources || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Source</label>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-9 px-3 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All sources</option>
            {sources.map(s => (
              <option key={s.source} value={s.source}>{s.source} ({s.n})</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Window</label>
          <select
            value={sinceHours}
            onChange={(e) => setSinceHours(Number(e.target.value))}
            className="h-9 px-3 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value={1}>Last hour</option>
            <option value={24}>Last 24 hours</option>
            <option value={24 * 7}>Last 7 days</option>
            <option value={24 * 30}>Last 30 days</option>
            <option value={24 * 90}>Last 90 days</option>
          </select>
        </div>
        <Button onClick={() => refetch()} disabled={isRefetching} variant="outline" size="sm" className="border-border text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-4 h-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <div className="ml-auto text-xs text-muted-foreground">
          {isLoading ? "Loading…" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-700 bg-rose-900/20 p-4 text-sm text-rose-300">
          {error.message || "Failed to load error log"}
        </div>
      )}

      {isLoading ? (
        <div className="h-20 animate-pulse bg-muted rounded-xl" />
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground text-sm border border-dashed border-border rounded-xl">
          <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto mb-2" />
          No errors recorded in the selected window.
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-44">When</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-40">Source</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = expandedId === r.id;
                const hasDetail = r.stack || r.context;
                return (
                  <>
                    <tr
                      key={r.id}
                      onClick={() => hasDetail && setExpandedId(isOpen ? null : r.id)}
                      className={`border-b border-border last:border-0 hover:bg-muted/20 ${hasDetail ? "cursor-pointer" : ""}`}
                    >
                      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{fmt(r.occurred_at)}</td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-muted/60 text-foreground">
                          <AlertTriangle className="w-3 h-3 text-amber-500" />
                          {r.source}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-foreground break-words">{r.message}</td>
                    </tr>
                    {isOpen && hasDetail && (
                      <tr key={`${r.id}-detail`} className="border-b border-border bg-muted/10">
                        <td colSpan={3} className="px-4 py-3 space-y-2">
                          {r.context && (
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Context</div>
                              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">{r.context}</pre>
                            </div>
                          )}
                          {r.stack && (
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Stack</div>
                              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">{r.stack}</pre>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
    onError: (e) => toast.error(`Failed: ${e.message}`),
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
    onError: (e) => toast.error(`Failed to clear: ${e.message}`),
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
      failed.forEach((result) => toast.error(`${result.site}: ${result.status}`));
      setPushModalOpen(false);
      setSelectedSiteIds(new Set());
    },
    onError: (error) => toast.error(error.message || 'Failed to push rules'),
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

function UpdateTab() {
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  // Live in-progress state, populated from /api/app-version-status while an
  // update is running. `tick` is just a counter that re-renders once a second
  // so the elapsed-time string keeps updating between 4 s polls.
  const [progress, setProgress] = useState(null); // { phase, startedAt }
  const [tick, setTick] = useState(0);
  // Update-log viewer state. Populated on demand by clicking "View update log"
  // (cheap to fetch, but ~100 lines so we don't preload it on mount).
  const [logLines, setLogLines] = useState(null);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    fetch("/api/app-version-status", { credentials: "include" })
      .then(r => r.json())
      .then(d => setInfo(d))
      .catch(err => reportClientError("SettingsPanel.versionStatus", err));
  }, []);

  const fetchUpdateLog = async () => {
    setLogLoading(true);
    try {
      const r = await fetch("/api/app-update-log", { credentials: "include" });
      const d = await r.json();
      setLogLines(d.lines || []);
    } catch (err) {
      toast.error(`Couldn't load update log: ${err.message}`);
    } finally {
      setLogLoading(false);
    }
  };

  // 1-Hz tick while an update is in progress so "(2m 18s)" advances visibly.
  useEffect(() => {
    if (status !== "updating") return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  const handleCheck = async () => {
    setStatus("checking");
    try {
      const r = await fetch("/api/app-version-status", { credentials: "include" });
      const d = await r.json();
      setInfo(d);
      setStatus(d.updateAvailable ? "update-available" : "up-to-date");
    } catch {
      setStatus("error");
    }
  };

  const handleUpdate = async () => {
    setStatus("updating");
    try {
      const r = await fetch("/api/app-update-trigger", { method: "POST", credentials: "include" });
      const d = await r.json();
      // Backend returns { ok: true, message, mode? } on success, { ok: false, error }
      // on failure (status 500). Older check was looking for d.success or
      // d.message containing "download" — neither matches the actual response,
      // which made every successful update look like a failure in the UI.
      if (r.ok && d.ok) {
        setStatus("updating");
        const note = d.mode === 'delta'
          ? "Delta update started — the page will reload automatically once ready."
          : "Update started — the page will reload automatically once ready.";
        toast.success(note);
        // Poll until the version changes, then reload. Each poll also
        // refreshes the live phase/startedAt so the UI message tracks where
        // the install actually is.
        const targetVersion = info?.latestVersion;
        const pollStartedAt = Date.now();
        const POLL_HARD_CAP_MS = 12 * 60 * 1000; // give up after 12 min total
        const poll = async () => {
          try {
            const pr = await fetch("/api/app-version-status", { credentials: "include" });
            if (!pr.ok) throw new Error("not ready");
            const pd = await pr.json();
            if (pd.updateRunning) {
              setProgress({ phase: pd.updatePhase, startedAt: pd.updateStartedAt });
            }
            // Update landed — reload to pick up the new bundle.
            if (pd.currentVersion && pd.currentVersion === targetVersion) {
              window.location.reload();
              return;
            }
            // Marker says the update finished but didn't land (rollback or
            // hard fail). Stop polling and surface the error — previously
            // the UI just span forever in this state until the user gave up.
            if (pd.lastUpdateFailed) {
              setInfo(pd);
              setStatus("error");
              toast.error(pd.lastUpdateError
                ? `Update failed: ${String(pd.lastUpdateError).slice(0, 200)}`
                : 'Update finished but did not land. View the log for details.');
              return;
            }
          } catch { /* service still restarting */ }
          if (Date.now() - pollStartedAt > POLL_HARD_CAP_MS) {
            setStatus("error");
            toast.error('Update did not complete within 12 minutes. Check the update log.');
            // Force a fresh fetch so the failure banner appears if the marker
            // has been written by now.
            try {
              const r = await fetch("/api/app-version-status", { credentials: "include" });
              if (r.ok) setInfo(await r.json());
            } catch {}
            return;
          }
          setTimeout(poll, 4000);
        };
        setTimeout(poll, 8000); // give it 8s before first check
      } else {
        setStatus("error");
        toast.error(d.error || d.reason || "Update failed.");
      }
    } catch {
      setStatus("error");
      toast.error("Update request failed.");
    }
  };

  // Format milliseconds since startedAt as "2m 18s". Reads `tick` only to
  // ensure React re-runs this on every interval fire.
  const formatElapsed = (startedAt) => {
    void tick;
    if (!startedAt) return null;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const phaseLabel = (phase) => {
    switch (phase) {
      case 'downloading': return 'Downloading installer';
      case 'verifying':   return 'Verifying SHA-256';
      case 'installing':  return 'Installing';
      case 'restarting':  return 'Restarting service';
      default:            return 'Updating';
    }
  };

  const elapsedSec = progress?.startedAt
    ? Math.floor((Date.now() - progress.startedAt) / 1000)
    : 0;
  const isStuck = elapsedSec > 8 * 60; // 8 min — sanity threshold

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold mb-1">Application Version</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Current: <span className="font-mono font-medium">{info?.currentVersion ?? "—"}</span>
          {info?.latestVersion && info.latestVersion !== info.currentVersion && (
            <span className="ml-3 text-amber-500 font-medium">Latest: {info.latestVersion}</span>
          )}
        </p>

        {/* Sticky failure banner. Surfaces partial-update failures that the
            in-app updater previously swallowed — e.g. file lock during the
            file swap that triggered a rollback, leaving the service running
            on the OLD version while the UI showed "Update successful". */}
        {info?.lastUpdateFailed && (
          <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 space-y-2">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <div className="font-medium">
                  Last update did not land
                  {info.lastUpdateExpectedVersion && (
                    <span className="font-mono text-xs ml-1.5 opacity-80">
                      (tried {info.lastUpdateExpectedVersion}, still on {info.currentVersion})
                    </span>
                  )}
                </div>
                <div className="text-xs opacity-90">
                  State: <span className="font-mono">{info.lastUpdateState || 'unknown'}</span>
                  {info.lastUpdateError && (
                    <span className="block mt-1 break-words">{info.lastUpdateError}</span>
                  )}
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={fetchUpdateLog} disabled={logLoading}>
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", logLoading && "animate-spin")} />
              {logLoading ? 'Loading log…' : 'View update log'}
            </Button>
          </div>
        )}

        {/* Inline log viewer — shown after clicking "View update log" from
            either the failure banner above or the standalone button below. */}
        {logLines && (
          <div className="mb-4 rounded-md border border-border bg-muted/30 max-h-64 overflow-auto p-2">
            <pre className="text-[10px] font-mono leading-relaxed whitespace-pre-wrap">
              {logLines.length === 0 ? '(empty)' : logLines.join('\n')}
            </pre>
          </div>
        )}

        {status === null && (
          <Button variant="outline" size="sm" onClick={handleCheck}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Check for updates
          </Button>
        )}
        {status === "checking" && (
          <Button variant="outline" size="sm" disabled>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking...
          </Button>
        )}
        {status === "up-to-date" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> You are on the latest version.
            </div>
            <Button variant="outline" size="sm" onClick={handleCheck}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Check again
            </Button>
          </div>
        )}
        {status === "update-available" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-amber-600">
              <Download className="h-4 w-4" /> Version {info?.latestVersion} is available.
            </div>
            <Button size="sm" onClick={handleUpdate}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Install update
            </Button>
          </div>
        )}
        {status === "updating" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-accent">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>
                {phaseLabel(progress?.phase)}
                {progress?.startedAt && (
                  <span className="text-muted-foreground ml-1.5">
                    ({formatElapsed(progress.startedAt)})
                  </span>
                )}
                {!progress && <span className="text-muted-foreground ml-1.5">(starting…)</span>}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              The page will reload automatically once the new service comes back up.
            </p>
            {isStuck && (
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 mt-2 p-2 rounded border border-amber-500/30 bg-amber-500/5">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  This is taking longer than expected ({formatElapsed(progress?.startedAt)}). Typical updates finish in 2–4 minutes. Check the server log on the host (<code className="text-[11px] bg-muted px-1 py-0.5 rounded">C:\Cardoso Customer App\logs\service*.log</code>) for installer errors. If the service is genuinely wedged, restart it manually.
                </span>
              </div>
            )}
          </div>
        )}
        {status === "error" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> Something went wrong. Check server logs.
            </div>
            <Button variant="outline" size="sm" onClick={() => { setStatus(null); }}>
              Try again
            </Button>
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
      toast.error(`Failed: ${err.message}`);
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
    isAdmin && { id: "systemlog", label: "System Log" },
    isAdmin && { id: "tls", label: "TLS" },
    !hubMode && isAdmin && { id: "maintenance", label: "Maintenance" },
    isAdmin && { id: "update", label: "Updates" },
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
                {t.id === "systemlog" && <SystemLogTab />}
                {t.id === "tls"      && <TlsTab />}
                {t.id === "synclog"       && <SyncLogTab />}
                {t.id === "connections"  && <ConnectionsTab currentUser={currentUser} />}
                {t.id === "maintenance"  && <MaintenanceTab />}
                {t.id === "update"       && <UpdateTab />}
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
