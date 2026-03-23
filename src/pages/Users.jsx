import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Plus,
  Shield,
  User as UserIcon,
  RefreshCw,
  Trash2,
  KeyRound,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import CreateLocalUserModal from "../components/users/CreateLocalUserModal";
import UserPermissionsModal from "../components/users/UserPermissionsModal";
import ChangePasswordModal from "../components/users/ChangePasswordModal";

export default function Users() {
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();

  const isAdmin = currentUser?.role === "admin";

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingPermissionsUser, setEditingPermissionsUser] = useState(null);
  const [passwordUser, setPasswordUser] = useState(null);

  const {
    data: users = [],
    isLoading,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      return await base44.users.list();
    },
    enabled: !!currentUser,
  });

  const createUserMutation = useMutation({
    mutationFn: async (formData) => {
      const payload = {
        email: formData.email,
        full_name: formData.full_name || "",
        role: formData.role || "user",
        password: formData.password,
      };
      return await base44.users.create(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setCreateModalOpen(false);
      toast.success("User created successfully");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create user");
    },
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: async ({ id, permissions }) => {
      return await base44.users.updatePermissions(id, permissions);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setEditingPermissionsUser(null);
      toast.success("User updated");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update user");
    },
  });

  const updatePasswordMutation = useMutation({
    mutationFn: async ({ id, password }) => {
      return await base44.users.updatePassword(id, password);
    },
    onSuccess: () => {
      setPasswordUser(null);
      toast.success("Password updated");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update password");
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.users.delete(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await refetch();
      toast.success("User deleted");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete user");
    },
  });

  const handleCreateUser = async (formData) => {
    await createUserMutation.mutateAsync(formData);
  };

  const handleSavePermissions = async (id, permissionState) => {
    await updatePermissionsMutation.mutateAsync({
      id,
      permissions: permissionState,
    });
  };

  const handleChangePassword = async (id, password) => {
    await updatePasswordMutation.mutateAsync({ id, password });
  };

  const handleDeleteUser = async (user) => {
    if (!isAdmin) {
      toast.error("Only admins can delete users");
      return;
    }
    if (currentUser?.id === user.id) {
      toast.error("You cannot delete your own account");
      return;
    }

    const confirmed = window.confirm(`Delete ${user.full_name || user.email}? This cannot be undone.`);
    if (!confirmed) return;

    await deleteUserMutation.mutateAsync(user.id);
  };

  const activeUsers = users.filter((u) => u.is_active !== false);
  const adminCount = users.filter((u) => u.role === "admin").length;

  // Non-admins should not be able to reach this page at all (nav is hidden),
  // but guard the UI explicitly as a second layer of defence.
  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="text-center space-y-3">
          <Lock className="w-12 h-12 text-[var(--text-tertiary)] mx-auto" />
          <h3 className="text-lg font-medium text-[var(--text-primary)]">Access Denied</h3>
          <p className="text-[var(--text-secondary)]">You do not have permission to manage users.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
              Users
            </h1>
            <p className="text-[var(--text-secondary)] mt-1">
              {activeUsers.length} active user{activeUsers.length === 1 ? "" : "s"} · {adminCount} admin{adminCount === 1 ? "" : "s"}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              className="border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>

            <Button
              onClick={() => setCreateModalOpen(true)}
              className="bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add User
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-24 bg-[var(--bg-secondary)] rounded-xl animate-pulse"
              />
            ))}
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-16 bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-color)]">
            <UserIcon className="w-12 h-12 text-[var(--text-tertiary)] mx-auto mb-4" />
            <h3 className="text-lg font-medium text-[var(--text-primary)]">
              No users found
            </h3>
            <p className="text-[var(--text-secondary)] mt-1 mb-6">
              Create your first user account
            </p>
            <Button
              onClick={() => setCreateModalOpen(true)}
              className="bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add User
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {users.map((user) => (
              <Card
                key={user.id}
                className="border-[var(--border-color)] bg-[var(--bg-secondary)]"
              >
                <CardContent className="p-5">
                  <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                          {user.full_name || "Unnamed User"}
                        </h3>

                        <Badge
                          variant="outline"
                          className={
                            user.role === "admin"
                              ? "border-purple-700 text-purple-400"
                              : "border-[var(--border-color)] text-[var(--text-secondary)]"
                          }
                        >
                          {user.role === "admin" ? "Admin" : "User"}
                        </Badge>

                        <Badge
                          variant="outline"
                          className={
                            user.is_active
                              ? "border-green-700 text-green-400"
                              : "border-red-700 text-red-400"
                          }
                        >
                          {user.is_active ? "Active" : "Disabled"}
                        </Badge>

                        {currentUser?.id === user.id && (
                          <Badge
                            variant="outline"
                            className="border-blue-700 text-blue-400"
                          >
                            You
                          </Badge>
                        )}
                      </div>

                      <p className="text-sm text-[var(--text-secondary)] mt-1">
                        {user.email}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        onClick={() => setEditingPermissionsUser(user)}
                        className="border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <Shield className="w-4 h-4 mr-2" />
                        Permissions
                      </Button>

                      <Button
                        variant="outline"
                        onClick={() => setPasswordUser(user)}
                        className="border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <KeyRound className="w-4 h-4 mr-2" />
                        Password
                      </Button>

                      {currentUser?.id !== user.id && (
                        <Button
                          variant="outline"
                          onClick={() => handleDeleteUser(user)}
                          disabled={deleteUserMutation.isPending}
                          className="border-red-800 text-red-400 hover:bg-red-900/20 hover:text-red-300"
                        >
                          {deleteUserMutation.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <CreateLocalUserModal
          open={createModalOpen}
          onClose={() => setCreateModalOpen(false)}
          onCreate={handleCreateUser}
          isCreating={createUserMutation.isPending}
        />

        <UserPermissionsModal
          user={editingPermissionsUser}
          open={!!editingPermissionsUser}
          onClose={() => setEditingPermissionsUser(null)}
          onSave={handleSavePermissions}
          isSaving={updatePermissionsMutation.isPending}
        />

        <ChangePasswordModal
          user={passwordUser}
          open={!!passwordUser}
          onClose={() => setPasswordUser(null)}
          onSave={handleChangePassword}
          isSaving={updatePasswordMutation.isPending}
        />
      </div>
    </div>
  );
}
