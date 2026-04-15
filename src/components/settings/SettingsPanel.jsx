import { useState, useEffect, useCallback } from "react";
import { applyTheme } from "@/lib/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
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
  Sun, Moon, Zap, Plus,
  RefreshCw, AlertCircle, CheckCircle2, Clock, LogIn, ClipboardList,
  Download, Upload, GitBranch, Send, Info,
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
  "sync":          { label: "Sync",          cls: "bg-blue-900/50 text-blue-300 border-blue-700" },
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

// ─── Theme Tab ───────────────────────────────────────────────────────────────

function ThemeTab() {
  const queryClient = useQueryClient();
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });

  const themeMutation = useMutation({
    mutationFn: (theme) => api.auth.updateMe({ theme_preference: theme }),
    onSuccess: (_, theme) => {
      queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      applyTheme(theme);
      toast.success(`Switched to ${theme} mode`);
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Choose your preferred display theme.</p>
      <div className="flex gap-3">
        <Button onClick={() => themeMutation.mutate("light")} variant={currentUser?.theme_preference==="light"?"default":"outline"} className={currentUser?.theme_preference==="light"?"bg-white text-gray-900 hover:bg-gray-100":"border-border"} disabled={themeMutation.isPending}>
          <Sun className="w-4 h-4 mr-2" />Light Mode
        </Button>
        <Button onClick={() => themeMutation.mutate("dark")} variant={currentUser?.theme_preference==="dark"?"default":"outline"} className={currentUser?.theme_preference==="dark"?"bg-gray-900 text-white hover:bg-gray-800":"border-border"} disabled={themeMutation.isPending}>
          <Moon className="w-4 h-4 mr-2" />Dark Mode
        </Button>
      </div>
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
    queryFn: () => fetch("/api/hub/kpis", { credentials: "include" }).then((response) => response.ok ? response.json() : null).catch(() => null),
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
                          ? "border-indigo-500 bg-indigo-500/15 text-indigo-300"
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
      .then(r => r.json())
      .then(data => setSites(Array.isArray(data) ? data : data.sites || []))
      .catch(() => {});
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

  useEffect(() => {
    fetch("/api/app-version-status", { credentials: "include" })
      .then(r => r.json())
      .then(d => setInfo(d))
      .catch(() => {});
  }, []);

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
      if (d.success || d.message?.toLowerCase().includes("download")) {
        setStatus("updating");
        toast.success("Update downloading — the page will reload automatically once ready.");
        // Poll until the version changes, then reload
        const targetVersion = info?.latestVersion;
        const poll = async () => {
          try {
            const pr = await fetch("/api/app-version-status", { credentials: "include" });
            if (!pr.ok) throw new Error("not ready");
            const pd = await pr.json();
            if (pd.currentVersion && pd.currentVersion === targetVersion) {
              window.location.reload();
              return;
            }
          } catch { /* service still restarting */ }
          setTimeout(poll, 4000);
        };
        setTimeout(poll, 8000); // give it 8s before first check
      } else {
        setStatus("error");
        toast.error(d.error || "Update failed.");
      }
    } catch {
      setStatus("error");
      toast.error("Update request failed.");
    }
  };

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
          <div className="flex items-center gap-2 text-sm text-blue-600">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Downloading update — service will restart shortly...
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

export default function SettingsPanel({ open, onClose, hubMode }) {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || isAdmin;

  // Build tabs based on context
  const tabs = [
    canManageUsers && { id: "users", label: "Users" },
    { id: "theme", label: "Theme" },
    canManageRules && { id: "creditlogic", label: "Credit Logic" },
    { id: "autoflag", label: "Auto-Flag Rules" },
    { id: "fields", label: "Fields" },
    !hubMode && { id: "connections", label: "Connections" },
    !hubMode && isAdmin && { id: "audit", label: "Audit Log" },
    !hubMode && isAdmin && { id: "maintenance", label: "Maintenance" },
    isAdmin && { id: "update", label: "Updates" },
    hubMode && { id: "synclog", label: "Sync Log" },
    hubMode && isAdmin && { id: "hubmaintenance", label: "Maintenance" },
    hubMode && isAdmin && { id: "network", label: "Network" },
  ].filter(Boolean);

  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? "theme");

  // Reset to first tab when opened
  useEffect(() => { if (open) setActiveTab(tabs[0]?.id ?? "theme"); }, [open]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-6xl w-full h-[100dvh] sm:h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle className="text-lg">Settings</DialogTitle>
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
                {t.id === "theme"    && <ThemeTab />}
                {t.id === "creditlogic" && <CreditLogicTab hubMode={hubMode} currentUser={currentUser} />}
                {t.id === "autoflag" && <AutoFlagTab hubMode={hubMode} />}
                {t.id === "fields"   && <FieldsTab />}
                {t.id === "audit"    && <AuditTab />}
                {t.id === "synclog"       && <SyncLogTab />}
                {t.id === "connections"  && <ConnectionsTab currentUser={currentUser} />}
                {t.id === "maintenance"  && <MaintenanceTab />}
                {t.id === "update"       && <UpdateTab />}
                {t.id === "hubmaintenance" && <HubMaintenanceTab />}
                {t.id === "network"      && <NtopngTab />}
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
