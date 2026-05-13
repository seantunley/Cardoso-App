import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/lib/permissions";
import { humanizeApiError } from "@/lib/humanizeApiError";
import { cleanImportToastMessage, resetCleanSyncStreak } from "@/lib/fun";

// UI
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Icons
import {
  Zap, Plus,
  RefreshCw, AlertCircle, CheckCircle2, Clock, LogIn, ClipboardList,
  Download, Upload, GitBranch, Send, Info, Workflow, AlertTriangle,
  Lock, ShieldCheck, ShieldAlert, ExternalLink, Save, Database,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ReconResetModal from "@/components/reconciliation/ReconResetModal";

// Sub-components
import AutoFlagRuleForm from "@/components/settings/AutoFlagRuleForm";
import AuditLogTable from "@/components/audit/AuditLogTable";

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



// ─── Main SettingsPanel ──────────────────────────────────────────────────────





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

export default function SettingsPanel({ open, onClose, hubMode }) {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || isAdmin;

  // Build tabs based on context
  const tabs = [
    canManageUsers && { id: "users", label: "Users" },
    canManageRules && { id: "creditlogic", label: "Credit Logic" },
    { id: "autoflag", label: "Auto-Flag Rules" },
    { id: "fields", label: "Fields" },
    !hubMode && { id: "connections", label: "Connections" },
    !hubMode && isAdmin && { id: "audit", label: "Audit Log" },
    // System Log + Updates moved to the Operations page (PR #185). Kept
    // out of Settings to avoid two-places-to-look for the same data.
    isAdmin && { id: "tls", label: "TLS" },
    !hubMode && isAdmin && { id: "maintenance", label: "Maintenance" },
    hubMode && { id: "synclog", label: "Sync Log" },
    hubMode && isAdmin && { id: "hubmaintenance", label: "Maintenance" },
    hubMode && isAdmin && { id: "network", label: "Network" },
    isAdmin && { id: "reconciliation", label: "Reconciliation" },
    isAdmin && { id: "accounting", label: "Accounting" },
  ].filter(Boolean);

  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? "autoflag");

  // Reset to first tab when opened
  useEffect(() => { if (open) setActiveTab(tabs[0]?.id ?? "autoflag"); }, [open]);

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
          <TabsList className="mx-6 mt-4 shrink-0 justify-start overflow-x-auto flex-nowrap">
            {tabs.map(t => (
              <TabsTrigger key={t.id} value={t.id} className="shrink-0">{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <TabsContent value={activeTab} className="mt-0">
              {activeTab === "users" && <UsersTabContent />}
              {activeTab === "creditlogic" && <CreditLogicTab hubMode={hubMode} currentUser={currentUser} />}
              {activeTab === "autoflag" && <AutoFlagTab hubMode={hubMode} />}
              {activeTab === "fields" && <FieldsTab />}
              {activeTab === "audit" && <AuditTab />}
              {activeTab === "tls" && <TlsTab />}
              {activeTab === "synclog" && <SyncLogTab />}
              {activeTab === "connections" && <ConnectionsTab currentUser={currentUser} />}
              {activeTab === "maintenance" && <MaintenanceTab />}
              {activeTab === "hubmaintenance" && <HubMaintenanceTab />}
              {activeTab === "network" && <NtopngTab />}
              {activeTab === "reconciliation" && <ReconciliationSettingsTab />}
              {activeTab === "accounting" && <AccountingTab />}
            </TabsContent>
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
