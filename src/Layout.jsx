import { Link } from "react-router-dom";
import {
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  ClipboardList,
  Network,
  Sun,
  Moon,
  FlaskConical,
} from "lucide-react";
import { applyTheme } from "@/lib/AuthContext";

// ── Custom nav SVG icons ──────────────────────────────────────────────────────
const IconCustomerSearch = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <circle cx="8" cy="7" r="3" fill="#60a5fa" opacity="0.9"/>
    <path d="M3 16c0-2.761 2.239-4 5-4s5 1.239 5 4" stroke="#3b82f6" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
    <circle cx="8" cy="7" r="3" stroke="#93c5fd" strokeWidth="1" fill="none"/>
    <line x1="14" y1="14" x2="18" y2="18" stroke="#93c5fd" strokeWidth="1.8" strokeLinecap="round"/>
    <circle cx="14" cy="11" r="3" stroke="#60a5fa" strokeWidth="1.6" fill="none"/>
  </svg>
);

const IconHubDashboard = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <circle cx="10" cy="10" r="7.5" stroke="#818cf8" strokeWidth="1.5" fill="none"/>
    <ellipse cx="10" cy="10" rx="3.5" ry="7.5" stroke="#818cf8" strokeWidth="1.2" fill="none"/>
    <line x1="2.5" y1="10" x2="17.5" y2="10" stroke="#a5b4fc" strokeWidth="1.2"/>
    <line x1="3.5" y1="6.5" x2="16.5" y2="6.5" stroke="#818cf8" strokeWidth="0.9" opacity="0.6"/>
    <line x1="3.5" y1="13.5" x2="16.5" y2="13.5" stroke="#818cf8" strokeWidth="0.9" opacity="0.6"/>
    <circle cx="10" cy="10" r="1.2" fill="#c7d2fe"/>
  </svg>
);

const IconSiteBackups = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <rect x="2" y="3" width="16" height="4" rx="1.5" fill="#0e7490" opacity="0.7"/>
    <rect x="2" y="8.5" width="16" height="4" rx="1.5" fill="#0e7490" opacity="0.5"/>
    <circle cx="15.5" cy="5" r="1" fill="#67e8f9"/>
    <circle cx="15.5" cy="10.5" r="1" fill="#67e8f9" opacity="0.6"/>
    <path d="M10 14.5 L10 18 M10 18 L7.5 15.5 M10 18 L12.5 15.5" stroke="#22d3ee" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const IconCustomerBalances = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <line x1="10" y1="2.5" x2="10" y2="5" stroke="#34d399" strokeWidth="1.6" strokeLinecap="round"/>
    <line x1="10" y1="5" x2="4" y2="8" stroke="#10b981" strokeWidth="1.4" strokeLinecap="round"/>
    <line x1="10" y1="5" x2="16" y2="8" stroke="#10b981" strokeWidth="1.4" strokeLinecap="round"/>
    <rect x="2" y="8" width="4" height="3" rx="1" fill="#34d399" opacity="0.85"/>
    <rect x="14" y="8" width="4" height="3" rx="1" fill="#34d399" opacity="0.6"/>
    <line x1="2" y1="17.5" x2="18" y2="17.5" stroke="#6ee7b7" strokeWidth="1.4" strokeLinecap="round"/>
    <line x1="10" y1="11" x2="10" y2="17.5" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round"/>
    <circle cx="10" cy="5" r="1" fill="#6ee7b7"/>
  </svg>
);

const IconInventory = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    <rect x="2" y="11" width="7" height="7" rx="1" fill="#fb923c" opacity="0.9"/>
    <rect x="11" y="11" width="7" height="7" rx="1" fill="#fb923c" opacity="0.65"/>
    <rect x="6" y="3" width="8" height="7" rx="1" fill="#fdba74" opacity="0.9"/>
    <line x1="10" y1="3" x2="10" y2="10" stroke="#f97316" strokeWidth="1"/>
    <line x1="6" y1="6.5" x2="14" y2="6.5" stroke="#f97316" strokeWidth="1"/>
  </svg>
);

