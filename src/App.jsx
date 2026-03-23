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

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : () => <></>;

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
  const { isLoadingAuth, isLoadingPublicSettings, authError, isAuthenticated } = useAuth();

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
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <Login />}
      />

      <Route
        path="/"
        element={
          <ProtectedPage currentPageName={mainPageKey}>
            <MainPage />
          </ProtectedPage>
        }
      />

      {Object.entries(Pages).map(([path, Page]) => (
        <Route
          key={path}
          path={`/${path}`}
          element={
            <ProtectedPage currentPageName={path}>
              <Page />
            </ProtectedPage>
          }
        />
      ))}

      <Route path="*" element={<PageNotFound />} />
    </Routes>
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