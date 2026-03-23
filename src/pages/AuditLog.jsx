import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import AuditLogTable from "../components/audit/AuditLogTable";
import { Card, CardContent } from "@/components/ui/card";
import { Shield } from "lucide-react";

async function fetchAuditLogs() {
  const response = await fetch("/api/auditlog", {
    method: "GET",
    credentials: "include",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to fetch audit logs");
  }

  return Array.isArray(result)
    ? [...result].sort(
        (a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime()
      )
    : [];
}

export default function AuditLog() {
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    const fetchCurrentUser = async () => {
      try {
        const user = await base44.auth.me();
        setCurrentUser(user);
      } catch (error) {
        console.error("Failed to fetch current user:", error);
      }
    };

    fetchCurrentUser();
  }, []);

  const {
    data: logs = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["auditLogs"],
    queryFn: fetchAuditLogs,
    enabled: !!currentUser?.role,
  });

  const isAdmin = currentUser?.role === "admin";

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gray-950">
        <div className="mx-auto max-w-4xl p-6 lg:p-8">
          <Card className="border-rose-700 bg-rose-900/20">
            <CardContent className="p-8 text-center">
              <Shield className="mx-auto mb-4 h-12 w-12 text-rose-400" />
              <h2 className="mb-2 text-xl font-semibold text-rose-300">Access Denied</h2>
              <p className="text-rose-400">
                Only administrators can view the audit log.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Audit Log</h1>
          <p className="mt-2 text-gray-400">
            Track all significant actions performed within the app
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-800" />
            ))}
          </div>
        ) : error ? (
          <Card className="border-rose-700 bg-rose-900/20">
            <CardContent className="p-6">
              <p className="text-rose-300">
                {error.message || "Failed to load audit log"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <AuditLogTable logs={logs} />
        )}
      </div>
    </div>
  );
}