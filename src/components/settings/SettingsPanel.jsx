import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/lib/permissions";
import { checkAutoFlagRules } from "@/lib/evalFlagRules";

// UI
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Icons
import {
  Sun, Moon, Zap, Plus, Edit2, Check, X, Trash2, Lock,
  RefreshCw, AlertCircle, CheckCircle2, Clock, Shield, LogIn, ClipboardList,
  Download, Upload,
} from "lucide-react";

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
    <div className="rounded-xl border border-border bg-card overflow-hidden">
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
        <div className="rounded-xl border border-border bg-card overflow-hidden">
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
                  <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap text-xs">{row.started_at ? new Date(row.started_at).toLocaleString() : "—"}</td>
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

  const fmt = (dt) => dt ? new Date(dt).toLocaleString() : "—";

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
          <div className="rounded-xl border border-border bg-card overflow-hidden">
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
      document.documentElement.setAttribute("data-theme", theme);
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

function AutoFlagTab() {
  const queryClient = useQueryClient();
  const [showNewRule, setShowNewRule] = useState(false);
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const canManageRules = hasPermission(currentUser, "can_manage_rules");

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
      const res = await fetch('/api/clear-auto-flags', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: ({ cleared }) => { queryClient.invalidateQueries({ queryKey: ["records"] }); toast.success(`Cleared ${cleared} auto-flagged record(s)`); },
    onError: (e) => toast.error(`Failed to clear: ${e.message}`),
  });

  const handleSave = (data, id) => {
    if (!canManageRules) { toast.error("No permission"); return; }
    id ? updateMutation.mutate({ id, data }) : createMutation.mutate(data);
  };
  const handleDelete = (id) => {
    if (!canManageRules) { toast.error("No permission"); return; }
    if (confirm("Delete this rule?")) deleteMutation.mutate(id);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        {canManageRules && (
          <Button size="sm" variant="outline" onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending} className="gap-1.5">
            <Zap className="h-3.5 w-3.5" />{applyMutation.isPending ? "Applying…" : "Apply Now"}
          </Button>
        )}
        {canManageRules && (
          <Button size="sm" variant="outline" onClick={() => { if (confirm("Clear all auto-flagged records?")) clearMutation.mutate(); }} disabled={clearMutation.isPending} className="gap-1.5 border-rose-700 text-rose-400 hover:bg-rose-900/20">
            {clearMutation.isPending ? "Clearing…" : "Clear Auto Flags"}
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
    </div>
  );
}

// ─── Main SettingsPanel ──────────────────────────────────────────────────────


// ─── Update Tab ─────────────────────────────────────────────────────────────
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
        toast.success("Update downloading — service will restart automatically.");
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

export default function SettingsPanel({ open, onClose, hubMode }) {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;

  // Build tabs based on context
  const tabs = [
    canManageUsers && { id: "users", label: "Users" },
    { id: "theme", label: "Theme" },
    !hubMode && { id: "autoflag", label: "Auto-Flag Rules" },
    { id: "fields", label: "Fields" },
    !hubMode && { id: "connections", label: "Connections" },
    !hubMode && isAdmin && { id: "audit", label: "Audit Log" },
    isAdmin && { id: "update", label: "Updates" },
    hubMode && { id: "synclog", label: "Sync Log" },
  ].filter(Boolean);

  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? "theme");

  // Reset to first tab when opened
  useEffect(() => { if (open) setActiveTab(tabs[0]?.id ?? "theme"); }, [open]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-6xl w-full h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle className="text-lg">Settings</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 overflow-hidden">
          <TabsList className="mx-6 mt-4 shrink-0 justify-start">
            {tabs.map(t => (
              <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {tabs.map(t => (
              <TabsContent key={t.id} value={t.id} className="mt-0">
                {t.id === "users"    && <UsersTabContent />}
                {t.id === "theme"    && <ThemeTab />}
                {t.id === "autoflag" && <AutoFlagTab />}
                {t.id === "fields"   && <FieldsTab />}
                {t.id === "audit"    && <AuditTab />}
                {t.id === "synclog"       && <SyncLogTab />}
                {t.id === "connections"  && <ConnectionsTab currentUser={currentUser} />}
                {t.id === "update"       && <UpdateTab />}
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
