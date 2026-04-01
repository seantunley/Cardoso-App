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
  const handleDelete = (conn) => { if (confirm("Delete this connection?")) deleteMutation.mutate(conn.id); };

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
            className="bg-white hover:bg-gray-100 text-gray-900">
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
            <Button onClick={() => setModalOpen(true)} size="sm" className="mt-4 bg-white hover:bg-gray-100 text-gray-900">
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

const BUILT_IN_FIELDS = [
  { key: "customer_number", label: "Customer Number", type: "text" },
  { key: "customer_name",   label: "Customer Name",   type: "text" },
  { key: "age_analysis",    label: "Age Analysis",     type: "text" },
  { key: "source_id",       label: "Source ID",        type: "text" },
  { key: "source_table",    label: "Source Table",     type: "text" },
  { key: "data",            label: "Data",             type: "object" },
  { key: "flag_color",      label: "Flag Color",       type: "text" },
];

function FieldsTab() {
  const queryClient = useQueryClient();
  const [editingField, setEditingField] = useState(null);
  const [editValues, setEditValues] = useState({});
  const [addingField, setAddingField] = useState(false);
  const [newField, setNewField] = useState({ key: "", label: "", field_type: "text" });

  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const canManage = hasPermission(currentUser, "can_access_settings") || currentUser?.role === "admin";

  const { data: customFields = [], isLoading } = useQuery({
    queryKey: ["customFields"],
    queryFn: () => api.entities.CustomField.list(),
  });

  const createMutation = useMutation({
    mutationFn: (data) => api.entities.CustomField.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["customFields"] }); toast.success("Field added"); setAddingField(false); setNewField({ key: "", label: "", field_type: "text" }); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.entities.CustomField.update(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["customFields"] }); toast.success("Field updated"); setEditingField(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.entities.CustomField.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["customFields"] }); toast.success("Field deleted"); },
  });

  const startEdit = (field) => {
    setEditingField(field.id);
    setEditValues({ label: field.label, field_type: field.field_type });
  };

  return (
    <div className="space-y-6">
      {/* Built-in */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Built-in Fields</h3>
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/40">
              {["Field Key","Label","Type",""].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">{h}</th>)}
            </tr></thead>
            <tbody>
              {BUILT_IN_FIELDS.map(f => (
                <tr key={f.key} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{f.key}</td>
                  <td className="px-4 py-2.5 text-foreground">{f.label}</td>
                  <td className="px-4 py-2.5"><Badge variant="secondary">{f.type}</Badge></td>
                  <td className="px-4 py-2.5"><Lock className="h-3.5 w-3.5 text-muted-foreground/50" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Custom */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Custom Fields</h3>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setAddingField(true)} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Field
            </Button>
          )}
        </div>

        {addingField && (
          <div className="mb-3 rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Key (snake_case)</label>
                <Input value={newField.key} onChange={e => setNewField(v => ({ ...v, key: e.target.value }))} placeholder="e.g. credit_limit" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Label</label>
                <Input value={newField.label} onChange={e => setNewField(v => ({ ...v, label: e.target.value }))} placeholder="e.g. Credit Limit" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Type</label>
                <Select value={newField.field_type} onValueChange={v => setNewField(f => ({ ...f, field_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["text","number","date","boolean","select"].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => createMutation.mutate(newField)} disabled={!newField.key || !newField.label || createMutation.isPending}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setAddingField(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="h-20 animate-pulse bg-muted rounded-xl" />
        ) : customFields.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm border border-dashed border-border rounded-xl">No custom fields yet</div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border bg-muted/40">
                {["Key","Label","Type",""].map(h => <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">{h}</th>)}
              </tr></thead>
              <tbody>
                {customFields.map(f => (
                  <tr key={f.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{f.key || f.field_key}</td>
                    <td className="px-4 py-2.5">
                      {editingField === f.id
                        ? <Input className="h-7 text-sm" value={editValues.label} onChange={e => setEditValues(v => ({ ...v, label: e.target.value }))} />
                        : <span className="text-foreground">{f.label}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {editingField === f.id
                        ? <Select value={editValues.field_type} onValueChange={v => setEditValues(ev => ({ ...ev, field_type: v }))}><SelectTrigger className="h-7 text-sm"><SelectValue /></SelectTrigger><SelectContent>{["text","number","date","boolean","select"].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select>
                        : <Badge variant="secondary">{f.field_type}</Badge>}
                    </td>
                    <td className="px-4 py-2.5">
                      {canManage && (
                        editingField === f.id ? (
                          <div className="flex gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => updateMutation.mutate({ id: f.id, data: editValues })}><Check className="h-3.5 w-3.5" /></Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingField(null)}><X className="h-3.5 w-3.5" /></Button>
                          </div>
                        ) : (
                          <div className="flex gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(f)}><Edit2 className="h-3.5 w-3.5" /></Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:text-red-500" onClick={() => confirm("Delete this field?") && deleteMutation.mutate(f.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </div>
                        )
                      )}
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

export default function SettingsPanel({ open, onClose, hubMode }) {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;

  // Build tabs based on context
  const tabs = [
    canManageUsers && { id: "users", label: "Users" },
    { id: "theme", label: "Theme" },
    !hubMode && { id: "autoflag", label: "Auto-Flag Rules" },
    !hubMode && { id: "fields", label: "Fields" },
    !hubMode && { id: "connections", label: "Connections" },
    !hubMode && isAdmin && { id: "audit", label: "Audit Log" },
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
