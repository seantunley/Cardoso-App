import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { Database } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getDailyOperatorCodename, getJohannesburgGreeting } from "@/lib/fun";

function relativeTime(dateStr) {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const FLAGS = [
  { key: "red",    label: "blocked",    hue: "hsl(0 72% 50%)",   glow: "hsla(0, 72%, 50%, 0.35)" },
  { key: "orange", label: "attention",  hue: "hsl(33 95% 55%)",  glow: "hsla(33, 95%, 55%, 0.35)" },
  { key: "green",  label: "good",       hue: "hsl(145 55% 45%)", glow: "hsla(145, 55%, 45%, 0.25)" },
  { key: "none",   label: "unflagged",  hue: "hsl(30 10% 42%)",  glow: "transparent" },
];

const FLAG_TOOLTIPS = {
  red: "Blocked or high-risk — do not extend credit",
  orange: "Caution required — review before action",
  green: "Good standing — no concerns",
  none: "Unflagged — not yet categorised",
};

export default function Dashboard() {
  const { data: kpis, isError: kpisError, isLoading } = useQuery({
    queryKey: ["kpis"],
    queryFn: () => api.kpis(),
    staleTime: 30_000,
  });

  const { data: connections = [] } = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.entities.DatabaseConnection.list(),
  });

  const totalRecords = kpisError ? "—" : (kpis?.total_records?.toLocaleString("en-US") ?? "—");
  const flags = kpis?.records_by_flag ?? {};
  const lastSync = kpis?.last_sync_at ?? null;
  const activeCount = connections.filter((c) => c.status === "active").length;
  const flaggedTotal = (flags.red || 0) + (flags.orange || 0);
  const johannesburgGreeting = getJohannesburgGreeting();
  const operatorCodename = getDailyOperatorCodename();
  const flaggedRatio = kpis?.total_records ? ((flaggedTotal / kpis.total_records) * 100).toFixed(1) : "—";

  if (connections.length === 0 && !kpis) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-[1600px] mx-auto px-8 py-16">
          <Header greeting={johannesburgGreeting} operatorCodename={operatorCodename} />
          <div className="mt-16 border border-border py-24 text-center">
            <Database className="w-10 h-10 mx-auto mb-6 text-muted-foreground/60" strokeWidth={1} />
            <h3 className="font-display text-3xl text-foreground mb-2">No connections configured</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Set up your first database connection to begin ledgering customer records.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto px-8 py-10 lg:py-16">
        <Header
          subtitle={lastSync ? `Last sync ${relativeTime(lastSync)}` : "Awaiting first sync"}
          greeting={johannesburgGreeting}
          operatorCodename={operatorCodename}
        />

        {/* ── Hero KPI row — oversized numbers, minimal chrome ── */}
        <div className="mt-12 grid grid-cols-1 lg:grid-cols-12 gap-4 stagger-in">
          {/* Total Records — the headline number */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="lg:col-span-5 bg-card border border-border px-8 py-10 flex flex-col justify-between min-h-[240px] cursor-default group"
                style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
              >
                <div className="flex items-start justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    01 · Records on file
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {activeCount}/{connections.length} active
                  </span>
                </div>
                <div>
                  <div className="font-display text-7xl lg:text-[7rem] leading-none text-foreground tracking-tight tabular-nums">
                    {isLoading ? <span className="text-muted-foreground/40">0</span> : totalRecords}
                  </div>
                  <div className="mt-3 h-px bg-border group-hover:bg-accent transition-colors" />
                  <p className="mt-3 text-xs text-muted-foreground">
                    Customer records synced across all connections
                  </p>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Total customer records synced from all active connections</TooltipContent>
          </Tooltip>

          {/* Flag breakdown — the core workflow visualized */}
          <div
            className="lg:col-span-4 bg-card border border-border px-8 py-10 flex flex-col justify-between"
            style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
          >
            <div className="flex items-start justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                02 · Flag distribution
              </span>
              <span className="font-mono text-[10px] text-accent">
                {flaggedRatio}% flagged
              </span>
            </div>
            <div className="space-y-3">
              {FLAGS.map((f) => {
                const count = flags[f.key] ?? 0;
                const total = kpis?.total_records || 1;
                const pct = Math.min(100, (count / total) * 100);
                return (
                  <Tooltip key={f.key}>
                    <TooltipTrigger asChild>
                      <div className="group cursor-default">
                        <div className="flex items-baseline justify-between mb-1">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            {f.label}
                          </span>
                          <span className="font-mono text-sm font-medium text-foreground tabular-nums">
                            {count.toLocaleString()}
                          </span>
                        </div>
                        <div className="h-1 bg-muted overflow-hidden">
                          <div
                            className="h-full transition-all duration-700 ease-out"
                            style={{
                              width: `${pct}%`,
                              background: f.hue,
                              boxShadow: `0 0 12px ${f.glow}`,
                            }}
                          />
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>{FLAG_TOOLTIPS[f.key]}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          {/* System pulse — connections + sync status */}
          <div
            className="lg:col-span-3 bg-card border border-border px-8 py-10 flex flex-col justify-between"
            style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
          >
            <div>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                03 · System
              </span>
            </div>
            <div className="space-y-6">
              <div>
                <div className="font-display text-5xl leading-none text-foreground tabular-nums">
                  {connections.length}
                </div>
                <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  connections · <span className={activeCount > 0 ? "text-accent" : ""}>{activeCount} live</span>
                </div>
              </div>
              <div>
                <div className="font-mono text-xl text-foreground tabular-nums">
                  {relativeTime(lastSync)}
                </div>
                <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  last sync
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Flagged priority strip — only visible if flagged records exist ── */}
        {flaggedTotal > 0 && (
          <div
            className="mt-4 border border-border bg-card px-8 py-5 flex items-center justify-between gap-6"
            style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
          >
            <div className="flex items-center gap-5">
              <div
                className="w-1 h-10"
                style={{ background: "hsl(0 72% 50%)", boxShadow: "0 0 20px hsla(0, 72%, 50%, 0.5)" }}
              />
              <div>
                <div className="font-display text-2xl leading-tight text-foreground">
                  {flaggedTotal.toLocaleString()}
                  <span className="text-muted-foreground font-sans text-base font-normal ml-2">
                    records require attention
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  <span className="font-mono text-destructive">{flags.red || 0} blocked</span>
                  <span className="mx-2 text-border">·</span>
                  <span className="font-mono text-accent">{flags.orange || 0} caution</span>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Footer signature */}
        <div className="mt-16 pt-6 border-t border-border flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Cardoso / Ledger
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {new Date().toISOString().split("T")[0]}
          </span>
        </div>
      </div>
    </div>
  );
}

function Header({ subtitle, greeting, operatorCodename }) {
  return (
    <div className="flex items-end justify-between gap-8 border-b border-border pb-6">
      <div>

        <h1 className="font-display text-5xl lg:text-6xl leading-[0.95] text-foreground tracking-tight">
          The <em className="text-phosphor">ledger</em>,<br />
          at a glance.
        </h1>
        {greeting && (
          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
            {greeting}
          </p>
        )}
        {operatorCodename && (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Operator codename: {operatorCodename}
          </p>
        )}
      </div>
      {subtitle && (
        <div className="hidden md:block font-mono text-xs text-muted-foreground pb-2 whitespace-nowrap">
          {subtitle}
        </div>
      )}
    </div>
  );
}
