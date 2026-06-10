// Operations → Security tab. Live view of abuse telemetry from
// src/lib/securitySignals.js. Read-only summary; persistent alerts
// land in the Alerts panel via the alertRules engine.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function SecuritySignalsPanel() {
  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["security-signals"],
    queryFn: async () => {
      const r = await fetch('/api/system/security-signals', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load security signals');
      return d;
    },
    refetchInterval: 30_000,
  });

  const totals = data?.totals || {};
  // Short descriptions explain what each metric means in operator
  // language, not HTTP-spec language. The point of the card grid is
  // pattern-recognition at a glance — 401/403/429 spiking together
  // looks like a scanner; 401 alone climbing looks like brute force.
  const cards = useMemo(() => ([
    { label: '401', value: totals.status_401 ?? 0, hint: 'Unauthorized — requests with no/expired/invalid session. Spike = login attempts or stale clients.' },
    { label: '403', value: totals.status_403 ?? 0, hint: 'Forbidden — authenticated but not allowed. Spike = scanner probing endpoints, or a permission bug.' },
    { label: '429', value: totals.status_429 ?? 0, hint: 'Too Many Requests — rate-limit middleware blocked the request. Spike = flood, runaway client, or stuffing.' },
    { label: 'Login failures', value: totals.login_failures ?? 0, hint: 'HTTP 401 against /api/auth/login (and friends). Direct measure of bad-password attempts.' },
    { label: 'Login throttled', value: totals.login_throttle_events ?? 0, hint: 'HTTP 429 against /api/auth/login. Rate limiter caught a burst before credentials were checked.' },
    { label: 'Avg latency', value: `${totals.avg_latency_ms ?? 0} ms`, hint: 'Mean response time across every request in the window. Sudden rise = backend stress or a slow upstream.' },
    { label: 'Upload volume', value: fmtBytes(totals.upload_bytes ?? 0), hint: 'Sum of Content-Length on POD/image/multipart uploads. Useful for spotting bandwidth abuse.' },
    { label: 'Total requests', value: totals.requests ?? 0, hint: 'Every HTTP response that flushed in the window. Baseline for the other counters — what does "high" mean today?' },
  ]), [totals]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div>
          <h3 className="text-sm font-semibold">Security signals (last 60m)</h3>
          <p className="text-xs text-muted-foreground">
            Live abuse telemetry — brute-force / flood detection. Volatile (resets on restart);
            persistent alerts land in the Alerts panel.
          </p>
        </div>
        <Button onClick={() => refetch()} disabled={isRefetching} variant="outline" size="sm" className="ml-auto">
          <RefreshCw className={`w-4 h-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {error && <div className="rounded-lg border border-rose-700 bg-rose-900/20 p-3 text-sm text-rose-300">{error.message}</div>}

      {isLoading ? <div className="h-24 rounded-xl bg-muted animate-pulse" /> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-3">
            {cards.map((c) => (
              <div key={c.label} className="rounded-xl border border-border bg-card p-3 flex flex-col">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.label}</div>
                <div className="text-xl font-semibold mt-1">{c.value}</div>
                {c.hint && (
                  <div className="text-[10px] text-muted-subtle mt-2 leading-snug">{c.hint}</div>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-2">
              {data?.alerts?.length ? <ShieldAlert className="w-4 h-4 text-amber-500" /> : <ShieldCheck className="w-4 h-4 text-emerald-500" />}
              Threshold alerts
            </div>
            {!data?.alerts?.length ? (
              <p className="text-sm text-muted-foreground">No threshold alerts in the current window.</p>
            ) : (
              <ul className="list-disc pl-5 text-sm space-y-1">
                {data.alerts.map((a) => <li key={a}>{a}</li>)}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
