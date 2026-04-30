import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Database, Flag, CheckCircle, RefreshCw } from "lucide-react";
import CustomerLookup from "../components/customer/CustomerLookup";
import FlaggedCustomersModal from "../components/customer/FlaggedCustomersModal";

export default function CustomerSearch() {
  const queryClient = useQueryClient();
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [selectedFlagColor, setSelectedFlagColor] = useState(null);
  const [customerNumberToLookup, setCustomerNumberToLookup] = useState("");

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
    staleTime: Infinity,
  });

  const [selectedConnectionId, setSelectedConnectionId] = useState(null);

  const { data: connections = [] } = useQuery({
    queryKey: ["connections", currentUser?.email],
    queryFn: async () => {
      if (!currentUser) return [];
      const allConnections = await api.entities.DatabaseConnection.list();
      // BAT-only connections feed the BAT module's own pool — they must not
      // appear in customer-search context (no datarecord rows are sourced from them).
      return allConnections.filter(c => !c.is_bat_only);
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

  const { data: kpis = null } = useQuery({
    queryKey: ["kpis"],
    queryFn: async () => {
      try { return await api.kpis(); } catch { return null; }
    },
    staleTime: 30_000,
  });

  const { data: fallbackFlagCounts = null } = useQuery({
    queryKey: ["record-flag-counts"],
    queryFn: async () => {
      try { return await api.records.flagCounts(); } catch { return null; }
    },
    enabled: kpis === null,
    staleTime: 30_000,
  });

  useEffect(() => {
    let debounceTimer = null;
    const unsubscribe = api.entities.DataRecord.subscribe((event) => {
      if (["create", "update"].includes(event.type)) {
        // Batch rapid events (e.g., during a sync) into a single invalidation
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["kpis"] });
        }, 1000);
      }
    });
    return () => {
      clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [queryClient]);

  const activeConnections = connections.filter(c => c.status === "active");
  const selectedConnection = connections.find(c => c.id === selectedConnectionId);
  
  // Prefer KPI endpoint, then lightweight grouped counts; never fall back to full-record fetches here.
  const redCount = kpis?.records_by_flag?.red ?? fallbackFlagCounts?.records_by_flag?.red ?? 0;
  const greenCount = kpis?.records_by_flag?.green ?? fallbackFlagCounts?.records_by_flag?.green ?? 0;
  const orangeCount = kpis?.records_by_flag?.orange ?? fallbackFlagCounts?.records_by_flag?.orange ?? 0;

  const handleFlagClick = (flagColor) => {
    setSelectedFlagColor(flagColor);
    setFlagModalOpen(true);
  };

  const handleCustomerClickFromModal = (customer) => {
    const customerNumber = customer.customer_number || customer.data?.customer_number;
    setCustomerNumberToLookup(customerNumber);
    setFlagModalOpen(false);
  };

  // FlaggedCustomersModal fetches its own records server-side

  const FLAG_TILES = [
    { key: "red",    label: "Critical",  sub: "red flagged",    count: redCount,    hue: "hsl(0 72% 50%)",   glow: "hsla(0, 72%, 50%, 0.35)",   icon: Flag },
    { key: "orange", label: "Attention", sub: "orange flagged", count: orangeCount, hue: "var(--phosphor)", glow: "hsla(33, 95%, 55%, 0.35)", icon: AlertCircle },
    { key: "green",  label: "Approved",  sub: "green flagged",  count: greenCount,  hue: "hsl(145 55% 45%)", glow: "hsla(145, 55%, 45%, 0.25)", icon: CheckCircle },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-8 py-10 space-y-6">
        {/* Header */}
        <div className="border-b border-border pb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">
            § Customer Management
          </div>
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            Search the <em className="text-phosphor">ledger</em>.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Review customer accounts, balances, and outstanding activity.
          </p>
        </div>

        {/* Flag Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border border border-border stagger-in" style={{ borderRadius: "2px" }}>
          {FLAG_TILES.map(({ key, label, sub, count, hue, glow, icon: Icon }) => (
            <button
              key={key}
              onClick={() => handleFlagClick(key)}
              className="relative bg-card text-left px-5 py-4 transition-colors hover:bg-muted/40 group cursor-pointer"
            >
              <div
                className="absolute left-0 top-0 bottom-0 w-[2px] transition-all"
                style={{ background: hue, boxShadow: `0 0 12px ${glow}` }}
              />
              <div className="flex items-start justify-between pl-2">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">
                    {label}
                  </div>
                  <div className="font-display text-4xl leading-none text-foreground tabular-nums">
                    {count.toLocaleString()}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-2">
                    {sub}
                  </div>
                </div>
                <Icon className="w-4 h-4 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" style={{ color: hue }} strokeWidth={1.5} />
              </div>
            </button>
          ))}
        </div>

        {/* Flagged Customers Modal */}
        <FlaggedCustomersModal
          flagColor={selectedFlagColor}
          open={flagModalOpen}
          onClose={() => setFlagModalOpen(false)}
          onCustomerClick={handleCustomerClickFromModal}
        />

        {/* Customer Lookup + Last Sync side by side */}
        <div className="flex flex-col sm:flex-row gap-px bg-border border border-border items-stretch" style={{ borderRadius: "2px" }}>
          <div className="flex-1 bg-card min-w-0">
            <CustomerLookup
              currentUser={currentUser}
              onRecordSelect={setSelectedRecord}
              triggerLookup={customerNumberToLookup}
              onLookupComplete={() => setCustomerNumberToLookup("")}
              selectedConnection={selectedConnection}
              onFlagChange={() => { queryClient.invalidateQueries({ queryKey: ["records"] }); queryClient.invalidateQueries({ queryKey: ["kpis"] }); }}
            />
          </div>

          {selectedConnection && (
            <div className="w-full sm:flex-shrink-0 sm:w-56 bg-card relative px-5 py-4 flex flex-col justify-center">
              <div
                className="absolute left-0 top-0 bottom-0 w-[2px]"
                style={{ background: "var(--phosphor)", boxShadow: "0 0 12px hsla(33,95%,55%,0.35)" }}
              />
              <div className="flex items-center gap-2 mb-2 pl-2">
                <RefreshCw className="w-3 h-3 text-accent" />
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Last Sync</p>
              </div>
              <div className="pl-2">
                {selectedConnection.last_sync ? (
                  <>
                    <p className="font-mono text-xs text-muted-foreground">
                      {new Date(selectedConnection.last_sync + (selectedConnection.last_sync.endsWith("Z") ? "" : "Z")).toLocaleString("en-ZA", {
                        timeZone: "Africa/Johannesburg",
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                    <p className="font-display text-3xl leading-none text-foreground tabular-nums mt-1">
                      {new Date(selectedConnection.last_sync + (selectedConnection.last_sync.endsWith("Z") ? "" : "Z")).toLocaleString("en-ZA", {
                        timeZone: "Africa/Johannesburg",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </p>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-2 truncate">
                      {selectedConnection.name}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Never synced</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Connection Status Banner */}
        {activeConnections.length === 0 && (
          <div className="border border-border bg-card relative px-5 py-3" style={{ borderRadius: "2px" }}>
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: "var(--phosphor)", boxShadow: "0 0 12px hsla(33,95%,55%,0.35)" }}
            />
            <div className="flex items-start gap-3 pl-2">
              <AlertCircle className="w-4 h-4 text-accent mt-0.5 shrink-0" strokeWidth={1.5} />
              <div className="flex-1">
                <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent mb-1">No Active Connections</h3>
                <p className="text-xs text-muted-foreground">
                  Configure a database connection in the Dashboard to enable live SQL lookups.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeConnections.length > 0 && (
          <div className="border border-border bg-card relative px-5 py-3" style={{ borderRadius: "2px" }}>
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: "hsl(145 55% 45%)", boxShadow: "0 0 12px hsla(145,55%,45%,0.3)" }}
            />
            <div className="flex items-start gap-3 pl-2">
              <Database className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(145 55% 45%)" }} strokeWidth={1.5} />
              <div className="flex-1">
                <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1" style={{ color: "hsl(145 55% 45%)" }}>Connected</h3>
                <p className="text-xs text-muted-foreground font-mono">
                  {activeConnections[0].name} · {activeConnections[0].database_name}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}