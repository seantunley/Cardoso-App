import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Shield } from "lucide-react";

const permissionGroups = [
  {
    category: "Feature Access",
    description: "Control which pages users can view",
    permissions: [
      { key: "can_access_customer_search", label: "Customer Search", description: "Look up and view customer records" },
      { key: "can_access_records", label: "Records", description: "View and browse all data records" },
      { key: "can_access_reports", label: "Reports", description: "View reports and analytics" },
      { key: "can_access_connections", label: "Connections", description: "Manage database connections" },
      { key: "can_access_settings", label: "Settings", description: "Configure auto-flag rules" },
    ]
  },
  {
    category: "Administration",
    description: "Control management capabilities",
    permissions: [
      { key: "can_manage_users", label: "User Management", description: "Create users and manage permissions" },
      { key: "can_manage_rules", label: "Rule Management", description: "Create and modify auto-flag rules" },
    ]
  },
  {
    category: "Actions",
    description: "Control what users can do within features",
    permissions: [
      { key: "can_edit_records", label: "Edit Records", description: "Modify record details and notes" },
      { key: "can_flag_records", label: "Flag Records", description: "Manually add or remove record flags" },
    ]
  }
];

export default function UserPermissionsModal({ user, open, onClose, onSave, isSaving }) {
  const [permissionState, setPermissionState] = useState({});

  useEffect(() => {
    if (user) {
      const newState = {
        is_active: user.is_active !== false,
      };

      permissionGroups.forEach(group => {
        group.permissions.forEach(perm => {
          newState[perm.key] = user[perm.key] !== false;
        });
      });

      setPermissionState(newState);
    }
  }, [user, open]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(user.id, permissionState);
  };

  const togglePermission = (key) => {
    setPermissionState(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md bg-[var(--bg-secondary)] border-[var(--border-color)]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg">
              <Shield className="w-5 h-5 text-[var(--text-secondary)]" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold text-[var(--text-primary)]">
                Edit Permissions
              </DialogTitle>
              {user && (
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                  {user.full_name} • {user.email}
                </p>
              )}
            </div>
          </div>
        </DialogHeader>

        {user?.role === "admin" && (
          <div className="mx-1 mb-2 rounded-lg border border-amber-700/50 bg-amber-900/20 px-3 py-2">
            <p className="text-xs text-amber-400">
              Admins have full access by default. Per-permission toggles apply only to users with the <strong>User</strong> role.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6 py-4 max-h-96 overflow-y-auto">
          <div className="space-y-3">
            <div className="border-b border-[var(--border-color)] pb-2">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Account Status</h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Enable or disable the user account
              </p>
            </div>

            <div className="flex items-start justify-between gap-3 p-2 hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors">
              <div className="flex-1 min-w-0">
                <Label htmlFor="is_active" className="text-sm font-medium text-[var(--text-primary)] cursor-pointer block">
                  Active Account
                </Label>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Disabled users cannot sign in
                </p>
              </div>
              <Switch
                id="is_active"
                checked={permissionState.is_active || false}
                onCheckedChange={() => togglePermission("is_active")}
                className="mt-0.5"
              />
            </div>
          </div>

          {permissionGroups.map((group) => (
            <div key={group.category} className="space-y-3">
              <div className="border-b border-[var(--border-color)] pb-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{group.category}</h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">{group.description}</p>
              </div>
              <div className="space-y-3 pl-2">
                {group.permissions.map((perm) => (
                  <div
                    key={perm.key}
                    className="flex items-start justify-between gap-3 p-2 hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <Label htmlFor={perm.key} className="text-sm font-medium text-[var(--text-primary)] cursor-pointer block">
                        {perm.label}
                      </Label>
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5">{perm.description}</p>
                    </div>
                    <Switch
                      id={perm.key}
                      checked={permissionState[perm.key] || false}
                      onCheckedChange={() => togglePermission(perm.key)}
                      className="mt-0.5"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          <DialogFooter className="pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaving}
              className="bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90"
            >
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save Permissions
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}