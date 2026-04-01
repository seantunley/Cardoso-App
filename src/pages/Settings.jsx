import { useState } from "react";
import { checkAutoFlagRules } from "@/lib/evalFlagRules";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
import AutoFlagRuleForm from "../components/settings/AutoFlagRuleForm";
import { Plus, Zap, Moon, Sun, Database, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { hasPermission } from "@/lib/permissions";
import ConnectionCard from "../components/dashboard/ConnectionCard";
import ConnectionModal from "../components/connections/ConnectionModal";
import ConnectionStatus from "../components/connections/ConnectionStatus";

// ─── Connection helpers (moved from Connections page) ────────────────────────

async function fetchLocalConnections() {
  const response = await fetch("/api/databaseconnection", { method: "GET", credentials: "include" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to fetch connections");
  return Array.isArray(result) ? result : [];
}

async function createLocalConnection(data) {
  const response = await fetch("/api/databaseconnection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to create connection");
  return result;
}

async function updateLocalConnection(id, data) {
  const response = await fetch(`/api/databaseconnection/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to update connection");
  return result;
}

async function deleteLocalConnection(id) {
  const response = await fetch(`/api/databaseconnection/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to delete connection");
  return result;
}

async function runLocalImport(connectionId) {
  const response = await fetch(`/api/import/${connectionId}`, {
    method: "POST",
    credentials: "include",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Import failed");
  return result;
}

// ─── Connections tab ──────────────────────────────────────────────────────────

function ConnectionsTab({ currentUser }) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  const [isSyncingAll, setIsSyncingAll] = useState(false);

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
    onError: (error) => toast.error(`Failed to create connection: ${error.message || "Unknown error"}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateLocalConnection(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      setModalOpen(false);
      setEditingConnection(null);
      toast.success("Connection updated successfully");
    },
    onError: (error) => toast.error(`Failed to update connection: ${error.message || "Unknown error"}`),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteLocalConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast.success("Connection deleted");
    },
    onError: (error) => toast.error(`Failed to delete connection: ${error.message || "Unknown error"}`),
  });

  const handleSave = (data, id) => {
    const payload = { ...data, created_by: currentUser?.email };
    if (id) {
      updateMutation.mutate({ id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleSyncAll = async () => {
    if (!connections.length) { toast.error("No connections available to sync"); return; }
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
      toast.error(`Sync failed: ${error.message || "Unknown error"}`);
    } finally {
      setIsSyncingAll(false);
    }
  };

  const handleSync = async (connection) => {
    setSyncingId(connection.id);
    try {
      const result = await runLocalImport(connection.id);
      toast.success(result.message || `Synced data from ${connection.name} (${result.imported || 0} records)`);
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["records"] });
      queryClient.invalidateQueries({ queryKey: ["reports-records"] });
    } catch (error) {
      toast.error(`Failed to sync: ${error.message || "Unknown error"}`);
    } finally {
      setSyncingId(null);
    }
  };

  const handleEdit = (connection) => { setEditingConnection(connection); setModalOpen(true); };
  const handleDelete = (connection) => {
    if (confirm("Are you sure you want to delete this connection?")) {
      deleteMutation.mutate(connection.id);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-[var(--text-secondary)]">Manage your SQL database connections</p>
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
              onClick={() => { setEditingConnection(null); setModalOpen(true); }}
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
            <p className="text-sm text-rose-300">{connectionsError.message || "Failed to load connections"}</p>
          </CardContent>
        </Card>
      )}

      {loadingConnections ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-64 bg-[var(--bg-secondary)] rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : connections.length === 0 ? (
        <div className="text-center py-16 bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-color)]">
          <Database className="w-12 h-12 text-[var(--text-tertiary)] mx-auto mb-4" />
          <h3 className="text-lg font-medium text-[var(--text-primary)]">No connections yet</h3>
          <p className="text-[var(--text-secondary)] mt-1 mb-6">
            {isAdmin
              ? "Add your first SQL database connection to start syncing data"
              : "No database connections have been configured yet. Contact an admin."}
          </p>
          {isAdmin && (
            <Button onClick={() => setModalOpen(true)} className="bg-white hover:bg-gray-100 text-gray-900">
              <Plus className="w-4 h-4 mr-2" />
              Add Connection
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {selectedConnectionId && connections.find((c) => c.id === selectedConnectionId) && (
            <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <CardContent className="p-4">
                <ConnectionStatus connection={connections.find((c) => c.id === selectedConnectionId)} />
              </CardContent>
            </Card>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {connections.map((conn) => (
              <div
                key={conn.id}
                onClick={() => setSelectedConnectionId(conn.id)}
                className={`cursor-pointer transition-opacity ${
                  selectedConnectionId === conn.id ? "opacity-100" : "opacity-75 hover:opacity-100"
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
        onClose={() => { setModalOpen(false); setEditingConnection(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
}

// ─── Main Settings page ───────────────────────────────────────────────────────

const TABS = [
  { id: "general", label: "General" },
  { id: "connections", label: "Connections", siteOnly: true },
];

export default function Settings() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("general");
  const [showNewRule, setShowNewRule] = useState(false);

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
  });

  const { data: appInfo } = useQuery({
    queryKey: ["app-info"],
    queryFn: () => fetch("/api/app-info", { credentials: "include" }).then((r) => r.json()),
  });

  const isHub = appInfo?.hub_mode === true;

  const { data: autoFlagRules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ["autoFlagRules"],
    queryFn: () => api.entities.AutoFlagRule.list("-priority"),
  });

  const isAdmin = currentUser?.role === "admin";
  const canManageRules = hasPermission(currentUser, "can_manage_rules");

  const createRuleMutation = useMutation({
    mutationFn: (data) => api.entities.AutoFlagRule.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] });
      toast.success("Auto-flag rule created");
      setShowNewRule(false);
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: ({ id, data }) => api.entities.AutoFlagRule.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] });
      toast.success("Auto-flag rule updated");
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: (id) => api.entities.AutoFlagRule.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["autoFlagRules"] });
      toast.success("Auto-flag rule deleted");
    },
  });

  const applyRulesMutation = useMutation({
    mutationFn: async (recordIds = null) => {
      const rules = await api.entities.AutoFlagRule.list("-priority");
      const activeRules = rules.filter((r) => r.is_active);
      const allRecords = await api.entities.DataRecord.list();
      const records = recordIds ? allRecords.filter((r) => recordIds.includes(r.id)) : allRecords;
      let flaggedCount = 0;
      const now = new Date().toISOString();
      for (const record of records) {
        if (record.flag_color && record.flag_color !== "none" && record.flag_created_by && !record.auto_flagged) continue;
        const autoFlag = checkAutoFlagRules(record, activeRules);
        if (autoFlag && autoFlag.flag_color !== record.flag_color) {
          await api.entities.DataRecord.update(record.id, { ...autoFlag, last_checked: now });
          flaggedCount++;
        } else {
          await api.entities.DataRecord.update(record.id, { last_checked: now });
        }
      }
      return flaggedCount;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      toast.success(`Applied rules to ${count} record(s)`);
    },
  });

  const themeUpdateMutation = useMutation({
    mutationFn: (theme) => api.auth.updateMe({ theme_preference: theme }),
    onSuccess: (_, theme) => {
      queryClient.invalidateQueries({ queryKey: ["currentUser"] });
      document.documentElement.setAttribute("data-theme", theme);
      toast.success(`Switched to ${theme} mode`);
    },
  });

  const handleRuleSave = (data, existingId) => {
    if (!canManageRules) { toast.error("You do not have permission to modify rules"); return; }
    if (existingId) {
      updateRuleMutation.mutate({ id: existingId, data });
    } else {
      createRuleMutation.mutate(data);
    }
  };

  const handleRuleDelete = (id) => {
    if (!canManageRules) { toast.error("You do not have permission to delete rules"); return; }
    if (confirm("Delete this auto-flag rule?")) deleteRuleMutation.mutate(id);
  };


  // Visible tabs: hide Connections on hub mode
  const visibleTabs = TABS.filter((t) => !(t.siteOnly && isHub));

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <div className="max-w-4xl mx-auto p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">Settings</h1>
          <p className="text-[var(--text-secondary)] mt-1">Manage app preferences and connections</p>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-[var(--border-color)] gap-1">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.id
                  ? "border-white text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── General tab ── */}
        {activeTab === "general" && (
          <div className="space-y-8">
            {/* Theme */}
            <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-[var(--text-primary)]">
                  <Sun className="w-5 h-5" />
                  Theme
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-3">
                  <Button
                    onClick={() => themeUpdateMutation.mutate("light")}
                    variant={currentUser?.theme_preference === "light" ? "default" : "outline"}
                    className={currentUser?.theme_preference === "light" ? "bg-white text-gray-900 hover:bg-gray-100" : "border-[var(--border-color)] text-gray-900"}
                    disabled={themeUpdateMutation.isPending}
                  >
                    <Sun className="w-4 h-4 mr-2" />
                    Light Mode
                  </Button>
                  <Button
                    onClick={() => themeUpdateMutation.mutate("dark")}
                    variant={currentUser?.theme_preference === "dark" ? "default" : "outline"}
                    className={currentUser?.theme_preference === "dark" ? "bg-gray-900 text-white hover:bg-gray-800" : "border-[var(--border-color)] text-[var(--text-primary)]"}
                    disabled={themeUpdateMutation.isPending}
                  >
                    <Moon className="w-4 h-4 mr-2" />
                    Dark Mode
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Auto-Flag Rules */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gradient-to-br from-amber-900/30 to-orange-900/30 rounded-lg">
                    <Zap className="w-5 h-5 text-amber-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-[var(--text-primary)]">Auto-Flag Rules</h2>
                    <p className="text-sm text-[var(--text-secondary)]">
                      Automatically flag customers based on age analysis values
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {canManageRules && (
                    <Button
                      onClick={() => applyRulesMutation.mutate()}
                      disabled={applyRulesMutation.isPending || autoFlagRules.length === 0}
                      variant="outline"
                      className="border-white text-gray-900 bg-white hover:bg-gray-100"
                    >
                      {applyRulesMutation.isPending ? (
                        <><span className="animate-spin mr-2">⏳</span>Applying...</>
                      ) : (
                        <><Zap className="w-4 h-4 mr-2" />Apply Now</>
                      )}
                    </Button>
                  )}
                  {canManageRules && (
                    <Button onClick={() => setShowNewRule(true)} className="bg-white hover:bg-gray-100 text-gray-900">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Rule
                    </Button>
                  )}
                </div>
              </div>

              {showNewRule && canManageRules && (
                <AutoFlagRuleForm
                  onSave={handleRuleSave}
                  onDelete={() => setShowNewRule(false)}
                  isSaving={createRuleMutation.isPending}
                  isAdmin={canManageRules}
                />
              )}

              {rulesLoading ? (
                <div className="space-y-3">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-48 bg-[var(--bg-secondary)] rounded-2xl animate-pulse" />
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {autoFlagRules.map((rule) => (
                    <AutoFlagRuleForm
                      key={rule.id}
                      rule={rule}
                      onSave={handleRuleSave}
                      onDelete={handleRuleDelete}
                      isSaving={updateRuleMutation.isPending || deleteRuleMutation.isPending}
                      isAdmin={canManageRules}
                    />
                  ))}
                  {autoFlagRules.length === 0 && !showNewRule && (
                    <div className="text-center py-12 bg-[var(--bg-secondary)] rounded-xl border border-[var(--border-color)] border-dashed">
                      <Zap className="w-12 h-12 text-[var(--text-tertiary)] mx-auto mb-3" />
                      <p className="text-[var(--text-secondary)]">No auto-flag rules yet</p>
                      <p className="text-sm text-[var(--text-tertiary)] mt-1">
                        Create rules to automatically flag customers based on their age analysis
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Connections tab ── */}
        {activeTab === "connections" && !isHub && (
          <ConnectionsTab currentUser={currentUser} />
        )}
      </div>
    </div>
  );
}
