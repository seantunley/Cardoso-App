import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Cpu,
  Network,
  Printer,
  RefreshCw,
  Router,
  Search,
  Smartphone,
  Wifi,
  Laptop,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useAuth } from "@/lib/AuthContext";

async function fetchAppInfo() {
  const res = await fetch("/api/app-info", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchNetworkDevices({ hubMode, siteId }) {
  const url = hubMode
    ? `/api/hub/network-devices${siteId && siteId !== "all" ? `?site_id=${encodeURIComponent(siteId)}` : ""}`
    : `/api/network-devices`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtRelative(iso) {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(diff / 60000));
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function categoryMeta(category) {
  switch (category) {
    case "phone":
      return { label: "Phone", icon: Smartphone, cls: "bg-blue-500/10 border-blue-500/30 text-blue-300" };
    case "machine":
      return { label: "Machine / PC", icon: Laptop, cls: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" };
    case "printer":
      return { label: "Printer", icon: Printer, cls: "bg-amber-500/10 border-amber-500/30 text-amber-300" };
    case "network":
      return { label: "Network gear", icon: Router, cls: "bg-violet-500/10 border-violet-500/30 text-violet-300" };
    default:
      return { label: "Other / unknown", icon: Cpu, cls: "bg-slate-500/10 border-slate-500/30 text-slate-300" };
  }
}

function StatusPill({ active, recent }) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Active
      </span>
    );
  }
  if (recent) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />Recently seen
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-500/30 bg-slate-500/10 px-2 py-1 text-[11px] text-slate-300">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />Inactive
    </span>
  );
}

