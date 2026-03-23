import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Database, Flag, CheckCircle, XCircle, Shield, RefreshCw } from "lucide-react";
import CustomerLookup from "../components/customer/CustomerLookup";
import StatCard from "../components/dashboard/StatCard";
import FlaggedCustomersModal from "../components/customer/FlaggedCustomersModal";
import ActivityLogModal from "../components/customer/ActivityLogModal";
import { Button } from "@/components/ui/button";
import { History } from "lucide-react";

export default function CustomerSearch() {
  const queryClient = useQueryClient();
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [selectedFlagColor, setSelectedFlagColor] = useState(null);
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [customerNumberToLookup, setCustomerNumberToLookup] = useState("");

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
  });

  const [selectedConnectionId, setSelectedConnectionId] = useState(null);

  const { data: connections = [] } = useQuery({
    queryKey: ["connections", currentUser?.email],
    queryFn: async () => {
      if (!currentUser) return [];
      const allConnections = await base44.entities.DatabaseConnection.list();
      return allConnections;
    },
    enabled: !!currentUser,
  });

  // Auto-select first active connection if none selected
  useEffect(() => {
    if (connections.length > 0 && !selectedConnectionId) {
      const activeConnection = connections.find(c => c.status === "active");
      setSelectedConnectionId(activeConnection?.id || connections[0]?.id || null);
    }
  }, [connections, selectedConnectionId]);

  const { data: records = [] } = useQuery({
    queryKey: ["records"],
    queryFn: () => base44.entities.DataRecord.list("-created_date", 1000),
  });

  useEffect(() => {
    const unsubscribe = base44.entities.DataRecord.subscribe((event) => {
      if (["create", "update"].includes(event.type)) {
        queryClient.invalidateQueries({ queryKey: ["records"] });
      }
    });
    return unsubscribe;
  }, [queryClient]);

  const activeConnections = connections.filter(c => c.status === "active");
  const selectedConnection = connections.find(c => c.id === selectedConnectionId);
  
  // Calculate flag stats
  const redFlagged = records.filter((r) => r.flag_color === "red");
  const greenFlagged = records.filter((r) => r.flag_color === "green");
  const orangeFlagged = records.filter((r) => r.flag_color === "orange");

  const handleFlagClick = (flagColor) => {
    setSelectedFlagColor(flagColor);
    setFlagModalOpen(true);
  };

  const handleCustomerClickFromModal = (customer) => {
    const customerNumber = customer.customer_number || customer.data?.customer_number;
    setCustomerNumberToLookup(customerNumber);
    setFlagModalOpen(false);
  };

  const getFlaggedCustomers = () => {
    if (selectedFlagColor === "red") return redFlagged;
    if (selectedFlagColor === "green") return greenFlagged;
    if (selectedFlagColor === "orange") return orangeFlagged;
    return [];
  };

  return (
     <div className="min-h-screen bg-[var(--bg-primary)]">
       <div className="max-w-4xl mx-auto p-4 lg:p-6 space-y-4">
         {/* Header */}
         <div className="flex items-start justify-between gap-4">
           <div>
             <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">
               Customer Search
             </h1>
             <p className="text-sm text-[var(--text-secondary)] mt-1">
               Look up customers by number from your SQL database
             </p>
           </div>
           {currentUser?.role === "admin" && (
             <Button
               onClick={() => setActivityLogOpen(true)}
               variant="outline"
               size="sm"
               className="flex items-center gap-2 bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
             >
              <History className="w-4 h-4" />
              Activity Log
            </Button>
          )}
        </div>

            {/* Flag Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Red */}
              <div
                onClick={() => handleFlagClick("red")}
                className="group relative overflow-hidden rounded-xl border border-rose-500/20 bg-gradient-to-br from-rose-950/60 via-slate-900/80 to-slate-900/60 p-4 cursor-pointer transition-all duration-200 hover:border-rose-500/50 hover:shadow-lg hover:shadow-rose-900/30 hover:-translate-y-0.5"
              >
                <div className="absolute inset-0 bg-rose-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-[10px] font-semibold text-rose-400/70 uppercase tracking-widest mb-2">Critical</p>
                    <p className="text-3xl font-extrabold text-white leading-none">{redFlagged.length}</p>
                    <p className="text-xs text-rose-300/60 mt-1.5">Red Flagged</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-rose-500/15 border border-rose-500/20">
                    <Flag className="w-4 h-4 text-rose-400" />
                  </div>
                </div>
                <div className="mt-3 h-0.5 rounded-full bg-rose-500/20">
                  <div className="h-full rounded-full bg-rose-500/60" style={{ width: redFlagged.length > 0 ? "100%" : "0%" }} />
                </div>
              </div>

              {/* Orange */}
              <div
                onClick={() => handleFlagClick("orange")}
                className="group relative overflow-hidden rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-950/60 via-slate-900/80 to-slate-900/60 p-4 cursor-pointer transition-all duration-200 hover:border-amber-500/50 hover:shadow-lg hover:shadow-amber-900/30 hover:-translate-y-0.5"
              >
                <div className="absolute inset-0 bg-amber-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-[10px] font-semibold text-amber-400/70 uppercase tracking-widest mb-2">Attention</p>
                    <p className="text-3xl font-extrabold text-white leading-none">{orangeFlagged.length}</p>
                    <p className="text-xs text-amber-300/60 mt-1.5">Orange Flagged</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-amber-500/15 border border-amber-500/20">
                    <AlertCircle className="w-4 h-4 text-amber-400" />
                  </div>
                </div>
                <div className="mt-3 h-0.5 rounded-full bg-amber-500/20">
                  <div className="h-full rounded-full bg-amber-500/60" style={{ width: orangeFlagged.length > 0 ? "100%" : "0%" }} />
                </div>
              </div>

              {/* Green */}
              <div
                onClick={() => handleFlagClick("green")}
                className="group relative overflow-hidden rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/60 via-slate-900/80 to-slate-900/60 p-4 cursor-pointer transition-all duration-200 hover:border-emerald-500/50 hover:shadow-lg hover:shadow-emerald-900/30 hover:-translate-y-0.5"
              >
                <div className="absolute inset-0 bg-emerald-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-[10px] font-semibold text-emerald-400/70 uppercase tracking-widest mb-2">Approved</p>
                    <p className="text-3xl font-extrabold text-white leading-none">{greenFlagged.length}</p>
                    <p className="text-xs text-emerald-300/60 mt-1.5">Green Flagged</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/20">
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                  </div>
                </div>
                <div className="mt-3 h-0.5 rounded-full bg-emerald-500/20">
                  <div className="h-full rounded-full bg-emerald-500/60" style={{ width: greenFlagged.length > 0 ? "100%" : "0%" }} />
                </div>
              </div>
            </div>

            {/* Flagged Customers Modal */}
            <FlaggedCustomersModal
              flagColor={selectedFlagColor}
              customers={getFlaggedCustomers()}
              open={flagModalOpen}
              onClose={() => setFlagModalOpen(false)}
              onCustomerClick={handleCustomerClickFromModal}
            />

            {/* Activity Log Modal */}
            <ActivityLogModal
              open={activityLogOpen}
              onClose={() => setActivityLogOpen(false)}
            />

        {/* Connection Selector */}
        {connections.length > 1 && (
          <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <CardContent className="p-4">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Select Database Connection</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {connections.map((conn) => (
                    <button
                      key={conn.id}
                      onClick={() => setSelectedConnectionId(conn.id)}
                      className={`p-2.5 rounded-lg border-2 transition-all text-left ${
                        selectedConnectionId === conn.id
                          ? "border-[var(--text-primary)] bg-[var(--text-primary)]/10 ring-1 ring-[var(--text-primary)]/20"
                          : "border-[var(--border-color)] hover:border-[var(--border-color)]/70 hover:bg-[var(--bg-tertiary)]/50"
                      }`}
                    >
                      <p className="font-medium text-[var(--text-primary)] text-xs">{conn.name}</p>
                      <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">{conn.database_name}</p>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${
                          conn.status === "active" ? "bg-green-500" : 
                          conn.status === "error" ? "bg-red-500" : 
                          "bg-gray-500"
                        }`} />
                        <span className="text-[10px] text-gray-400 capitalize">{conn.status}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Customer Lookup + Last Sync side by side */}
        <div className="flex gap-3 items-stretch">
          {/* Customer Lookup */}
          <div className="flex-1 ring-1 ring-white/20 rounded-xl shadow-lg shadow-white/10 min-w-0">
            <CustomerLookup 
              onRecordSelect={setSelectedRecord} 
              triggerLookup={customerNumberToLookup}
              onLookupComplete={() => setCustomerNumberToLookup("")}
              selectedConnection={selectedConnection}
            />
          </div>

          {/* Last Sync Info */}
          {selectedConnection && (
            <div className="flex-shrink-0 w-52 rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-950/60 to-slate-900/80 shadow-lg shadow-indigo-900/20 flex flex-col justify-center px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="p-1.5 rounded-md bg-indigo-500/20">
                  <RefreshCw className="w-3 h-3 text-indigo-400" />
                </div>
                <p className="text-[10px] font-semibold text-indigo-300 uppercase tracking-widest">Last Sync</p>
              </div>
              {selectedConnection.last_sync ? (
                <>
                  <p className="text-sm font-bold text-white leading-tight">
                    {new Date(selectedConnection.last_sync + (selectedConnection.last_sync.endsWith("Z") ? "" : "Z")).toLocaleString("en-ZA", {
                      timeZone: "Africa/Johannesburg",
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                  <p className="text-lg font-extrabold text-indigo-300 leading-tight">
                    {new Date(selectedConnection.last_sync + (selectedConnection.last_sync.endsWith("Z") ? "" : "Z")).toLocaleString("en-ZA", {
                      timeZone: "Africa/Johannesburg",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </p>
                  <p className="text-[10px] text-indigo-400/70 mt-1">{selectedConnection.name}</p>
                </>
              ) : (
                <p className="text-sm text-indigo-300/50">Never synced</p>
              )}
            </div>
          )}
        </div>

        {/* Info */}
        <Card className="border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">How it works</h3>
            <ul className="text-xs text-[var(--text-secondary)] space-y-1.5">
              <li className="flex items-start gap-1.5">
                <span className="text-[var(--text-tertiary)]">•</span>
                <span>Enter a customer number to search the SQL database</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-gray-500">•</span>
                <span>View customer name and age analysis information</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-gray-500">•</span>
                <span>Flag customers with <span className="font-medium text-red-400">Red</span>, <span className="font-medium text-green-400">Green</span>, or <span className="font-medium text-orange-400">Orange</span> tags</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-gray-500">•</span>
                <span className="text-[10px] text-gray-400">Note: For live SQL connections, enable Backend Functions in your app settings and configure a SQL connector backend function</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* Security Notice */}
        <Card className="border-emerald-700 bg-emerald-900/20">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <div className="p-1.5 bg-emerald-900/30 rounded-lg">
                <Shield className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div>
                <h3 className="font-semibold text-emerald-400 text-xs mb-1">Data Security & Privacy</h3>
                <ul className="text-[10px] text-emerald-300/80 space-y-0.5">
                  <li>• All database passwords are encrypted and stored securely</li>
                  <li>• Your data is isolated - each branch only sees their own records</li>
                  <li>• Imported data is used solely for this application and not shared</li>
                  <li>• Row-level security ensures data privacy between users</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Connection Status Banner */}
        {activeConnections.length === 0 && (
          <Card className="border-amber-700 bg-amber-900/20">
            <CardContent className="p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-amber-400">No Active SQL Connections</h3>
                  <p className="text-xs text-amber-300/80 mt-0.5">
                    To enable live SQL lookups, configure an active database connection in the Dashboard.
                    For full backend integration, enable Backend Functions in app settings.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {activeConnections.length > 0 && (
          <Card className="border-blue-700 bg-blue-900/20">
            <CardContent className="p-3">
              <div className="flex items-start gap-2">
                <Database className="w-4 h-4 text-blue-400 mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-blue-400">Connected to SQL Database</h3>
                  <p className="text-xs text-blue-300/80 mt-0.5">
                    {activeConnections[0].name} • {activeConnections[0].database_name}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}