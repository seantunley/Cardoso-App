import { Link } from "react-router-dom";
import {
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  ClipboardList,
} from "lucide-react";

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
import { BarChart2, PhoneCall, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { hasPermission } from "@/lib/permissions";
import ChangePasswordModal from "@/components/users/ChangePasswordModal";
import SettingsPanel from "@/components/settings/SettingsPanel";

const APP_VERSION = "2026.3.9";

const navItems = [
  { name: "Customer Management", icon: IconCustomerSearch,   page: "CustomerSearch",   permission: "can_access_customer_search", siteOnly: true },
  { name: "Customer Management", icon: IconHubDashboard,     page: "HubDashboard",     hubOnly: true },
  { name: "Customer Balances",   icon: IconCustomerBalances, page: "CustomerBalances", permission: "can_access_customer_balances" },
  { name: "Collections",         icon: PhoneCall,            page: "Collections",      permission: "can_access_collections", siteOnly: true },
  { name: "Inventory",           icon: IconInventory,        page: "Inventory",        permission: "can_access_inventory" },
  { name: "Site Metrics",        icon: BarChart2,            page: "HubMetrics",       permission: "can_access_hub_metrics", hubOnly: true },
  { name: "Site Backups",        icon: IconSiteBackups,      page: "HubBackups",       permission: "can_access_hub_backups", hubOnly: true },
  { name: "Trends",              icon: TrendingUp,           page: "HubTrends",        permission: "can_access_hub_trends", hubOnly: true },
  { name: "Hub Audit Log",       icon: ClipboardList,        page: "HubAuditLog",      permission: "can_access_hub_audit_log", hubOnly: true },
];

export default function Layout({ children, currentPageName }) {
  const [isCollapsed, setIsCollapsed]       = useState(true);
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
      .catch(() => {});
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
      .catch(() => {});
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
      <aside className={cn(
        "fixed top-0 left-0 z-50 hidden h-full flex-col border-r bg-card lg:flex border-border transition-all duration-200 ease-out",
        isCollapsed ? "w-14" : "w-56"
      )}>
        <div className={"border-b border-border px-3 pt-6 pb-3"}>
          <div className={cn("flex items-center mb-0 w-full", isCollapsed ? "justify-center" : "gap-3")}>
            <div className="rounded-lg shrink-0 overflow-hidden" style={{width:"32px",height:"32px"}}>
              <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32">
                <rect width="32" height="32" rx="7" fill="#1e293b"/>
                <rect x="4" y="13" width="24" height="15" rx="3" fill="url(#bc32)"/>
                <rect x="4" y="19" width="24" height="2" fill="#1d4ed8"/>
                <rect x="13" y="17" width="6" height="6" rx="1.5" fill="#bfdbfe"/>
                <path d="M11 13v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" fill="none"/>
                <defs><linearGradient id="bc32" x1="4" y1="13" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stopColor="#3b82f6"/><stop offset="1" stopColor="#6366f1"/></linearGradient></defs>
              </svg>
            </div>
            <div className={cn("min-w-0 overflow-hidden transition-all duration-200 ease-out", isCollapsed ? "w-0 opacity-0" : "w-full opacity-100")}>
                <h1 className="font-semibold text-base text-foreground leading-tight whitespace-nowrap">Cardoso Cigarettes</h1>
                <p className="text-xs text-muted-foreground whitespace-nowrap">Business System</p>
              </div>
          </div>
          {currentUser && (
            <div className={cn("mt-6 rounded-lg bg-muted px-2.5 py-1.5 overflow-hidden transition-all duration-200 ease-out", isCollapsed ? "max-h-0 opacity-0 mt-0 py-0 px-0" : "max-h-20 opacity-100")}>
              <p className="truncate text-xs font-medium text-foreground leading-tight">{currentUser.full_name || "User"}</p>
              <p className="truncate text-[11px] text-muted-foreground">{currentUser.email}</p>
            </div>
          )}
        </div>
        <nav className={cn("flex-1 space-y-1", isCollapsed ? "p-2 flex flex-col items-center" : "p-3")}>
          {visibleNavItems.map((item) => {
            const isActive = currentPageName === item.page;
            const showAttention = item.page === "HubBackups" && backupAttention;
            return (
              <Link
                key={item.page}
                to={`/${item.page}`}
                title={isCollapsed ? item.name : undefined}
                className={cn(
                  "relative flex items-center rounded-lg text-xs font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  isCollapsed
                    ? "justify-center w-8 h-8 mx-auto"
                    : "gap-2.5 px-3 py-2 w-full"
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {showAttention && (
                  <span className={cn(
                    "absolute inline-flex h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-card",
                    isCollapsed ? "top-1.5 right-1.5" : "top-2.5 right-2.5"
                  )} />
                )}
                <span className={cn("overflow-hidden whitespace-nowrap transition-all duration-200 ease-out", isCollapsed ? "w-0 opacity-0" : "opacity-100")}>{item.name}</span>
              </Link>
            );
          })}
        </nav>
        <div className={cn("border-t border-border", isCollapsed ? "p-2 flex flex-col items-center space-y-1" : "space-y-0.5 p-3")}>
          {canSeeSettings && (
            <button
              onClick={() => setSettingsOpen(true)} title={isCollapsed ? "Settings" : undefined}
              className={cn("flex items-center rounded-lg text-xs font-medium transition-all duration-200 text-muted-foreground hover:bg-muted hover:text-foreground", isCollapsed ? "justify-center w-8 h-8" : "gap-2.5 px-3 py-2 w-full")}>
              <Settings className="h-4 w-4 shrink-0" />
              <span className={cn("overflow-hidden whitespace-nowrap transition-all duration-200 ease-out", isCollapsed ? "w-0 opacity-0" : "opacity-100")}>Settings</span>
            </button>
          )}

          <button
            onClick={() => setChangePasswordOpen(true)} title={isCollapsed ? "Change Password" : undefined}
            className={cn("flex items-center rounded-lg text-xs font-medium transition-all duration-200 text-muted-foreground hover:bg-muted hover:text-foreground", isCollapsed ? "justify-center w-8 h-8" : "gap-2.5 px-3 py-2 w-full")}>
            <KeyRound className="h-4 w-4 shrink-0" />
            <span className={cn("overflow-hidden whitespace-nowrap transition-all duration-200 ease-out", isCollapsed ? "w-0 opacity-0" : "opacity-100")}>Change Password</span>
          </button>

          <button
            onClick={() => logout(true)} title={isCollapsed ? "Logout" : undefined}
            className={cn("flex items-center rounded-lg text-xs font-medium transition-all duration-200 text-muted-foreground hover:bg-muted hover:text-foreground", isCollapsed ? "justify-center w-8 h-8" : "gap-2.5 px-3 py-2 w-full")}>
            <LogOut className="h-4 w-4 shrink-0" />
            <span className={cn("overflow-hidden whitespace-nowrap transition-all duration-200 ease-out", isCollapsed ? "w-0 opacity-0" : "opacity-100")}>Logout</span>
          </button>

          <button
            onClick={() => setIsCollapsed(!isCollapsed)} title={isCollapsed ? "Expand" : "Collapse"}
            className={cn("flex items-center rounded-lg text-xs font-medium transition-all duration-200 text-muted-foreground hover:bg-muted hover:text-foreground", isCollapsed ? "justify-center w-8 h-8" : "gap-2.5 px-3 py-2 w-full")}>
            {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            <span className={cn("overflow-hidden whitespace-nowrap transition-all duration-200 ease-out", isCollapsed ? "w-0 opacity-0" : "opacity-100")}>Collapse</span>
          </button>

          <div className={cn("overflow-hidden transition-all duration-200 ease-out", isCollapsed ? "max-h-0 opacity-0" : "max-h-20 opacity-100")}>
            <div
              className={cn(
                "mt-1 rounded-md border px-2 py-1 text-center text-[10px] transition-colors",
                versionStatus.updateAvailable && isAdmin
                  ? "border-yellow-500/40 bg-yellow-500/15 text-yellow-300 cursor-pointer hover:bg-yellow-500/25"
                  : versionStatus.updateAvailable
                  ? "border-yellow-500/40 bg-yellow-500/15 text-yellow-300"
                  : "border-transparent text-muted-foreground/50"
              )}
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
              <p>v{versionStatus.currentVersion}</p>
              {versionStatus.updateAvailable && (
                updateInstalling
                  ? <p className="font-medium animate-pulse">Installing…</p>
                  : showUpdateConfirm
                  ? (
                    <div className="mt-1 space-y-1">
                      <p className="font-medium text-yellow-300">Install now?</p>
                      <div className="flex gap-1 justify-center">
                        <button
                          onClick={(e) => { e.stopPropagation(); confirmUpdate(); }}
                          className="px-2 py-0.5 rounded text-[10px] bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-200 font-semibold"
                        >Install</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowUpdateConfirm(false); }}
                          className="px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-muted/80 text-muted-foreground"
                        >Cancel</button>
                      </div>
                    </div>
                  )
                  : <><p className="font-medium">Update available</p><p className="font-semibold">v{versionStatus.latestVersion}{isAdmin ? " — click" : ""}</p></>
              )}
            </div>
            </div>
        </div>
      </aside>
      <header className="fixed left-0 right-0 top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
        <div className="flex items-center gap-2">
          <div className="rounded-lg overflow-hidden" style={{width:"28px",height:"28px"}}><svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="32" height="32" rx="7" fill="#1e293b"/><rect x="4" y="13" width="24" height="15" rx="3" fill="#3b82f6"/><rect x="4" y="13" width="24" height="15" rx="3" fill="url(#bg)"/><rect x="4" y="19" width="24" height="2" fill="#1d4ed8"/><rect x="13" y="17" width="6" height="6" rx="1" fill="#93c5fd"/><path d="M11 13v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round"/><defs><linearGradient id="bg" x1="4" y1="13" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stopColor="#3b82f6"/><stop offset="1" stopColor="#6366f1"/></linearGradient></defs></svg></div>
          <span className="font-bold text-foreground">Cardoso</span>
        </div>
        <div className="flex items-center gap-1">
          {canSeeSettings && (
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}><Settings className="h-5 w-5 text-amber-400" /></Button>
          )}
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
      <main className={cn("bg-background pt-16 pb-[calc(5rem+env(safe-area-inset-bottom))] transition-all duration-300 lg:pt-0 lg:pb-0", isCollapsed ? "lg:ml-16" : "lg:ml-56")}>
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
