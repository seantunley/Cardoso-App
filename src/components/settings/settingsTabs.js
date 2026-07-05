// Settings tab registry — the single source of truth for which settings tabs
// exist, how they're grouped, and who can see them. Extracted from
// SettingsPanel (first slice of the #285 split) so the command palette can
// offer "Settings → Users"-style deep links with EXACTLY the visibility rules
// the panel itself applies — one registry, two consumers, no drift.
//
// Pure function: no hooks, no fetching. Callers supply the already-resolved
// currentUser + hubMode.

import { hasPermission } from "@/lib/permissions";

/**
 * Build the grouped, permission-filtered settings tab list.
 *
 * @param {{ currentUser: object|null|undefined, hubMode: boolean }} args
 * @returns {{ name: string, tabs: { id: string, label: string }[] }[]}
 *   Groups with at least one visible tab, in render order.
 */
export function buildSettingsTabGroups({ currentUser, hubMode }) {
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || isAdmin;

  // Tabs are grouped by purpose. Groups render with a small visual
  // divider between them so the operator can see Access vs Customer
  // settings vs Modules at a glance. System Log + Updates live on the
  // Operations page (PR #185), not here. The hub-side "Maintenance" is
  // labelled "Hub Maintenance" so the two never appear with identical text.
  return [
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
        !hubMode && isAdmin && { id: "sagequeries", label: "Sage Queries" },
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
        !hubMode && isAdmin && { id: "creditors", label: "Creditors" },
        !hubMode && isAdmin && { id: "debtors", label: "Debtors" },
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
        isAdmin && { id: "tls", label: "TLS" },
      ],
    },
  ]
    .map(g => ({ ...g, tabs: g.tabs.filter(Boolean) }))
    .filter(g => g.tabs.length > 0);
}
