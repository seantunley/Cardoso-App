import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { humanizeApiError } from "@/lib/humanizeApiError";
import { cleanImportToastMessage, resetCleanSyncStreak } from "@/lib/fun";

// UI
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Icons
import { Plus, RefreshCw, Workflow } from "lucide-react";

// Sub-components
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

export default function ConnectionsTab({ currentUser }) {
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
      toast.success(cleanImportToastMessage({ imported: total }));
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
    } catch (e) { resetCleanSyncStreak(); toast.error(humanizeApiError(e, "sync all connections")); }
    finally { setIsSyncingAll(false); }
  };

  const handleSync = async (conn) => {
    setSyncingId(conn.id);
    try {
      const r = await runLocalImport(conn.id);
      // Always run cleanImportToastMessage (so the streak ticks).
      // Falling back via `r.message ||` would short-circuit on every
      // successful sync since runConnectionImport always returns a
      // non-empty success message. See ConnectionModal.handleImport.
      toast.success(cleanImportToastMessage({ imported: r.imported || 0, target: conn.name }));
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
    } catch (e) { resetCleanSyncStreak(); toast.error(humanizeApiError(e, `sync "${conn.name}"`)); }
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