// Reconciliation — phosphor pulse cutting through stacked ledger rows.
// Teal rows = static records; amber waveform = live matching across them.
const IconReports = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Document base with phosphor amber border-left */}
    <rect x="3" y="2.5" width="13" height="15" rx="1.2" fill="hsl(33 95% 55%)" opacity="0.10"/>
    <rect x="3" y="2.5" width="0.7" height="15" fill="hsl(33 95% 55%)"/>
    {/* Bar chart bars in colourful palette */}
    <rect x="5"   y="11" width="1.6" height="4.5" rx="0.2" fill="hsl(33 95% 55%)"/>
    <rect x="7.2" y="8.5" width="1.6" height="7"   rx="0.2" fill="hsl(145 55% 45%)"/>
    <rect x="9.4" y="10" width="1.6" height="5.5" rx="0.2" fill="hsl(200 80% 55%)"/>
    <rect x="11.6" y="6.5" width="1.6" height="9" rx="0.2" fill="hsl(280 70% 65%)"/>
    {/* Header lines (title bars) */}
    <line x1="5" y1="4.5" x2="13.5" y2="4.5" stroke="hsl(var(--foreground))" strokeWidth="0.7" opacity="0.7"/>
    <line x1="5" y1="6.2" x2="11"   y2="6.2" stroke="hsl(var(--foreground))" strokeWidth="0.5" opacity="0.4"/>
    {/* Trend line dot */}
    <circle cx="13.5" cy="5.5" r="0.6" fill="hsl(0 72% 50%)"/>
  </svg>
);

