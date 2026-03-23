import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Database, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import ConnectionCard from "../components/dashboard/ConnectionCard";
import ConnectionModal from "../components/connections/ConnectionModal";
import ConnectionStatus from "../components/connections/ConnectionStatus";
import { hasPermission } from "@/lib/permissions";

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

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
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
      toast.error(`Failed to create connection: ${error.message || "Unknown error"}`);
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
    onError: (error) => {
      console.error("Update connection error:", error);
      toast.error(`Failed to update connection: ${error.message || "Unknown error"}`);
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
      toast.error(`Failed to delete connection: ${error.message || "Unknown error"}`);
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

      toast.success(`Sync complete. ${totalImported} records imported.`);
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["reports-records"] });
    } catch (error) {
      console.error("Sync all error:", error);
      toast.error(`Sync failed: ${error.message || "Unknown error"}`);
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleSync = async (connection) => {
    setSyncingId(connection.id);

    try {
      const result = await runLocalImport(connection.id);
      toast.success(
        result.message || `Synced data from ${connection.name} (${result.imported || 0} records)`
      );
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["reports-records"] });
    } catch (error) {
      console.error("Sync connection error:", error);
      toast.error(`Failed to sync: ${error.message || "Unknown error"}`);
    } finally {
      setSyncingId(null);
    }
  };

  const handleEdit = (connection) => {
    setEditingConnection(connection);
    setModalOpen(true);
  };

  const handleDelete = (connection) => {
    if (confirm("Are you sure you want to delete this connection?")) {
      deleteMutation.mutate(connection.id);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
              Database Connections
            </h1>
            <p className="text-[var(--text-secondary)] mt-1">
              Manage your SQL database connections
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={handleSyncAll}
              disabled={isSyncingAll}
              variant="outline"
              className="border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
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
                className="bg-white hover:bg-gray-100 text-gray-900 shadow-lg shadow-white/10"
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

        {loadingConnections ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-64 bg-[var(--bg-secondary)] rounded-2xl animate-pulse"
              />
            ))}
          </div>
        ) : connections.length === 0 ? (
          <div className="text-center py-16 bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-color)]">
            <Database className="w-12 h-12 text-[var(--text-tertiary)] mx-auto mb-4" />
            <h3 className="text-lg font-medium text-[var(--text-primary)]">
              No connections yet
            </h3>
            <p className="text-[var(--text-secondary)] mt-1 mb-6">
              {isAdmin
                ? "Add your first SQL database connection to start syncing data"
                : "No database connections have been configured yet. Contact an admin."}
            </p>
            {isAdmin && (
              <Button
                onClick={() => setModalOpen(true)}
                className="bg-white hover:bg-gray-100 text-gray-900"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Connection
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {selectedConnectionId && connections.find((c) => c.id === selectedConnectionId) && (
              <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
                <CardContent className="p-6">
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