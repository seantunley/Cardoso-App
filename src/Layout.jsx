import { Link } from "react-router-dom";
import {
  Settings,
  Users,
  LogOut,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Search,
  Link2,
  ShieldCheck,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { hasPermission } from "@/lib/permissions";
import ChangePasswordModal from "@/components/users/ChangePasswordModal";
import SettingsPanel from "@/components/settings/SettingsPanel";

const navItems = [
  // Site pages
  { name: "Customer Management", icon: Search, page: "CustomerSearch", permission: "can_access_customer_search", siteOnly: true },
  { name: "Connections", icon: Link2, page: "Connections", siteOnly: true },
  // Hub pages
  { name: "Customer Management", icon: Globe, page: "HubDashboard", hubOnly: true },
  // Shared
  { name: "Users", icon: Users, page: "Users", permission: "can_manage_users" },
];


export default function Layout({ children, currentPageName }) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [hubMode, setHubMode] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const { user: currentUser, logout } = useAuth();
  const isAdmin = currentUser?.role === "admin";

  useEffect(() => {
    fetch('/api/app-info')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.hub_mode) setHubMode(true); })
      .catch(() => {});
  }, []);



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

  // Settings gear: show if user has any settings-related permission or is admin
  const canSeeSettings = isAdmin || hasPermission(currentUser, "can_access_settings") || hasPermission(currentUser, "can_manage_users") || hasPermission(currentUser, "can_manage_rules");

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className={cn(
        "fixed top-0 left-0 z-50 hidden h-full flex-col border-r bg-card lg:flex",
        "border-border transition-all duration-300",
        isCollapsed ? "w-20" : "w-64"
      )}>
        {/* Branding */}
        <div className="border-b border-border p-6">
          <div className={cn("flex items-center gap-3", isCollapsed && "justify-center")}>
            <div className="rounded-xl bg-primary p-2 text-primary-foreground">
              <ShieldCheck className="h-5 w-5" />
            </div>
            {!isCollapsed && (
              <div>
                <h1 className="font-bold text-foreground">Cardoso Cigarettes</h1>
                <p className="text-xs text-muted-foreground">Business System</p>
              </div>
            )}
          </div>
        </div>

        {/* User info */}
        {currentUser && !isCollapsed && (
          <div className="border-b border-border p-4">
            <div className="rounded-lg bg-muted p-3">
              <p className="truncate text-sm font-medium text-foreground">{currentUser.full_name || "User"}</p>
              <p className="truncate text-xs text-muted-foreground">{currentUser.email}</p>
            </div>
          </div>
        )}

        {/* Main nav */}
        <nav className="flex-1 space-y-1 p-4">
          {visibleNavItems.map((item) => {
            const isActive = currentPageName === item.page;
            return (
              <Link
                key={item.page}
                to={`/${item.page}`}
                title={isCollapsed ? item.name : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  isCollapsed && "justify-center px-0"
                )}
              >
                <item.icon className="h-5 w-5" />
                {!isCollapsed && item.name}
              </Link>
            );
          })}
        </nav>

        {/* Bottom actions */}
        <div className="space-y-2 border-t border-border p-4">
          {/* Settings gear */}
          {canSeeSettings && (
            <Button
              variant="ghost"
              size={isCollapsed ? "icon" : "default"}
              className={cn("w-full", !isCollapsed && "justify-start")}
              onClick={() => setSettingsOpen(true)}
              title={isCollapsed ? "Settings" : undefined}
            >
              <Settings className="h-4 w-4" />
              {!isCollapsed && <span className="ml-2">Settings</span>}
            </Button>
          )}

          <Button
            variant="ghost"
            size={isCollapsed ? "icon" : "default"}
            className={cn("w-full", !isCollapsed && "justify-start")}
            onClick={() => setChangePasswordOpen(true)}
            title={isCollapsed ? "Change Password" : undefined}
          >
            <KeyRound className="h-4 w-4" />
            {!isCollapsed && <span className="ml-2">Change Password</span>}
          </Button>

          <Button
            variant="outline"
            size={isCollapsed ? "icon" : "default"}
            className={cn("w-full", !isCollapsed && "justify-start")}
            onClick={() => logout(true)}
            title={isCollapsed ? "Logout" : undefined}
          >
            <LogOut className="h-4 w-4" />
            {!isCollapsed && <span className="ml-2">Logout</span>}
          </Button>

          <Button
            variant="ghost"
            size={isCollapsed ? "icon" : "default"}
            className={cn("w-full", !isCollapsed && "justify-start")}
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? <ChevronRight className="h-4 w-4" /> : (<><ChevronLeft className="h-4 w-4" /><span className="ml-2">Collapse</span></>)}
          </Button>

        </div>
      </aside>

      {/* Mobile header */}
      <header className="fixed left-0 right-0 top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-primary p-1.5 text-primary-foreground"><ShieldCheck className="h-4 w-4" /></div>
          <span className="font-bold text-foreground">Cardoso</span>
        </div>
        {canSeeSettings && (
          <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}><Settings className="h-5 w-5" /></Button>
        )}
      </header>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-border bg-card px-4 py-2 lg:hidden">
        {visibleNavItems.slice(0, 4).map((item) => {
          const isActive = currentPageName === item.page;
          return (
            <Link key={item.page} to={`/${item.page}`} className={cn("flex flex-col items-center gap-1 rounded-xl px-4 py-2 transition-all", isActive ? "text-foreground" : "text-muted-foreground")}>
              <item.icon className="h-5 w-5" />
              <span className="text-xs font-medium">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* Main content */}
      <main className={cn("bg-background pt-16 pb-20 transition-all duration-300 lg:pt-0 lg:pb-0", isCollapsed ? "lg:ml-20" : "lg:ml-64")}>
        {children}
      </main>

      {/* Modals */}
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
