import { useState, useEffect, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClientInstance } from "@/lib/query-client";
import NavigationTracker from "@/lib/NavigationTracker";
import { pagesConfig } from "./pages.config";
import { BrowserRouter as Router, Route, Routes, Navigate, useLocation } from "react-router-dom";
import PageNotFound from "./lib/PageNotFound";
import { useAuth } from "@/lib/AuthContext";
import UserNotRegisteredError from "@/components/UserNotRegisteredError";
import Login from "@/pages/Login";
import ForcePasswordChangeModal from "@/components/auth/ForcePasswordChangeModal";
import ProtectedRoute from "@/components/auth/ProtectedAuth";
const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : () => <></>;
const HubDashboard = Pages["HubDashboard"];
const pagePermissions = {
  CustomerSearch: "can_access_customer_search",
  CustomerBalances: "can_access_customer_balances",
  Collections: "can_access_collections",
  Inventory: "can_access_inventory",
  NetworkDevices: "can_access_network_devices",
  HubMetrics: "can_access_hub_metrics",
  HubBackups: "can_access_hub_backups",
  HubTrends: "can_access_hub_trends",
  HubAuditLog: "can_access_hub_audit_log",
  Records: "can_access_records",
  Reports: "can_access_reports",
  Connections: "can_access_connections",
};

const LayoutWrapper = ({ children, currentPageName }) =>
  Layout ? (
    <Layout currentPageName={currentPageName}>{children}</Layout>
  ) : (
    <div className="min-h-screen bg-background text-foreground">
      {children}
    </div>
  );

const ProtectedPage = ({ children, currentPageName }) => {
  const { isAuthenticated, isLoadingAuth, isLoadingPublicSettings } = useAuth();
  const location = useLocation();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background text-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <LayoutWrapper currentPageName={currentPageName}>{children}</LayoutWrapper>;
};

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, isAuthenticated, forcePasswordChange, completePasswordChange } = useAuth();
  const [hubMode, setHubMode] = useState(false);
  useEffect(() => {
    fetch("/api/app-info", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.hub_mode) setHubMode(true); })
      .catch(() => {});
  }, [isAuthenticated]);

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background text-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground"></div>
      </div>
    );
  }

  if (authError?.type === "user_not_registered") {
    return <UserNotRegisteredError />;
  }

  return (
    <Suspense fallback={<div className="fixed inset-0 flex items-center justify-center bg-background"><div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground"></div></div>}>
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <Login />}
      />

      <Route
        path="/"
        element={
          <ProtectedPage currentPageName={hubMode ? "HubDashboard" : mainPageKey}>
            <ProtectedRoute permission={hubMode ? undefined : pagePermissions[mainPageKey]}>
              {hubMode ? <HubDashboard /> : <MainPage />}
            </ProtectedRoute>
          </ProtectedPage>
        }
      />

      {Object.entries(Pages).map(([path, Page]) => (
        <Route
          key={path}
          path={`/${path}`}
          element={
            <ProtectedPage currentPageName={path}>
              <ProtectedRoute permission={pagePermissions[path]}>
                <Page />
              </ProtectedRoute>
            </ProtectedPage>
          }
        />
      ))}

      <Route path="*" element={<PageNotFound />} />
    </Routes>
    {forcePasswordChange && (
      <ForcePasswordChangeModal open={forcePasswordChange} onComplete={completePasswordChange} />
    )}
    </Suspense>
  );
};

function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <NavigationTracker />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </div>
  );
}

export default App;
