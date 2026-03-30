import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Circle, AlertCircle, CheckCircle2, Clock, Search, Building2, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const FLAG_COLORS = {
  red:    { label: "Red",    bg: "bg-red-100",    text: "text-red-800",    dot: "bg-red-500"    },
  orange: { label: "Orange", bg: "bg-orange-100", text: "text-orange-800", dot: "bg-orange-500" },
  green:  { label: "Green",  bg: "bg-green-100",  text: "text-green-800",  dot: "bg-green-500"  },
  none:   { label: "Clear",  bg: "bg-muted",      text: "text-muted-foreground", dot: "bg-muted-foreground" },
};

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-3xl font-bold text-foreground">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SiteCard({ site }) {
  const isOnline = site.status === "online";
  const kpis = site.kpis;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-foreground">{site.site_name || site.site_slug}</span>
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs font-medium", isOnline ? "text-green-600" : "text-muted-foreground")}>
          {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {isOnline ? "Online" : "Offline"}
        </div>
      </div>
      {kpis ? (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-muted p-2">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="font-bold">{kpis.total_records ?? "—"}</p>
          </div>
          <div className="rounded-lg bg-red-50 p-2">
            <p className="text-xs text-red-600">Red</p>
            <p className="font-bold text-red-700">{kpis.flagged_records?.red ?? 0}</p>
          </div>
          <div className="rounded-lg bg-orange-50 p-2">
            <p className="text-xs text-orange-600">Orange</p>
            <p className="font-bold text-orange-700">{kpis.flagged_records?.orange ?? 0}</p>
          </div>
          <div className="rounded-lg bg-green-50 p-2">
            <p className="text-xs text-green-600">Green</p>
            <p className="font-bold text-green-700">{kpis.flagged_records?.green ?? 0}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No KPI data yet</p>
      )}
      {site.last_seen && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Last sync: {new Date(site.last_seen).toLocaleString()}
        </p>
      )}
    </div>
  );
}

export default function HubDashboard() {
  const [kpis, setKpis] = useState(null);
  const [records, setRecords] = useState([]);
  const [syncLog, setSyncLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filterFlag, setFilterFlag] = useState("");
  const [filterSite, setFilterSite] = useState("");

  const fetchAll = useCallback(async () => {
    try {
      const [kpiRes, syncRes] = await Promise.all([
        fetch("/api/hub/kpis", { credentials: "include" }),
        fetch("/api/hub/sync-log?limit=20", { credentials: "include" }),
      ]);
      if (!kpiRes.ok) throw new Error("Hub API unavailable — is this the Head Office instance?");
      setKpis(await kpiRes.json());
      if (syncRes.ok) setSyncLog(await syncRes.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRecords = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterSite) params.set("site_id", filterSite);
    if (filterFlag) params.set("flag_color", filterFlag);
    if (search) params.set("search", search);
    const res = await fetch(`/api/hub/records?${params}`, { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      setRecords(data.records || []);
    }
  }, [filterSite, filterFlag, search]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/hub/sync", { method: "POST", credentials: "include" });
      // Wait a moment then refresh
      setTimeout(() => { fetchAll(); fetchRecords(); setSyncing(false); }, 3000);
    } catch { setSyncing(false); }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="max-w-md text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
          <p className="font-semibold text-foreground">Hub not available</p>
          <p className="text-sm text-muted-foreground mt-1">{error}</p>
        </div>
      </div>
    );
  }

  const sites = kpis?.sites || [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Hub Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Aggregated view across all sites</p>
        </div>
        <Button onClick={triggerSync} disabled={syncing} variant="outline" className="gap-2">
          <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync Now"}
        </Button>
      </div>

      {/* Global KPI strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total Records" value={kpis?.total_records?.toLocaleString() ?? "—"} sub={`across ${sites.length} site${sites.length !== 1 ? "s" : ""}`} />
        <StatCard label="Red" value={kpis?.records_by_flag?.red ?? 0} />
        <StatCard label="Orange" value={kpis?.records_by_flag?.orange ?? 0} />
        <StatCard label="Green" value={kpis?.records_by_flag?.green ?? 0} />
      </div>

      {/* Per-site cards */}
      {sites.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Sites</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sites.map(s => <SiteCard key={s.site_id} site={s} />)}
          </div>
        </div>
      )}

      {/* Records table */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Records</h2>
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap gap-3 p-4 border-b border-border">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search name or number…"
                className="pl-9"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={filterFlag}
              onChange={e => setFilterFlag(e.target.value)}
            >
              <option value="">All flags</option>
              {Object.entries(FLAG_COLORS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <select
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={filterSite}
              onChange={e => setFilterSite(e.target.value)}
            >
              <option value="">All sites</option>
              {sites.map(s => (
                <option key={s.site_id} value={s.site_id}>{s.site_name || s.site_slug}</option>
              ))}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Number</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Flag</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Reason</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Site</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Updated</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No records found</td>
                  </tr>
                ) : records.map((r, i) => {
                  const flag = FLAG_COLORS[r.flag_color] || FLAG_COLORS.none;
                  const siteInfo = sites.find(s => s.site_id === r.site_id);
                  return (
                    <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium text-foreground">{r.customer_name || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.customer_number || "—"}</td>
                      <td className="px-4 py-3">
                        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", flag.bg, flag.text)}>
                          <span className={cn("h-1.5 w-1.5 rounded-full", flag.dot)} />
                          {flag.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">{r.flag_reason || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{siteInfo?.site_name || siteInfo?.site_slug || r.site_id}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {r.updated_date ? new Date(r.updated_date).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {records.length > 0 && (
            <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
              Showing {records.length} record{records.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      {/* Sync log */}
      {syncLog.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Sync Log</h2>
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Site</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Records</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Started</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">Note</th>
                </tr>
              </thead>
              <tbody>
                {syncLog.map((row, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 text-foreground">{row.site_slug}</td>
                    <td className="px-4 py-2.5">
                      {row.status === "success"
                        ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                        : row.status === "error"
                        ? <AlertCircle className="h-4 w-4 text-red-500" />
                        : <Clock className="h-4 w-4 text-muted-foreground" />}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{row.records_fetched ?? "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                      {row.started_at ? new Date(row.started_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[240px] truncate">{row.error_message || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