function SummaryCard({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold text-foreground">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export default function NetworkDevices() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [siteFilter, setSiteFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState(null);
  const [scanBusy, setScanBusy] = useState(false);

  const appInfoQuery = useQuery({
    queryKey: ["app-info"],
    queryFn: fetchAppInfo,
    staleTime: 60_000,
  });

  const hubMode = !!appInfoQuery.data?.hub_mode;

  const devicesQuery = useQuery({
    queryKey: ["network-devices", hubMode, siteFilter],
    queryFn: () => fetchNetworkDevices({ hubMode, siteId: siteFilter }),
    enabled: appInfoQuery.isSuccess,
    refetchInterval: hubMode ? 300_000 : 120_000,
  });

  const devices = devicesQuery.data?.devices || [];
  const sites = devicesQuery.data?.sites || [];
  const latestScan = devicesQuery.data?.latest_scan || null;

  const filteredDevices = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((device) => {
      const haystack = [
        device.hostname,
        device.ip_address,
        device.mac_address,
        device.vendor,
        device.classification_label,
        device.site_name,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [devices, search]);

  useEffect(() => {
    if (!filteredDevices.length) {
      setSelectedKey(null);
      return;
    }
    const exists = filteredDevices.some(
      (d) => `${d.site_id || "local"}:${d.mac_address}` === selectedKey
    );
    if (!exists) {
      const first = filteredDevices[0];
      setSelectedKey(`${first.site_id || "local"}:${first.mac_address}`);
    }
  }, [filteredDevices, selectedKey]);

  const selectedDevice =
    filteredDevices.find((d) => `${d.site_id || "local"}:${d.mac_address}` === selectedKey) || null;

  const summary = useMemo(() => {
    const counts = { total: filteredDevices.length, active: 0, recent: 0, phones: 0, machines: 0, printers: 0, network: 0 };
    for (const d of filteredDevices) {
      if (d.active) counts.active += 1;
      if (d.recently_seen) counts.recent += 1;
      if (d.device_category === "phone") counts.phones += 1;
      else if (d.device_category === "machine") counts.machines += 1;
      else if (d.device_category === "printer") counts.printers += 1;
      else if (d.device_category === "network") counts.network += 1;
    }
    return counts;
  }, [filteredDevices]);

  const runSiteScan = async () => {
    setScanBusy(true);
    try {
      const res = await fetch("/api/network-devices/scan", { method: "POST", credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.ok === false) {
        toast({ title: "Scan unavailable", description: data.reason || "Network scan is unavailable on this machine", variant: "destructive" });
        return;
      }
      toast({ title: "Scan complete", description: `Found ${data.devices?.length ?? 0} device(s)` });
      queryClient.invalidateQueries({ queryKey: ["network-devices"] });
    } catch (err) {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    } finally {
      setScanBusy(false);
    }
  };

  const pullHubData = async () => {
    setScanBusy(true);
    try {
      const body = siteFilter !== "all" ? { site_ids: [siteFilter] } : {};
      const res = await fetch("/api/hub/network-devices/pull", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 207) throw new Error(data.error || `HTTP ${res.status}`);
      const okCount = (data.results || []).filter((r) => r.ok).length;
      toast({ title: "Hub pull complete", description: `Updated ${okCount} site(s)` });
      queryClient.invalidateQueries({ queryKey: ["network-devices"] });
    } catch (err) {
      toast({ title: "Hub pull failed", description: err.message, variant: "destructive" });
    } finally {
      setScanBusy(false);
    }
  };

  const canPullHub = user?.role === "admin";

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10">
              <Network className="h-5 w-5 text-cyan-300" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Network Devices</h1>
              <p className="text-sm text-muted-foreground">
                LAN device inventory — MAC, IP, hostname, classification, and presence tracking.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hubMode && sites.length > 0 && (
              <select
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
                className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground"
              >
                <option value="all">All sites</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name || site.slug || site.id}
                  </option>
                ))}
              </select>
            )}

            <Button variant="outline" onClick={() => devicesQuery.refetch()} disabled={devicesQuery.isFetching}>
              <RefreshCw className={`mr-2 h-4 w-4 ${devicesQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>

            {!hubMode ? (
              <Button onClick={runSiteScan} disabled={scanBusy}>
                <Wifi className="mr-2 h-4 w-4" />
                {scanBusy ? "Scanning…" : "Scan now"}
              </Button>
            ) : canPullHub ? (
              <Button onClick={pullHubData} disabled={scanBusy}>
                <Wifi className="mr-2 h-4 w-4" />
                {scanBusy ? "Pulling…" : "Pull from sites"}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Windows-only notice for non-hub mode */}
        {!hubMode && (
          <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 text-sm text-blue-100">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
              <p>
                Network discovery requires a Windows site machine. On non-Windows installs, scans will report as unavailable but saved inventory is still visible.
              </p>
            </div>
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <SummaryCard
            icon={Network}
            label="Total devices"
            value={summary.total}
            sub={hubMode ? "Across selected hub scope" : "Current site inventory"}
          />
          <SummaryCard
            icon={Activity}
            label="Active now"
            value={summary.active}
            sub={latestScan?.completed_at ? `Last scan ${fmtRelative(latestScan.completed_at)}` : "No scan yet"}
          />
          <SummaryCard icon={RefreshCw} label="Recently seen" value={summary.recent} sub="Seen in the last 24 h" />
          <SummaryCard icon={Smartphone} label="Phones" value={summary.phones} />
          <SummaryCard icon={Laptop} label="Machines" value={summary.machines} />
          <SummaryCard icon={Printer} label="Printers" value={summary.printers} sub={`${summary.network} network gear`} />
        </div>

        {/* Main layout */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.4fr_0.8fr]">
          {/* Device list */}
          <div className="rounded-xl border border-border bg-card">
            <div className="border-b border-border p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Discovered devices</h2>
                  <p className="text-sm text-muted-foreground">
                    {latestScan?.completed_at
                      ? `Latest scan ${fmtDate(latestScan.completed_at)}`
                      : "No completed scan recorded yet"}
                  </p>
                </div>
                <div className="relative w-full md:w-72">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search MAC, IP, hostname, vendor…"
                    className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm text-foreground"
                  />
                </div>
              </div>
            </div>

            {devicesQuery.isLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading devices…
              </div>
            ) : devicesQuery.isError ? (
              <div className="p-6 text-sm text-red-300">
                {devicesQuery.error?.message || "Failed to load network devices"}
              </div>
            ) : filteredDevices.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                No network devices found.
                {devices.length === 0 && !hubMode && " Run a scan to discover devices on this LAN."}
              </div>
            ) : (
              <div className="max-h-[700px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-3">Device</th>
                      <th className="px-3 py-3">Status</th>
                      {hubMode && <th className="px-3 py-3">Site</th>}
                      <th className="px-3 py-3">IP / MAC</th>
                      <th className="px-3 py-3">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDevices.map((device) => {
                      const key = `${device.site_id || "local"}:${device.mac_address}`;
                      const meta = categoryMeta(device.device_category);
                      const Icon = meta.icon;
                      const isSelected = key === selectedKey;
                      return (
                        <tr
                          key={key}
                          onClick={() => setSelectedKey(key)}
                          className={`cursor-pointer border-b border-border/60 transition-colors hover:bg-muted/40 ${isSelected ? "bg-muted/50" : ""}`}
                        >
                          <td className="px-4 py-3 align-top">
                            <div className="font-medium text-foreground">
                              {device.hostname || device.classification_label || device.mac_address}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {device.vendor || device.classification_rationale || "No vendor fingerprint"}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <StatusPill active={device.active} recent={device.recently_seen} />
                            <div className="mt-1 text-xs text-muted-foreground">{fmtRelative(device.last_seen)}</div>
                          </td>
                          {hubMode && (
                            <td className="px-3 py-3 align-top text-sm text-muted-foreground">
                              {device.site_name || device.site_slug || device.site_id || "—"}
                            </td>
                          )}
                          <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                            <div>{device.ip_address || "—"}</div>
                            <div className="mt-0.5 font-mono">{device.mac_address}</div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${meta.cls}`}>
                              <Icon className="h-3 w-3" />
                              {device.classification_label || meta.label}
                            </span>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              Confidence: {device.classification_confidence || "low"}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Detail panel */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-4">
              <Network className="h-4 w-4 text-cyan-300" />
              <h2 className="text-lg font-semibold">Device detail</h2>
            </div>

            {!selectedDevice ? (
              <div className="py-10 text-sm text-muted-foreground">
                Select a device from the list to view its details.
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-xl font-semibold text-foreground">
                    {selectedDevice.hostname || selectedDevice.classification_label || selectedDevice.mac_address}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {selectedDevice.vendor || "Vendor unknown"}
                  </div>
                  <div className="mt-2">
                    <StatusPill active={selectedDevice.active} recent={selectedDevice.recently_seen} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg border border-border bg-background p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">IP address</div>
                    <div className="mt-1 font-medium">{selectedDevice.ip_address || "—"}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-background p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">MAC address</div>
                    <div className="mt-1 font-mono text-xs break-all">{selectedDevice.mac_address}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-background p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">First seen</div>
                    <div className="mt-1 font-medium">{fmtDate(selectedDevice.first_seen)}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-background p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Last seen</div>
                    <div className="mt-1 font-medium">{fmtDate(selectedDevice.last_seen)}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-background p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Interface</div>
                    <div className="mt-1 font-medium">{selectedDevice.interface_alias || "—"}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-background p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Neighbor state</div>
                    <div className="mt-1 font-medium">{selectedDevice.neighbor_state || "Unknown"}</div>
                  </div>
                </div>

                {selectedDevice.interface_description && (
                  <div className="rounded-lg border border-border bg-background p-3 text-sm">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Interface description</div>
                    <div className="mt-1 font-medium text-xs">{selectedDevice.interface_description}</div>
                  </div>
                )}

                {hubMode && (
                  <div className="rounded-lg border border-border bg-background p-3 text-sm">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Site</div>
                    <div className="mt-1 font-medium">
                      {selectedDevice.site_name || selectedDevice.site_slug || selectedDevice.site_id || "—"}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-border bg-background p-3 text-sm">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Classification</div>
                  <div className="mt-1 font-medium">
                    {selectedDevice.classification_label || "Unknown"}
                    {selectedDevice.classification_confidence && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({selectedDevice.classification_confidence} confidence)
                      </span>
                    )}
                  </div>
                  {selectedDevice.classification_rationale && (
                    <div className="mt-1 text-xs text-muted-foreground">{selectedDevice.classification_rationale}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
