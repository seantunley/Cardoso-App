import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import AuditLogTable from "../components/audit/AuditLogTable";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, LogIn } from "lucide-react";

async function fetchAuditLogs() {
  const response = await fetch("/api/auditlog", {
    method: "GET",
    credentials: "include",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to fetch audit logs");
  return Array.isArray(result)
    ? [...result].sort((a, b) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime())
    : [];
}

async function fetchLoginLogs() {
  const response = await fetch("/api/login-logs", {
    method: "GET",
    credentials: "include",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Failed to fetch login logs");
  return Array.isArray(result) ? result : [];
}

function formatDateTime(raw) {
  if (!raw) return "—";
  const d = new Date(raw.endsWith("Z") ? raw : raw + "Z");
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function AuditLog() {
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    const fetchCurrentUser = async () => {
      try {
        const user = await api.auth.me();
        setCurrentUser(user);
      } catch (error) {
        console.error("Failed to fetch current user:", error);
      }
    };
    fetchCurrentUser();
  }, []);

  const {
    data: logs = [],
    isLoading: logsLoading,
    error: logsError,
  } = useQuery({
    queryKey: ["auditLogs"],
    queryFn: fetchAuditLogs,
    enabled: !!currentUser?.role,
  });

  const {
    data: loginLogs = [],
    isLoading: loginLogsLoading,
    error: loginLogsError,
  } = useQuery({
    queryKey: ["loginLogs"],
    queryFn: fetchLoginLogs,
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
              <p className="text-rose-400">Only administrators can view the audit log.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="mx-auto max-w-7xl space-y-10 p-6 lg:p-8">

        {/* ── Section 1: Activity Audit Log ── */}
        <div className="space-y-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Audit Log</h1>
            <p className="mt-2 text-gray-400">
              Track all significant actions performed within the app
            </p>
          </div>

          {logsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-gray-800" />
              ))}
            </div>
          ) : logsError ? (
            <Card className="border-rose-700 bg-rose-900/20">
              <CardContent className="p-6">
                <p className="text-rose-300">{logsError.message || "Failed to load audit log"}</p>
              </CardContent>
            </Card>
          ) : (
            <AuditLogTable logs={logs} />
          )}
        </div>

        {/* ── Section 2: User Login Logs ── */}
        <div className="space-y-4 border-t border-gray-800 pt-8">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-gray-800 p-2">
              <LogIn className="h-5 w-5 text-gray-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">User Login Logs</h2>
              <p className="text-sm text-gray-400">Last 500 successful logins</p>
            </div>
          </div>

          {loginLogsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-800" />
              ))}
            </div>
          ) : loginLogsError ? (
            <Card className="border-rose-700 bg-rose-900/20">
              <CardContent className="p-6">
                <p className="text-rose-300">{loginLogsError.message || "Failed to load login logs"}</p>
              </CardContent>
            </Card>
          ) : loginLogs.length === 0 ? (
            <Card className="border-gray-700 bg-gray-900">
              <CardContent className="p-6 text-center">
                <p className="text-sm text-gray-500">No login records yet.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-700">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                      Username
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                      Full Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                      IP Address
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
                      Logged In At
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800 bg-gray-900">
                  {loginLogs.map((entry) => (
                    <tr key={entry.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-white">{entry.user_email}</td>
                      <td className="px-4 py-3 text-gray-400">{entry.user_name || "—"}</td>
                      <td className="px-4 py-3 text-gray-400 font-mono text-xs">{entry.ip_address || "—"}</td>
                      <td className="px-4 py-3 text-gray-400">{formatDateTime(entry.logged_in_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
