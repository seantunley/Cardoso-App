import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { Loader2 } from "lucide-react";

export default function ProtectedRoute({ children, permission }) {
  const location = useLocation();
  const { user, isAuthenticated, isLoadingAuth } = useAuth();

  if (isLoadingAuth) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="flex items-center gap-3 text-[var(--text-primary)]">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (permission && user?.role !== "admin" && !user?.[permission]) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
            Access denied
          </h1>
          <p className="mt-2 text-[var(--text-secondary)]">
            You do not have permission to view this page.
          </p>
        </div>
      </div>
    );
  }

  return children;
}