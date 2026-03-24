import { Link } from "react-router-dom";
import {
  LayoutDashboard,
  FileText,
  Settings,
  Database,
  Users,
  LogOut,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Search,
  BarChart2,
  ScrollText,
  Link2,
  Columns,
  ShieldCheck,
  ClipboardList,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { hasPermission } from "@/lib/permissions";
import ChangePasswordModal from "@/components/users/ChangePasswordModal";

const navItems = [
  { name: "Customer Search", icon: Search, page: "CustomerSearch", permission: "can_access_customer_search" },
  { name: "Reports", icon: BarChart2, page: "Reports", permission: "can_access_reports" },
  { name: "Records", icon: ScrollText, page: "Records", permission: "can_access_records" },
  { name: "Connections", icon: Link2, page: "Connections" },
  { name: "Fields", icon: Columns, page: "Fields", permission: "can_access_settings" },
  { name: "Settings", icon: Settings, page: "Settings", permission: "can_access_settings" },
  { name: "Users", icon: Users, page: "Users", permission: "can_manage_users" },
  { name: "Audit Log", icon: ClipboardList, page: "AuditLog", adminOnly: true },
];

export default function Layout({ children, currentPageName }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const { user: currentUser, logout } = useAuth();

  const isAdmin = currentUser?.role === "admin";

  const handleChangePassword = async (userId, newPassword) => {
    setIsSavingPassword(true);
    try {
      const res = await fetch(`/api/users/${userId}/password`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update password");
      }
      setChangePasswordOpen(false);
    } catch (err) {
      alert(err.message);
    } finally {
      setIsSavingPassword(false);
    }
  };

  const canShowNavItem = (item) => {
    if (!currentUser) return false;
    if (item.adminOnly) return isAdmin;
    // Use the shared hasPermission util which correctly handles falsy keys
    return hasPermission(currentUser, item.permission);
  };

  const visibleNavItems = navItems.filter(canShowNavItem);

  const handleLogout = async () => {
    await logout(true);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 hidden h-full flex-col border-r bg-card lg:flex",
          "border-border transition-all duration-300",
          isCollapsed ? "w-20" : "w-64"
        )}
      >
        <div className="border-b border-border p-6">
          <div className={cn("flex items-center gap-3", isCollapsed && "justify-center")}>
            <div className="rounded-xl bg-primary p-2 text-primary-foreground">
              <ShieldCheck className="h-5 w-5" />
            </div>
            {!isCollapsed && (
              <div>
                <h1 className="font-bold text-foreground">Cardoso Cigarettes</h1>
                <p className="text-xs text-muted-foreground">Customer Manager</p>
              </div>
            )}
          </div>
        </div>

        {currentUser && !isCollapsed && (
          <div className="border-b border-border p-4">
            <div className="rounded-lg bg-muted p-3">
              <p className="truncate text-sm font-medium text-foreground">
                {currentUser.full_name || "User"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {currentUser.email}
              </p>
            </div>
          </div>
        )}

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

        <div className="space-y-2 border-t border-border p-4">
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
            onClick={handleLogout}
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
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4" />
                <span className="ml-2">Collapse</span>
              </>
            )}
          </Button>

          {!isCollapsed && (
            <p className="text-center text-[10px] text-muted-foreground/50 pt-1">v2026.1.0</p>
          )}
        </div>
      </aside>

      <header className="fixed left-0 right-0 top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-primary p-1.5 text-primary-foreground">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <span className="font-bold text-foreground">Cardoso</span>
        </div>
      </header>

      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-border bg-card px-4 py-2 lg:hidden">
        {visibleNavItems.slice(0, 4).map((item) => {
          const isActive = currentPageName === item.page;
          return (
            <Link
              key={item.page}
              to={`/${item.page}`}
              className={cn(
                "flex flex-col items-center gap-1 rounded-xl px-4 py-2 transition-all",
                isActive ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-xs font-medium">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <main
        className={cn(
          "bg-background pt-16 pb-20 transition-all duration-300 lg:pt-0 lg:pb-0",
          isCollapsed ? "lg:ml-20" : "lg:ml-64"
        )}
      >
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
    </div>
  );
}