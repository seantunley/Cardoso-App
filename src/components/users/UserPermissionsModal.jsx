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
import { Loader2, Shield, HelpCircle } from "lucide-react";

const permissionGroups = [
  {
    category: "Feature Access",
    description: "Control which pages users can view",
    permissions: [
      { key: "can_access_customer_search", label: "Customer Search", description: "Look up and view customer records" },
      { key: "can_access_customer_balances", label: "Customer Balances", description: "View the customer balances page" },
      { key: "can_access_collections", label: "Collections", description: "Work the collections pipeline" },
      { key: "can_access_inventory", label: "Inventory", description: "View and browse inventory records" },
      { key: "can_access_network_devices", label: "Network Devices", description: "View discovered network devices and bandwidth estimates" },
      { key: "can_access_hub_metrics", label: "Site Metrics", description: "View hub machine health metrics" },
      { key: "can_access_hub_backups", label: "Site Backups", description: "View and manage site backups from the hub" },
      { key: "can_access_hub_trends", label: "Trends", description: "View multi-site reporting trends in the hub" },
      { key: "can_access_records", label: "Records", description: "View and browse all raw data records" },
      { key: "can_access_reports", label: "Reports", description: "View the printable reports module (Aged Debtors, BAT Weekly, Sales Rep Exposure, etc.)" },
      { key: "can_access_reconciliation", label: "BAT Reconciliation", description: "Access the per-site BAT supplier reconciliation module" },
      { key: "can_access_hub_reconciliation", label: "Hub Reconciliation", description: "View cross-site BAT reconciliation summary (hub mode only)" },
      { key: "can_access_connections", label: "Connections", description: "Manage database connections" },
      { key: "can_access_settings", label: "Settings", description: "Access settings panel" },
      { key: "can_access_jti", label: "JTI Export", description: "Generate JTI sales export from live Accpac (vendor-scoped, replaces the Crystal report + Excel macro flow)" },
    ]
  },
  {
    category: "Administration",
    description: "Control management capabilities",
    permissions: [
      { key: "can_manage_users", label: "User Management", description: "Create users and manage permissions" },
      { key: "can_manage_rules", label: "Rule Management", description: "Create and modify auto-flag rules" },
      { key: "hub_redirect", label: "Hub Redirect", description: "Logging in at any site redirects this user to the Head Office hub" },
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
  // "Why denied?" diagnostic — populated when the operator clicks the
  // help icon next to a permission. Maps key → { allowed, reason, source }
  // straight from GET /api/users/:id/permission-explain. Cleared whenever
  // the modal reopens so we never show stale info from a previous user.
  const [explanations, setExplanations] = useState({});
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState(null);

  useEffect(() => {
    if (user) {
      const newState = {
        is_active: user.is_active !== false,
        role: user.role === 'admin' ? 'admin' : 'user',
      };

      permissionGroups.forEach(group => {
        group.permissions.forEach(perm => {
          newState[perm.key] = user[perm.key] !== false;
        });
      });

      setPermissionState(newState);
      setExplanations({});
      setExplainError(null);
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

  const loadExplanations = async () => {
    if (!user || explainLoading) return;
    setExplainLoading(true);
    setExplainError(null);
    try {
      const res = await fetch(`/api/users/${user.id}/permission-explain`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setExplanations(data.permissions || {});
    } catch (err) {
      setExplainError(err.message);
    } finally {
      setExplainLoading(false);
    }
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
              Admins have full access by default, but individual modules can be turned off here (e.g. a BAT-only admin who shouldn't see Network Devices).
            </p>
          </div>
        )}

        {/* "Why denied?" diagnostic toggle. Calls /api/users/:id/permission-explain
            and renders the per-permission reason inline below each switch.
            Useful when an admin can't figure out why a user can't see a page —
            instead of mentally tracing the rule chain, they see the source
            (admin_default / admin_explicit_off / user_grant / user_deny). */}
        <div className="mx-1 mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={loadExplanations}
            disabled={explainLoading}
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {explainLoading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <HelpCircle className="w-3.5 h-3.5" />}
            <span>{Object.keys(explanations).length > 0 ? "Refresh diagnostic" : "Diagnose: why is each permission allowed/denied?"}</span>
          </button>
          {Object.keys(explanations).length > 0 && (
            <button
              type="button"
              onClick={() => setExplanations({})}
              className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Hide
            </button>
          )}
        </div>
        {explainError && (
          <p className="mx-1 mb-2 text-xs text-red-400">Diagnostic failed: {explainError}</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-6 py-4 max-h-[60vh] overflow-y-auto">
          <div className="space-y-3">
            <div className="border-b border-[var(--border-color)] pb-2">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Account Status</h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Enable, disable, or change role
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

            {/* Role select. Server-side guards prevent self-demotion AND
                demoting the last remaining admin (would lock the system
                out of user management). Toggle is rendered as a pair of
                pill buttons rather than a Switch because the choice is
                a fixed two-value enum, not boolean state. */}
            <div className="flex items-start justify-between gap-3 p-2 hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors">
              <div className="flex-1 min-w-0">
                <Label className="text-sm font-medium text-[var(--text-primary)] block">
                  Role
                </Label>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Admins bypass per-permission gates. Demote to scope by the toggles below.
                </p>
              </div>
              <div className="flex gap-1 mt-0.5">
                {['admin', 'user'].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setPermissionState(prev => ({ ...prev, role: r }))}
                    className={
                      "px-2.5 py-1 text-xs font-medium rounded-md border transition-colors " +
                      (permissionState.role === r
                        ? "border-[var(--phosphor)] bg-[var(--phosphor)]/15 text-[var(--phosphor)]"
                        : "border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
                    }
                  >
                    {r === 'admin' ? 'Admin' : 'User'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {permissionGroups.map((group) => (
            <div key={group.category} className="space-y-3">
              <div className="border-b border-[var(--border-color)] pb-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{group.category}</h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">{group.description}</p>
              </div>
              <div className="space-y-3 pl-2">
                {group.permissions.map((perm) => {
                  const explanation = explanations[perm.key];
                  return (
                    <div
                      key={perm.key}
                      className="flex flex-col gap-1 p-2 hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
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
                      {explanation && (
                        <p
                          className={
                            "text-[11px] leading-snug pl-0.5 " +
                            (explanation.allowed ? "text-emerald-400" : "text-amber-400")
                          }
                        >
                          {explanation.allowed ? "✓ allowed" : "✗ denied"}
                          <span className="text-[var(--text-secondary)]"> · </span>
                          {explanation.reason}
                        </p>
                      )}
                    </div>
                  );
                })}
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
