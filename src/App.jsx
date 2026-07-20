import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { useHubMode } from "@/lib/useAppInfo";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClientInstance } from "@/lib/query-client";
import NavigationTracker from "@/lib/NavigationTracker";
import { pagesConfig } from "./pages.config";
import { BrowserRouter as Router, Route, Routes, Navigate, Outlet, useLocation } from "react-router-dom";
import PageNotFound from "./lib/PageNotFound";
import { useAuth } from "@/lib/AuthContext";
import { hasPermission } from "@/lib/permissions";
import UserNotRegisteredError from "@/components/UserNotRegisteredError";
import Login from "@/pages/Login";
import ForcePasswordChangeModal from "@/components/auth/ForcePasswordChangeModal";
import SessionExpiryWatcher from "@/components/SessionExpiryWatcher";
import ProtectedRoute from "@/components/auth/ProtectedAuth";
import CardosoEasterEgg from "@/components/easter/CardosoEasterEgg";
import { ConfirmProvider } from "@/components/shared/ConfirmProvider";
const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : () => <></>;
const HubDashboard = Pages["HubDashboard"];
// The printable manual is deliberately NOT a pages.config page: it renders
// OUTSIDE the sidebar layout (its own top-level route below) so the printout
// has no app chrome. Lazy so its bundle only loads when someone opens it.
const Manual = lazy(() => import("./pages/Manual"));
const pagePermissions = {
  CustomerSearch: "can_access_customer_search",
  CustomerBalances: "can_access_customer_balances",
  Collections: "can_access_collections",
  Inventory: "can_access_inventory",
  InventoryMovement: "can_access_inventory_movement",
  PriceList: "can_access_price_list",
  HubMetrics: "can_access_hub_metrics",
  HubBackups: "can_access_hub_backups",
  HubTrends: "can_access_hub_trends",
  Records: "can_access_records",
  Reconciliation: "can_access_reconciliation",
  Reports: "can_access_reports",
  ReportingDashboard: "can_access_reports",
  Insights: "can_access_reports",
  Connections: "can_access_connections",
  Jti: "can_access_jti",
  HubJti: "can_access_jti",
  StockReceipts: "can_access_stock_receipt_expiry",
};

const LayoutWrapper = ({ children, currentPageName }) =>
  Layout ? (
    <Layout currentPageName={currentPageName}>{children}</Layout>
  ) : (
    <div className="min-h-screen bg-background text-foreground">
      {children}
    </div>
  );

function getCurrentPageName(pathname, hubMode) {
  if (pathname === "/" || pathname === "") {
    return hubMode ? "HubDashboard" : mainPageKey;
  }

  const pathSegment = pathname.replace(/^\//, "").split("/")[0];
  return Object.keys(Pages).find((key) => key.toLowerCase() === pathSegment.toLowerCase()) || mainPageKey;
}

const ProtectedPage = ({ children }) => {
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

  return children;
};

const ProtectedLayoutRoute = ({ hubMode }) => {
  const location = useLocation();
  const currentPageName = getCurrentPageName(location.pathname, hubMode);

  return (
    <ProtectedPage>
      <LayoutWrapper currentPageName={currentPageName}>
        {/* Suspense INSIDE the layout: navigating to a lazy page whose chunk
            isn't loaded yet swaps only the content pane for a spinner. With
            the boundary only outside the route tree (the previous setup), the
            ENTIRE shell — sidebar included — unmounted to a full-screen
            fallback on every first visit to a page, which read as the app
            blanking out between clicks. */}
        <Suspense
          fallback={
            <div className="flex min-h-[60vh] items-center justify-center">
              <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-border border-t-[var(--phosphor)]" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </LayoutWrapper>
    </ProtectedPage>
  );
};

// Resolves the user's landing page on `/`. If they have access to the
// configured mainPage (or are in hubMode), render its children. Otherwise
// redirect to the first page in pagePermissions they DO have access to —
// stops users with limited permissions (e.g. "BAT only") landing on a
// dead-end "Access denied" wall just because their default page is one
// they can't open.
//
// Order matters: pagePermissions is iterated in insertion order, so the
// fall-back follows the same priority as the sidebar nav. Settings /
// admin-only routes aren't in the map, so they're never auto-targeted.
const RootRedirect = ({ children, hubMode }) => {
  const { user, isAuthenticated, isLoadingAuth } = useAuth();
  if (isLoadingAuth || !isAuthenticated) return children;
  // Hub mode opens HubDashboard for everyone — no redirect needed.
  if (hubMode) return children;
  const mainPerm = pagePermissions[mainPageKey];
  if (!mainPerm || hasPermission(user, mainPerm)) return children;
  // User has no access to the default page. Find the first allowed one.
  for (const [path, perm] of Object.entries(pagePermissions)) {
    if (hasPermission(user, perm)) {
      return <Navigate to={`/${path}`} replace />;
    }
  }
  // No accessible pages at all — fall through to the existing
  // "Access denied" state on the configured main page so the user sees
  // SOMETHING rather than a blank screen.
  return children;
};

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, isAuthenticated, forcePasswordChange, completePasswordChange } = useAuth();
  const hubMode = useHubMode();
  // `isAuthenticated` referenced only for the previous effect; re-flow
  // when auth changes is now handled by React Query staleTime + auth gate.
  void isAuthenticated;

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

      <Route element={<ProtectedLayoutRoute hubMode={hubMode} />}>
        <Route
          path="/"
          element={
            <RootRedirect hubMode={hubMode}>
              {hubMode ? <HubDashboard /> : <MainPage />}
            </RootRedirect>
          }
        />

        {Object.entries(Pages).map(([path, Page]) => (
          <Route
            key={path}
            path={`/${path}`}
            element={
              <ProtectedRoute permission={pagePermissions[path]}>
                <Page />
              </ProtectedRoute>
            }
          />
        ))}
      </Route>

      {/* Printable manual — outside the layout route so it renders with no
          sidebar/chrome (clean print/PDF). Auth-gated but permission-open,
          same as the in-app Help centre. */}
      <Route
        path="/manual"
        element={
          <ProtectedRoute>
            <Manual />
          </ProtectedRoute>
        }
      />

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
        <ConfirmProvider>
          <Router>
            <NavigationTracker />
            <SessionExpiryWatcher />
            <AuthenticatedApp />
            <CardosoEasterEgg />
          </Router>
        </ConfirmProvider>
        <Toaster />
        <SonnerToaster richColors position="top-right" duration={5000} closeButton />
      </QueryClientProvider>
    </div>
  );
}

export default App;
