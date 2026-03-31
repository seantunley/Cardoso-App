import { Link } from "react-router-dom";
import {
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Search,
  Link2,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { hasPermission } from "@/lib/permissions";
import ChangePasswordModal from "@/components/users/ChangePasswordModal";
import SettingsPanel from "@/components/settings/SettingsPanel";

const APP_VERSION = "2026.1.2";

const navItems = [
  { name: "Customer Management", icon: Search,  page: "CustomerSearch", permission: "can_access_customer_search", siteOnly: true },
  { name: "Connections",         icon: Link2,   page: "Connections",    siteOnly: true },
  { name: "Customer Management", icon: Globe,   page: "HubDashboard",   hubOnly: true },
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
    if (item.hubOnly) return hubMode;
    if (item.siteOnly && hubMode) return false;
    if (item.adminOnly) return isAdmin;
    return hasPermission(currentUser, item.permission);
  };

  const visibleNavItems = navItems.filter(canShowNavItem);
  const canSeeSettings  = isAdmin
    || hasPermission(currentUser, "can_access_settings")
    || hasPermission(currentUser, "can_manage_users")
    || hasPermission(currentUser, "can_manage_rules");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className={cn(
        "fixed top-0 left-0 z-50 hidden h-full flex-col border-r bg-card lg:flex border-border transition-all duration-300",
        isCollapsed ? "w-16" : "w-56"
      )}>
        <div className="border-b border-border p-3">
          <div className={cn("flex items-center gap-3 mb-0", isCollapsed && "justify-center")}>
            <div className="rounded-lg shrink-0 overflow-hidden" style={{width:"32px",height:"32px"}}>
              <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32">
                <rect width="32" height="32" rx="6" fill="#c0392b"/>
                <rect x="2" y="2" width="28" height="28" rx="5" fill="#e74c3c"/>
                <rect x="0" y="11" width="32" height="4" fill="#f39c12"/>
                <rect x="0" y="11" width="32" height="1" fill="#e67e22"/>
                <rect x="0" y="14" width="32" height="1" fill="#e67e22"/>
                <rect x="5" y="16" width="22" height="3" rx="1.5" fill="#f5f5f0"/>
                <rect x="5" y="20" width="22" height="3" rx="1.5" fill="#f5f5f0"/>
                <rect x="24" y="16" width="3" height="3" rx="1" fill="#e8a87c"/>
                <rect x="24" y="20" width="3" height="3" rx="1" fill="#e8a87c"/>
                <rect x="4" y="4" width="24" height="6" rx="2" fill="#c0392b"/>
                <text x="16" y="9.5" textAnchor="middle" fill="#ffd700" fontSize="5" fontWeight="bold" fontFamily="serif">CARDOSO</text>
              </svg>
            </div>
            {!isCollapsed && (
              <div className="min-w-0">
                <h1 className="font-semibold text-sm text-foreground leading-tight">Cardoso Cigarettes</h1>
                <p className="text-[11px] text-muted-foreground">Business System</p>
              </div>
            )}
          </div>
          {currentUser && !isCollapsed && (
            <div className="mt-2 rounded-lg bg-muted px-2.5 py-1.5">
              <p className="truncate text-xs font-medium text-foreground leading-tight">{currentUser.full_name || "User"}</p>
              <p className="truncate text-[11px] text-muted-foreground">{currentUser.email}</p>
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {visibleNavItems.map((item) => {
            const isActive = currentPageName === item.page;
            return (
              <Link
                key={item.page}
                to={`/${item.page}`}
                title={isCollapsed ? item.name : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  isCollapsed && "justify-center px-0"
                )}
              >
                <item.icon className="h-3.5 w-3.5 shrink-0" />
                {!isCollapsed && item.name}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-0.5 border-t border-border p-3">
          {canSeeSettings && (
            <Button variant="ghost" size={isCollapsed ? "icon" : "sm"}
              className={cn("w-full h-8", !isCollapsed && "justify-start")}
              onClick={() => setSettingsOpen(true)} title={isCollapsed ? "Settings" : undefined}>
              <Settings className="h-3.5 w-3.5 shrink-0" />
              {!isCollapsed && <span className="ml-1.5 text-xs">Settings</span>}
            </Button>
          )}

          <Button variant="ghost" size={isCollapsed ? "icon" : "sm"}
            className={cn("w-full h-8", !isCollapsed && "justify-start")}
            onClick={() => setChangePasswordOpen(true)} title={isCollapsed ? "Change Password" : undefined}>
            <KeyRound className="h-3.5 w-3.5 shrink-0" />
            {!isCollapsed && <span className="ml-1.5 text-xs">Change Password</span>}
          </Button>

          <Button variant="outline" size={isCollapsed ? "icon" : "sm"}
            className={cn("w-full h-8", !isCollapsed && "justify-start")}
            onClick={() => logout(true)} title={isCollapsed ? "Logout" : undefined}>
            <LogOut className="h-3.5 w-3.5 shrink-0" />
            {!isCollapsed && <span className="ml-1.5 text-xs">Logout</span>}
          </Button>

          <Button variant="ghost" size={isCollapsed ? "icon" : "sm"}
            className={cn("w-full h-8", !isCollapsed && "justify-start")}
            onClick={() => setIsCollapsed(!isCollapsed)} title={isCollapsed ? "Expand" : "Collapse"}>
            {isCollapsed
              ? <ChevronRight className="h-3.5 w-3.5" />
              : <><ChevronLeft className="h-3.5 w-3.5" /><span className="ml-1.5 text-xs">Collapse</span></>}
          </Button>

          {!isCollapsed && (
            <div className={cn(
              "mt-1 rounded-md border px-2 py-1 text-center text-[10px] transition-colors",
              versionStatus.updateAvailable
                ? "border-yellow-300 bg-yellow-100 text-yellow-900"
                : "border-transparent text-muted-foreground/50"
            )} title={versionStatus.updateAvailable ? `New: v${versionStatus.latestVersion}` : `v${versionStatus.currentVersion}`}>
              <p>v{versionStatus.currentVersion}</p>
              {versionStatus.updateAvailable && (
                <><p className="font-medium">Update available</p><p className="font-semibold">New: v{versionStatus.latestVersion}</p></>
              )}
            </div>
          )}
        </div>
      </aside>
      <header className="fixed left-0 right-0 top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
        <div className="flex items-center gap-2">
          <div className="rounded-lg overflow-hidden" style={{width:"28px",height:"28px"}}><svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="32" height="32" rx="6" fill="#e74c3c"/><rect x="0" y="11" width="32" height="4" fill="#f39c12"/><rect x="5" y="16" width="22" height="3" rx="1.5" fill="#f5f5f0"/><rect x="5" y="20" width="22" height="3" rx="1.5" fill="#f5f5f0"/><rect x="24" y="16" width="3" height="3" rx="1" fill="#e8a87c"/><rect x="24" y="20" width="3" height="3" rx="1" fill="#e8a87c"/><rect x="4" y="4" width="24" height="6" rx="2" fill="#c0392b"/><text x="16" y="9.5" textAnchor="middle" fill="#ffd700" fontSize="5" fontWeight="bold" fontFamily="serif">CARDOSO</text></svg></div>
          <span className="font-bold text-foreground">Cardoso</span>
        </div>
        {canSeeSettings && (
          <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}><Settings className="h-5 w-5" /></Button>
        )}
      </header>
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-border bg-card px-4 py-2 lg:hidden">
        {visibleNavItems.slice(0, 4).map((item) => {
          const isActive = currentPageName === item.page;
          return (
            <Link key={item.page} to={`/${item.page}`}
              className={cn("flex flex-col items-center gap-1 rounded-xl px-4 py-2 transition-all", isActive ? "text-foreground" : "text-muted-foreground")}>
              <item.icon className="h-5 w-5" />
              <span className="text-xs font-medium">{item.name}</span>
            </Link>
          );
        })}
      </nav>
      <main className={cn("bg-background pt-16 pb-20 transition-all duration-300 lg:pt-0 lg:pb-0", isCollapsed ? "lg:ml-16" : "lg:ml-56")}>
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