const IconReconciliation = ({ className, style }) => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
    {/* Subtle ledger frame */}
    <rect x="1.5" y="3" width="17" height="14" rx="1.2" fill="#0d9488" opacity="0.12"/>
    {/* Stacked ledger rows */}
    <line x1="3" y1="5.5"  x2="17" y2="5.5"  stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    <line x1="3" y1="8"    x2="17" y2="8"    stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    <line x1="3" y1="12"   x2="17" y2="12"   stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    <line x1="3" y1="14.5" x2="17" y2="14.5" stroke="#14b8a6" strokeWidth="0.7" opacity="0.55"/>
    {/* Soft phosphor halo behind the pulse */}
    <path d="M1 10 L4 10 L5.5 7 L7.5 13 L9.5 8 L11.5 12 L13.5 9.5 L19 9.5"
          stroke="#f59e0b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.25"/>
    {/* Phosphor pulse waveform */}
    <path d="M1 10 L4 10 L5.5 7 L7.5 13 L9.5 8 L11.5 12 L13.5 9.5 L19 9.5"
          stroke="#f59e0b" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    {/* Leading-edge dot */}
    <circle cx="19" cy="9.5" r="1.1" fill="#f59e0b"/>
  </svg>
);
import { BarChart2, PhoneCall, TrendingUp, FileBarChart, GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { hasPermission } from "@/lib/permissions";
import ChangePasswordModal from "@/components/users/ChangePasswordModal";
import SettingsPanel from "@/components/settings/SettingsPanel";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";

const APP_VERSION = "2026.3.9";

const navItems = [
  { name: "Customer Management", icon: IconCustomerSearch,   page: "CustomerSearch",   permission: "can_access_customer_search", siteOnly: true },
  { name: "Customer Management", icon: IconHubDashboard,     page: "HubDashboard",     hubOnly: true },
  { name: "Customer Balances",   icon: IconCustomerBalances, page: "CustomerBalances", permission: "can_access_customer_balances" },
  { name: "Collections",         icon: PhoneCall,            page: "Collections",      permission: "can_access_collections", siteOnly: true },
  { name: "Inventory",           icon: IconInventory,        page: "Inventory",        permission: "can_access_inventory" },
  { name: "Network Devices",     icon: Network,              page: "NetworkDevices",   permission: "can_access_network_devices" },
  { name: "Reconciliation",      icon: GitCompare,           page: "HubReconciliation",permission: "can_access_hub_reconciliation", hubOnly: true },
  { name: "Site Metrics",        icon: BarChart2,            page: "HubMetrics",       permission: "can_access_hub_metrics", hubOnly: true },
  { name: "Site Backups",        icon: IconSiteBackups,      page: "HubBackups",       permission: "can_access_hub_backups", hubOnly: true },
  { name: "Trends",              icon: TrendingUp,           page: "HubTrends",        permission: "can_access_hub_trends", hubOnly: true },
  { name: "Hub Audit Log",       icon: ClipboardList,        page: "HubAuditLog",      permission: "can_access_hub_audit_log", hubOnly: true },
  { name: "Credit Debug",        icon: FlaskConical,         page: "CreditDebug",      adminOnly: true },
  { name: "Reconciliation",      icon: GitCompare,           page: "Reconciliation",   permission: "can_access_reconciliation" },
  { name: "Reports",             icon: FileBarChart,         page: "Reports",          permission: "can_access_reports" },
];

export default function Layout({ children, currentPageName }) {
  const [isCollapsed, setIsCollapsed]       = useState(true);
  const [theme, setTheme]                   = useState(() => localStorage.getItem('cardoso-theme') || 'dark');
  const [hubMode, setHubMode]               = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [versionStatus, setVersionStatus]   = useState({
    currentVersion: APP_VERSION,
    latestVersion:  APP_VERSION,
    updateAvailable: false,
  });
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [backupAttention, setBackupAttention] = useState(false);

  const { user: currentUser, logout } = useAuth();
  const isAdmin = currentUser?.role === "admin";

  useEffect(() => {
    fetch("/api/app-info")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.hub_mode) setHubMode(true); })
      .catch(err => reportClientError("Layout.appInfo", err));
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    let isMounted = true;
    fetch("/api/app-version-status", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && isMounted) setVersionStatus({
          currentVersion:  d.currentVersion  || APP_VERSION,
          latestVersion:   d.latestVersion   || APP_VERSION,
          updateAvailable: Boolean(d.updateAvailable),
        });
      })
      .catch(err => reportClientError("Layout.versionStatus", err));
    return () => { isMounted = false; };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !hubMode || !isAdmin) {
      setBackupAttention(false);
      return;
    }

    let cancelled = false;

    const pollBackupAttention = async () => {
      try {
        const res = await fetch("/api/hub/backup-status", { credentials: "include" });
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setBackupAttention(Boolean(data?.sql_attention));
      } catch {
        if (!cancelled) setBackupAttention(true);
      }
    };

    pollBackupAttention();
    const timer = setInterval(pollBackupAttention, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentUser, hubMode, isAdmin]);

  const triggerUpdate = async () => {
    if (!isAdmin || updateInstalling) return;
    setShowUpdateConfirm(true);
  };

  const confirmUpdate = async () => {
    setShowUpdateConfirm(false);
    setUpdateInstalling(true);
    try {
      const res = await fetch('/api/app-update-trigger', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setUpdateInstalling(false);
      }
    } catch (e) {
      setUpdateInstalling(false);
    }
  };

  const handleChangePassword = async (userId, newPassword) => {
    setIsSavingPassword(true);
    try {
      const res = await fetch(`/api/users/${userId}/password`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed"); }
      setChangePasswordOpen(false);
    } catch (err) { alert(err.message); }
    finally { setIsSavingPassword(false); }
  };

  const canShowNavItem = (item) => {
    if (!currentUser) return false;
    if (item.hubOnly && !hubMode) return false;
    if (item.siteOnly && hubMode) return false;
    if (item.adminOnly && !isAdmin) return false;
    if (item.permission) return hasPermission(currentUser, item.permission);
    return true;
  };

  const visibleNavItems = navItems.filter(canShowNavItem);
  const canSeeSettings  = isAdmin
    || hasPermission(currentUser, "can_access_settings")
    || hasPermission(currentUser, "can_manage_users")
    || hasPermission(currentUser, "can_manage_rules");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 hidden h-full flex-col lg:flex transition-all duration-300 ease-out",
          isCollapsed ? "w-14" : "w-60"
        )}
        style={{
          background: "hsl(var(--sidebar-background))",
          color: "hsl(var(--sidebar-foreground))",
          borderRight: "1px solid hsl(var(--sidebar-border))",
        }}
      >
        {/* ── Brand block ── */}
        <div className="px-3 pt-6 pb-5" style={{ borderBottom: "1px solid hsl(var(--sidebar-border))" }}>
          <div className={cn("flex items-center", isCollapsed ? "justify-center" : "gap-3")}>
            {/* Signature phosphor square */}
            <div
              className="shrink-0"
              style={{
                width: "22px",
                height: "22px",
                background: "var(--phosphor)",
                boxShadow: "0 0 20px hsla(33, 95%, 55%, 0.5)",
              }}
            />
            <div
              className={cn(
                "min-w-0 overflow-hidden transition-all duration-200 ease-out",
                isCollapsed ? "w-0 opacity-0" : "w-full opacity-100"
              )}
            >
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-[hsl(var(--sidebar-foreground))/0.6] whitespace-nowrap">
                Cardoso
              </div>
              <div className="font-display text-lg leading-tight text-[hsl(var(--sidebar-foreground))] whitespace-nowrap">
                Ledger
              </div>
            </div>
          </div>
          {currentUser && !isCollapsed && (
            <div className="mt-6 space-y-1">
              <p
                className="truncate font-mono text-[10px] uppercase tracking-[0.2em]"
                style={{ color: "hsla(var(--sidebar-foreground), 0.5)" }}
              >
                Operator
              </p>
              <p className="truncate text-xs font-medium text-[hsl(var(--sidebar-foreground))]">
                {currentUser.full_name || "User"}
              </p>
              <p className="truncate font-mono text-[10px]" style={{ color: "hsla(var(--sidebar-foreground), 0.45)" }}>
                {currentUser.email}
              </p>
            </div>
          )}
        </div>

        {/* ── Nav items — terminal list with phosphor left-bar on active ── */}
        <nav className={cn("flex-1 overflow-y-auto", isCollapsed ? "py-3 px-1 flex flex-col items-center" : "py-3 px-3")}>
          {!isCollapsed && (
            <div
              className="px-2 pb-2 mb-1 font-mono text-[9px] uppercase tracking-[0.25em]"
              style={{ color: "hsla(var(--sidebar-foreground), 0.4)" }}
            >
              § Navigation
            </div>
          )}
          <div className={cn("space-y-0.5", isCollapsed && "flex flex-col items-center w-full")}>
            {visibleNavItems.map((item) => {
              const isActive = currentPageName === item.page;
              const showAttention = item.page === "HubBackups" && backupAttention;
              return (
                <Link
                  key={item.page}
                  to={`/${item.page}`}
                  title={isCollapsed ? item.name : undefined}
                  className={cn(
                    "relative flex items-center text-xs font-medium transition-colors duration-150 group",
                    isCollapsed ? "justify-center w-10 h-10 mx-auto" : "gap-3 pl-4 pr-2 py-2.5 w-full text-sm"
                  )}
                  style={{
                    color: isActive
                      ? "hsl(var(--sidebar-accent-foreground))"
                      : "hsla(var(--sidebar-foreground), 0.65)",
                    background: isActive ? "hsl(var(--sidebar-accent))" : "transparent",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = "hsl(var(--sidebar-foreground))"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.color = "hsla(var(--sidebar-foreground), 0.65)"; }}
                >
                  {/* Phosphor active indicator — left bar */}
                  {isActive && (
                    <span
                      className="absolute left-0 top-1 bottom-1 w-[2px]"
                      style={{
                        background: "var(--phosphor)",
                        boxShadow: "0 0 12px hsla(33, 95%, 55%, 0.7)",
                      }}
                    />
                  )}
                  <item.icon className="h-6 w-6 shrink-0" />
                  {showAttention && (
                    <span
                      className={cn(
                        "absolute inline-flex h-1.5 w-1.5",
                        isCollapsed ? "top-1.5 right-1.5" : "top-2.5 right-2.5"
                      )}
                      style={{
                        background: "var(--phosphor)",
                        boxShadow: "0 0 8px hsla(33, 95%, 55%, 0.8)",
                      }}
                    />
                  )}
                  <span
                    className={cn(
                      "overflow-hidden whitespace-nowrap transition-all duration-200 ease-out tracking-tight",
                      isCollapsed ? "w-0 opacity-0" : "opacity-100"
                    )}
                  >
                    {item.name}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>
        <div
          className={cn(isCollapsed ? "p-1 flex flex-col items-center space-y-0.5" : "space-y-0 p-3")}
          style={{ borderTop: "1px solid hsl(var(--sidebar-border))" }}
        >
          {!isCollapsed && (
            <div
              className="px-2 pb-2 font-mono text-[9px] uppercase tracking-[0.25em]"
              style={{ color: "hsla(var(--sidebar-foreground), 0.4)" }}
            >
              § Controls
            </div>
          )}
          {canSeeSettings && (
            <SidebarButton
              onClick={() => setSettingsOpen(true)}
              icon={Settings}
              label="Settings"
              collapsed={isCollapsed}
            />
          )}

          <SidebarButton
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark';
              setTheme(next);
              applyTheme(next);
              fetch('/api/auth/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ theme_preference: next }) })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
                .catch(err => { toast.error(`Couldn't save theme: ${err.message}`); reportClientError("Layout.themeSave", err); });
            }}
            icon={theme === 'dark' ? Sun : Moon}
            label={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            collapsed={isCollapsed}
          />

          <SidebarButton
            onClick={() => setChangePasswordOpen(true)}
            icon={KeyRound}
            label="Password"
            collapsed={isCollapsed}
          />

          <SidebarButton
            onClick={() => logout(true)}
            icon={LogOut}
            label="Logout"
            collapsed={isCollapsed}
          />

          <SidebarButton
            onClick={() => setIsCollapsed(!isCollapsed)}
            icon={isCollapsed ? ChevronRight : ChevronLeft}
            label="Collapse"
            collapsed={isCollapsed}
          />

          <div className={cn("overflow-hidden transition-all duration-200 ease-out", isCollapsed ? "max-h-0 opacity-0" : "max-h-24 opacity-100")}>
            <div
              className={cn(
                "mt-3 mx-1 px-2 py-1.5 transition-colors font-mono text-[9px] uppercase tracking-[0.2em]",
                versionStatus.updateAvailable && isAdmin ? "cursor-pointer" : ""
              )}
              style={{
                borderLeft: versionStatus.updateAvailable
                  ? "2px solid var(--phosphor)"
                  : "2px solid transparent",
                color: versionStatus.updateAvailable
                  ? "var(--phosphor)"
                  : "hsla(var(--sidebar-foreground), 0.35)",
                background: versionStatus.updateAvailable && isAdmin
                  ? "hsla(33, 95%, 55%, 0.05)"
                  : "transparent",
              }}
              title={
                versionStatus.updateAvailable
                  ? isAdmin
                    ? updateInstalling
                      ? "Installing update…"
                      : `New: v${versionStatus.latestVersion} — click to install`
                    : `New: v${versionStatus.latestVersion}`
                  : `v${versionStatus.currentVersion}`
              }
              onClick={versionStatus.updateAvailable && isAdmin && !showUpdateConfirm ? triggerUpdate : undefined}
            >
              <div className="flex items-center justify-between">
                <span>Build</span>
                <span className="tabular-nums" style={{ color: "hsla(var(--sidebar-foreground), 0.55)" }}>
                  v{versionStatus.currentVersion}
                </span>
              </div>
              {versionStatus.updateAvailable && (
                updateInstalling
                  ? <p className="mt-1 animate-pulse">Installing…</p>
                  : showUpdateConfirm
                  ? (
                    <div className="mt-1.5 flex gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); confirmUpdate(); }}
                        className="flex-1 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] border border-current hover:bg-current hover:text-[hsl(var(--sidebar-background))] transition-colors"
                      >Install</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowUpdateConfirm(false); }}
                        className="flex-1 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] hover:bg-[hsl(var(--sidebar-accent))] transition-colors"
                        style={{ color: "hsla(var(--sidebar-foreground), 0.6)" }}
                      >Cancel</button>
                    </div>
                  )
                  : <p className="mt-1">→ v{versionStatus.latestVersion} available{isAdmin ? " · click" : ""}</p>
              )}
            </div>
          </div>
        </div>
      </aside>
      <header
        className="fixed left-0 right-0 top-0 z-50 flex h-14 items-center justify-between px-4 lg:hidden"
        style={{ background: "hsl(var(--sidebar-background))", borderBottom: "1px solid hsl(var(--sidebar-border))", color: "hsl(var(--sidebar-foreground))" }}
      >
        <div className="flex items-center gap-3">
          <div
            style={{
              width: "18px",
              height: "18px",
              background: "var(--phosphor)",
              boxShadow: "0 0 16px hsla(33, 95%, 55%, 0.5)",
            }}
          />
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em]" style={{ color: "hsla(var(--sidebar-foreground), 0.55)" }}>Cardoso</span>
            <span className="font-display text-base">Ledger</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {canSeeSettings && (
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}><Settings className="h-5 w-5 text-amber-400" /></Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); applyTheme(next); fetch('/api/auth/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ theme_preference: next }) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }).catch(err => { toast.error(`Couldn't save theme: ${err.message}`); reportClientError("Layout.themeSave", err); }); }} title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}>
            {theme === 'dark' ? <Sun className="h-5 w-5 text-accent" /> : <Moon className="h-5 w-5 text-muted-foreground" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setChangePasswordOpen(true)} title="Change Password">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => logout(true)} title="Logout">
            <LogOut className="h-5 w-5 text-muted-foreground" />
          </Button>
        </div>
      </header>
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center border-t border-border bg-card px-2 py-2 lg:hidden overflow-x-auto">
        {visibleNavItems.map((item) => {
          const isActive = currentPageName === item.page;
          const showAttention = item.page === "HubBackups" && backupAttention;
          return (
            <Link key={item.page} to={`/${item.page}`}
              className={cn("relative flex flex-col items-center gap-1 rounded-xl px-3 py-2 transition-all flex-shrink-0", isActive ? "text-foreground" : "text-muted-foreground")}>
              <item.icon className="h-5 w-5" style={!isActive && item.color ? { color: item.color } : undefined} />
              {showAttention && <span className="absolute top-1.5 right-2.5 inline-flex h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-card" />}
              <span className="text-xs font-medium truncate max-w-[60px] text-center">{item.name}</span>
            </Link>
          );
        })}
      </nav>
      <main className={cn("bg-background pt-16 pb-[calc(5rem+env(safe-area-inset-bottom))] transition-all duration-300 lg:pt-0 lg:pb-0", isCollapsed ? "lg:ml-14" : "lg:ml-60")}>
        {children}
      </main>
      {currentUser && (
        <ChangePasswordModal
          user={currentUser}
          open={changePasswordOpen}
          onClose={() => setChangePasswordOpen(false)}
          onSave={handleChangePassword}
          isSaving={isSavingPassword}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        hubMode={hubMode}
      />
    </div>
  );
}

function SidebarButton({ onClick, icon: Icon, label, collapsed }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center text-xs font-medium transition-colors duration-150 w-full",
        collapsed ? "justify-center w-10 h-10" : "gap-3 pl-4 pr-2 py-2.5"
      )}
      style={{ color: "hsla(var(--sidebar-foreground), 0.55)" }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--phosphor)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "hsla(var(--sidebar-foreground), 0.55)"; }}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className={cn("overflow-hidden whitespace-nowrap tracking-tight", collapsed ? "w-0 opacity-0" : "opacity-100")}>
        {label}
      </span>
    </button>
  );
}
