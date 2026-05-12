import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { Database, Plus, RefreshCw, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { cleanImportToastMessage, getLedgerFortune, resetCleanSyncStreak } from "@/lib/fun";
import { humanizeApiError } from "@/lib/humanizeApiError";
import ConnectionCard from "../components/dashboard/ConnectionCard";
import ConnectionModal from "../components/connections/ConnectionModal";
import ConnectionStatus from "../components/connections/ConnectionStatus";

async function fetchLocalConnections() {
  const response = await fetch("/api/databaseconnection", {
    method: "GET",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to fetch connections");
  }

  return Array.isArray(result) ? result : [];
}

async function createLocalConnection(data) {
  const response = await fetch("/api/databaseconnection", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(data),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to create connection");
  }

  return result;
}

async function updateLocalConnection(id, data) {
  const response = await fetch(`/api/databaseconnection/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(data),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to update connection");
  }

  return result;
}

async function deleteLocalConnection(id) {
  const response = await fetch(`/api/databaseconnection/${id}`, {
    method: "DELETE",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to delete connection");
  }

  return result;
}

async function fetchConnectionRoles() {
  const response = await fetch("/api/connection-roles", { credentials: "include" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to load module routing");
  return result; // { roles: [{id,label}], assigned: { roleId: connId } }
}

async function setConnectionRole(role, connectionId) {
  const response = await fetch(`/api/connection-roles/${role}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ connection_id: connectionId }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to update module routing");
  return result;
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
    onError: (err) => toast.error(humanizeApiError(err, "update module routing")),
  });

  if (error) {
    return (
      <Card className="border-rose-700 bg-rose-900/20">
        <CardContent className="p-4">
          <p className="text-sm text-rose-300">
            Module routing unavailable: {error.message || "unknown error"}
          </p>
        </CardContent>
      </Card>
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

async function runLocalImport(connectionId) {
  const response = await fetch(`/api/import/${connectionId}`, {
    method: "POST",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Import failed");
  }

  return result;
}

export default function Connections() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
    staleTime: Infinity,
  });

  // Only admins can create/edit/delete connections; all connections-users can sync and view
  const isAdmin = currentUser?.role === "admin";

  const {
    data: connections = [],
    isLoading: loadingConnections,
    error: connectionsError,
  } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchLocalConnections,
    enabled: !!currentUser,
    refetchInterval: 30000,
    staleTime: 60_000,
  });

  const createMutation = useMutation({
    mutationFn: createLocalConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      setModalOpen(false);
      toast.success("Connection created successfully");
    },
    onError: (error) => {
      console.error("Create connection error:", error);
      toast.error(humanizeApiError(error, "create connection"));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateLocalConnection(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      setModalOpen(false);
      setEditingConnection(null);
      toast.success("Connection updated successfully");
    },
    onError: (error, vars) => {
      // `vars` carries the {id, data} we mutated against, so we can name
      // the connection in the toast even when only the ID is to hand.
      console.error("Update connection error:", error);
      const name = vars?.data?.name;
      toast.error(humanizeApiError(error, name ? `update connection "${name}"` : "update connection"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteLocalConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.success("Connection deleted");
    },
    onError: (error) => {
      console.error("Delete connection error:", error);
      toast.error(humanizeApiError(error, "delete connection"));
    },
  });

  const handleSave = (data, id) => {
    const payload = {
      ...data,
      created_by: currentUser?.email,
    };

    if (id) {
      updateMutation.mutate({ id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleSyncAll = async () => {
    if (!connections.length) {
      toast.error("No connections available to sync");
      return;
    }

    setIsSyncingAll(true);

    try {
      let totalImported = 0;

      for (const connection of connections) {
        const result = await runLocalImport(connection.id);
        totalImported += result.imported || 0;
      }

      toast.success(cleanImportToastMessage({ imported: totalImported }));
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["reports-records"] });
    } catch (error) {
      console.error("Sync all error:", error);
      resetCleanSyncStreak();
      toast.error(humanizeApiError(error, "sync all connections"));
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleSync = async (connection) => {
    setSyncingId(connection.id);

    try {
      const result = await runLocalImport(connection.id);
      // Always run cleanImportToastMessage (so the streak ticks).
      // Falling back via `result.message ||` would short-circuit on
      // every successful sync since runConnectionImport always returns
      // a non-empty success message. See ConnectionModal.handleImport.
      toast.success(cleanImportToastMessage({ imported: result.imported || 0, target: connection.name }));
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["reports-records"] });
    } catch (error) {
      console.error("Sync connection error:", error);
      resetCleanSyncStreak();
      toast.error(humanizeApiError(error, `sync "${connection.name}"`));
    } finally {
      setSyncingId(null);
    }
  };

  const handleEdit = (connection) => {
    setEditingConnection(connection);
    setModalOpen(true);
  };

  const handleDelete = (connection) => {
    setDeleteConfirmId(connection.id);
  };

  const confirmDelete = (id) => {
    deleteMutation.mutate(id);
    setDeleteConfirmId(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-border pb-5">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Connections</div>
            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Sources of <em className="text-phosphor">truth</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">
              Manage your SQL database connections
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={handleSyncAll}
              disabled={isSyncingAll}
              variant="outline"
              className="border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground h-10"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isSyncingAll ? "animate-spin" : ""}`} />
              {isSyncingAll ? "Syncing..." : "Sync Now"}
            </Button>

            {isAdmin && (
              <Button
                onClick={() => {
                  setEditingConnection(null);
                  setModalOpen(true);
                }}
                variant="default"
                className="h-10"
              >
                <Plus className="w-4 h-4 mr-2" />
                New Connection
              </Button>
            )}
          </div>
        </div>

        {connectionsError && (
          <Card className="border-rose-700 bg-rose-900/20">
            <CardContent className="p-4">
              <p className="text-sm text-rose-300">
                {connectionsError.message || "Failed to load connections"}
              </p>
            </CardContent>
          </Card>
        )}

        <ModuleRoutingCard connections={connections} isAdmin={isAdmin} />

        {loadingConnections ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-64 bg-card rounded-2xl animate-pulse"
              />
            ))}
          </div>
        ) : connections.length === 0 ? (
          <div className="text-center py-16 bg-card rounded-2xl border border-border">
            <Database className="w-12 h-12 text-muted-foreground/60 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-foreground">
              No connections yet
            </h3>
            <p className="text-muted-foreground mt-1 mb-6">
              {isAdmin
                ? getLedgerFortune()
                : "No database connections have been configured yet. Contact an admin."}
            </p>
            {isAdmin && (
              <Button
                onClick={() => setModalOpen(true)}
                variant="default"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Connection
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {selectedConnectionId && connections.find((c) => c.id === selectedConnectionId) && (
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <ConnectionStatus
                    connection={connections.find((c) => c.id === selectedConnectionId)}
                  />
                </CardContent>
              </Card>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className="relative"
                >
                  <div
                    onClick={() => setSelectedConnectionId(conn.id)}
                    className={`cursor-pointer transition-opacity ${
                      selectedConnectionId === conn.id
                        ? "opacity-100"
                        : "opacity-75 hover:opacity-100"
                    }`}
                  >
                    <ConnectionCard
                      connection={conn}
                      onSync={handleSync}
                      onEdit={isAdmin ? handleEdit : null}
                      onDelete={isAdmin ? handleDelete : null}
                      isSyncing={syncingId === conn.id}
                    />
                  </div>
                  {deleteConfirmId === conn.id && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-2xl border border-red-500/40 bg-card/95 backdrop-blur-sm p-4">
                      <p className="text-sm font-medium text-foreground text-center">Delete this connection?</p>
                      <p className="text-xs text-muted-foreground text-center">This action cannot be undone.</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Button variant="destructive" size="sm" onClick={() => confirmDelete(conn.id)} disabled={deleteMutation.isPending}>
                          Confirm Delete
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <ConnectionModal
          connection={editingConnection}
          open={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingConnection(null);
          }}
          onSave={handleSave}
          isSaving={createMutation.isPending || updateMutation.isPending}
        />
      </div>
    </div>
  );
}
