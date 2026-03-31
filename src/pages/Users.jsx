import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Shield, User as UserIcon, RefreshCw, Trash2, KeyRound, Lock, Pencil } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import CreateLocalUserModal from "../components/users/CreateLocalUserModal";
import UserPermissionsModal from "../components/users/UserPermissionsModal";
import ChangePasswordModal from "../components/users/ChangePasswordModal";
import EditUserModal from "../components/users/EditUserModal";
import HubUserManager from "../components/users/HubUserManager";

export default function Users({ embedded = false }) {
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";

  const { data: hubKpis } = useQuery({
    queryKey: ["hub-kpis"],
    queryFn: () => fetch("/api/hub/kpis", { credentials: "include" }).then(r => r.ok ? r.json() : null).catch(() => null),
    enabled: isAdmin,
    retry: false,
  });
  const hubSites = hubKpis?.sites || [];
  const isHubMode = hubSites.length > 0;

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingPermissionsUser, setEditingPermissionsUser] = useState(null);
  const [passwordUser, setPasswordUser] = useState(null);
  const [editingUser, setEditingUser] = useState(null);

  const { data: users = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.users.list(),
    enabled: !!currentUser,
  });

  const createUserMutation = useMutation({
    mutationFn: (d) => api.users.create({ email: d.email, full_name: d.full_name || "", role: d.role || "user", password: d.password }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["users"] }); setCreateModalOpen(false); toast.success("User created"); },
    onError: (e) => toast.error(e.message || "Failed to create user"),
  });
  const updatePermissionsMutation = useMutation({
    mutationFn: ({ id, permissions }) => api.users.updatePermissions(id, permissions),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["users"] }); setEditingPermissionsUser(null); toast.success("Permissions updated"); },
    onError: (e) => toast.error(e.message || "Failed"),
  });
  const updatePasswordMutation = useMutation({
    mutationFn: ({ id, password }) => api.users.updatePassword(id, password),
    onSuccess: () => { setPasswordUser(null); toast.success("Password updated"); },
    onError: (e) => toast.error(e.message || "Failed"),
  });
  const deleteUserMutation = useMutation({
    mutationFn: (id) => api.users.delete(id),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["users"] }); await refetch(); toast.success("User deleted"); },
    onError: (e) => toast.error(e.message || "Failed"),
  });

  const handleDeleteUser = async (user) => {
    if (!isAdmin) { toast.error("Only admins can delete users"); return; }
    if (currentUser?.id === user.id) { toast.error("Cannot delete your own account"); return; }
    if (!window.confirm(`Delete ${user.full_name || user.email}? This cannot be undone.`)) return;
    await deleteUserMutation.mutateAsync(user.id);
  };

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center space-y-3">
          <Lock className="w-10 h-10 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">Access denied.</p>
        </div>
      </div>
    );
  }

  const activeUsers = users.filter(u => u.is_active !== false);
  const adminCount = users.filter(u => u.role === "admin").length;

  const content = (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{activeUsers.length} active · {adminCount} admin{adminCount !== 1 ? "s" : ""}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => setCreateModalOpen(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add User
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-14 animate-pulse bg-muted rounded-xl" />)}</div>
      ) : users.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 border border-dashed border-border rounded-xl text-muted-foreground gap-3">
          <UserIcon className="h-8 w-8" />
          <p className="text-sm">No users yet</p>
          <Button size="sm" onClick={() => setCreateModalOpen(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />Add User</Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Role</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {user.full_name || "Unnamed"}
                    {currentUser?.id === user.id && <Badge variant="outline" className="ml-2 text-xs border-blue-700 text-blue-400">You</Badge>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={user.role === "admin" ? "border-purple-700 text-purple-400" : "border-border text-muted-foreground"}>
                      {user.role === "admin" ? "Admin" : "User"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={user.is_active ? "border-green-700 text-green-400" : "border-red-700 text-red-400"}>
                      {user.is_active ? "Active" : "Disabled"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Edit" onClick={() => setEditingUser(user)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Permissions" onClick={() => setEditingPermissionsUser(user)}><Shield className="h-3.5 w-3.5" /></Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Set Password" onClick={() => setPasswordUser(user)}><KeyRound className="h-3.5 w-3.5" /></Button>
                      {currentUser?.id !== user.id && (
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-500" title="Delete" onClick={() => handleDeleteUser(user)} disabled={deleteUserMutation.isPending}>
                          {deleteUserMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isHubMode && (
        <div className="pt-4 border-t border-border">
          <HubUserManager sites={hubSites} />
        </div>
      )}

      <CreateLocalUserModal open={createModalOpen} onClose={() => setCreateModalOpen(false)} onCreate={d => createUserMutation.mutateAsync(d)} isCreating={createUserMutation.isPending} />
      <UserPermissionsModal user={editingPermissionsUser} open={!!editingPermissionsUser} onClose={() => setEditingPermissionsUser(null)} onSave={(id, perms) => updatePermissionsMutation.mutateAsync({ id, permissions: perms })} isSaving={updatePermissionsMutation.isPending} />
      <ChangePasswordModal user={passwordUser} open={!!passwordUser} onClose={() => setPasswordUser(null)} onSave={(id, pw) => updatePasswordMutation.mutateAsync({ id, password: pw })} isSaving={updatePasswordMutation.isPending} />
      <EditUserModal user={editingUser} open={!!editingUser} onClose={() => setEditingUser(null)} onSave={updated => { queryClient.setQueryData(["users"], old => old ? old.map(u => u.id === updated.id ? updated : u) : old); toast.success("User updated"); }} />
    </div>
  );

  if (embedded) return content;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto p-6 lg:p-8 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage user accounts and permissions</p>
        </div>
        {content}
      </div>
    </div>
  );
}
