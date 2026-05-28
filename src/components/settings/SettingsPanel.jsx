// SettingsPanel — thin shell that builds the tab list based on
// hubMode/permission flags, then mounts the matching tab component.
// All tab bodies live under src/components/settings/tabs/<TabName>.jsx;
// this file just composes them. See issue #285 for the split history.

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/lib/permissions";
import DisasterRecoveryWizard from "@/components/settings/DisasterRecoveryWizard";

// UI
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Tabs
import ConnectionsTab from "@/components/settings/tabs/ConnectionsTab";
import FieldsTab from "@/components/settings/tabs/FieldsTab";
import SyncLogTab from "@/components/settings/tabs/SyncLogTab";
import AuditTab from "@/components/settings/tabs/AuditTab";
import AutoFlagTab from "@/components/settings/tabs/AutoFlagTab";
import MaintenanceTab from "@/components/settings/tabs/MaintenanceTab";
import HubMaintenanceTab from "@/components/settings/tabs/HubMaintenanceTab";
import CreditLogicTab from "@/components/settings/tabs/CreditLogicTab";
import AccountingTab from "@/components/settings/tabs/AccountingTab";
import ReconciliationSettingsTab from "@/components/settings/tabs/ReconciliationSettingsTab";
import NtopngTab from "@/components/settings/tabs/NtopngTab";
import TlsTab from "@/components/settings/tabs/TlsTab";
import UsersTabContent from "@/components/settings/tabs/UsersTabContent";
import SageCorrectionsTab from "@/components/settings/tabs/SageCorrectionsTab";
import ForecastSettingsTab from "@/components/settings/tabs/ForecastSettingsTab";
import DepotProfileTab from "@/components/settings/tabs/DepotProfileTab";
import PriceListSettingsTab from "@/components/settings/tabs/PriceListSettingsTab";
import CommissionSettingsTab from "@/components/settings/tabs/CommissionSettingsTab";

// Section/Row — tiny layout helpers used (only) by TlsTab. Kept here and
// re-exported (rather than moved to a _shared file) per the issue brief.


export function Section({ title, children }) {
  return (
    <div className="border-t pt-4">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function Row({ label, value, mono }) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("flex-1 break-all", mono && "font-mono")}>{value}</span>
    </div>
  );
}

export default function SettingsPanel({ open, onClose, hubMode, initialTab }) {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || isAdmin;

  // Tabs are grouped by purpose. Groups render with a small visual
  // divider between them so the operator can see Access vs Customer
  // settings vs Modules at a glance. System Log + Updates live on the
  // Operations page (PR #185), not here. The hub-side "Maintenance" is
  // labelled "Hub Maintenance" so the two never appear with identical text.
  const tabGroups = [
    {
      name: "Access",
      tabs: [
        canManageUsers && { id: "users", label: "Users" },
      ],
    },
    {
      name: "Company",
      tabs: [
        isAdmin && { id: "depot", label: "Depot Details" },
      ],
    },
    {
      name: "Customer",
      tabs: [
        canManageRules && { id: "creditlogic", label: "Credit Logic" },
        { id: "autoflag", label: "Auto-Flag Rules" },
        { id: "fields", label: "Fields" },
      ],
    },
    {
      name: "Data",
      tabs: [
        !hubMode && { id: "connections", label: "Connections" },
        !hubMode && isAdmin && { id: "sagecorrections", label: "Sage Corrections" },
        hubMode && { id: "synclog", label: "Sync Log" },
      ],
    },
    {
      name: "Modules",
      tabs: [
        isAdmin && { id: "reconciliation", label: "Reconciliation" },
        !hubMode && isAdmin && { id: "forecast", label: "Forecast" },
        !hubMode && isAdmin && { id: "pricelist", label: "Price List" },
        !hubMode && isAdmin && { id: "commission", label: "Commission" },
      ],
    },
    {
      name: "System",
      tabs: [
        isAdmin && { id: "accounting", label: "Accounting" },
        !hubMode && isAdmin && { id: "audit", label: "Audit Log" },
        !hubMode && isAdmin && { id: "maintenance", label: "Maintenance" },
        !hubMode && isAdmin && { id: "dr", label: "Disaster Recovery" },
        hubMode && isAdmin && { id: "hubmaintenance", label: "Hub Maintenance" },
        hubMode && isAdmin && { id: "network", label: "Network" },
        isAdmin && { id: "tls", label: "TLS" },
      ],
    },
  ]
    .map(g => ({ ...g, tabs: g.tabs.filter(Boolean) }))
    .filter(g => g.tabs.length > 0);

  const tabs = tabGroups.flatMap(g => g.tabs);

  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? "autoflag");

  // Reset to initialTab (if it exists in the visible tab list) or the
  // first tab when opened. Includes the tab id list in the deps because
  // currentUser loads asynchronously — the very first render may not
  // have the admin-only tabs (e.g. "pricelist") yet. We re-run when the
  // tab list expands so a deep link like initialTab="pricelist" still
  // wins after the user data arrives.
  const tabIdsKey = tabs.map(t => t.id).join(",");
  useEffect(() => {
    if (!open) return;
    if (initialTab && tabs.some(t => t.id === initialTab)) {
      setActiveTab(initialTab);
      return;
    }
    // No initialTab (or it isn't visible to this user) — make sure the
    // current activeTab is still valid; otherwise snap to the first.
    if (!tabs.some(t => t.id === activeTab)) {
      setActiveTab(tabs[0]?.id ?? "autoflag");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab, tabIdsKey]);

  // Which group does the current tab belong to? Drives the second-row strip.
  const activeGroup = tabGroups.find(g => g.tabs.some(t => t.id === activeTab)) ?? tabGroups[0];

  // Clicking a group jumps to its first tab.
  const onGroupChange = (groupName) => {
    const g = tabGroups.find(gr => gr.name === groupName);
    if (g?.tabs[0]) setActiveTab(g.tabs[0].id);
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-6xl w-full h-[100dvh] sm:h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">
            § Settings
          </div>
          <DialogTitle className="font-display text-4xl leading-tight tracking-tight text-foreground">
            Configure the <em className="text-phosphor">ledger</em>.
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 overflow-hidden">
          {/* Top row: group selector */}
          <div className="mx-6 mt-4 shrink-0 flex items-center gap-1 overflow-x-auto flex-nowrap border-b border-border pb-0">
            {tabGroups.map((g) => {
              const active = g.name === activeGroup?.name;
              return (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => onGroupChange(g.name)}
                  className={cn(
                    "shrink-0 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                    active
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  {g.name}
                </button>
              );
            })}
          </div>

          {/* Second row: sub-tabs of the active group */}
          <TabsList className="mx-6 mt-3 shrink-0 justify-start overflow-x-auto flex-nowrap">
            {(activeGroup?.tabs ?? []).map(t => (
              <TabsTrigger key={t.id} value={t.id} className="shrink-0">{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <TabsContent value={activeTab} className="mt-0">
              {activeTab === "users" && <UsersTabContent />}
              {activeTab === "depot" && <DepotProfileTab />}
              {activeTab === "creditlogic" && <CreditLogicTab hubMode={hubMode} currentUser={currentUser} />}
              {activeTab === "autoflag" && <AutoFlagTab hubMode={hubMode} />}
              {activeTab === "fields" && <FieldsTab />}
              {activeTab === "audit" && <AuditTab />}
              {activeTab === "tls" && <TlsTab />}
              {activeTab === "synclog" && <SyncLogTab />}
              {activeTab === "connections" && <ConnectionsTab currentUser={currentUser} />}
              {activeTab === "maintenance" && <MaintenanceTab />}
              {activeTab === "dr" && <DisasterRecoveryWizard />}
              {activeTab === "hubmaintenance" && <HubMaintenanceTab />}
              {activeTab === "network" && <NtopngTab />}
              {activeTab === "reconciliation" && <ReconciliationSettingsTab />}
              {activeTab === "forecast" && <ForecastSettingsTab />}
              {activeTab === "pricelist" && <PriceListSettingsTab />}
              {activeTab === "commission" && <CommissionSettingsTab />}
              {activeTab === "accounting" && <AccountingTab />}
              {activeTab === "sagecorrections" && <SageCorrectionsTab />}
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

