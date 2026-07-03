// One site in the fleet table: a compact always-visible row (name + a status
// dot per backup layer) that expands to a detail panel showing each layer's
// freshness, size and the actions that belong to it. Replaces the old
// two-column card grid, which showed one giant card per site and didn't scale
// past a handful of sites.

import { useState } from "react";
import {
  ChevronRight, Database, HardDrive, Cloud, CloudOff, ShieldCheck,
  Download, Upload, CheckCircle2, AlertTriangle, XCircle, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toneFor, OVERALL_LABEL } from "./backupTone.js";
import { fmtBytes, fmtRelative, fmtDate } from "./backupModel.js";

const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, critical: XCircle, muted: Clock };

function StatusDot({ status, title }) {
  const tone = toneFor(status);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${tone.dot} cursor-default`} />
      </TooltipTrigger>
      {title && <TooltipContent>{title}</TooltipContent>}
    </Tooltip>
  );
}

// Compact layer cell in the collapsed row: dot + short freshness.
function LayerCell({ status, lastAt, na }) {
  if (na) return <span className="text-xs text-muted-foreground/50">—</span>;
  const tone = toneFor(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} />
      <span className={`text-xs tabular-nums ${tone.text}`}>{fmtRelative(lastAt)}</span>
    </span>
  );
}

function HealthPill({ tone }) {
  const t = toneFor(tone === "ok" ? "ok" : tone === "warn" ? "warning" : tone === "critical" ? "error" : "unknown");
  const Icon = TONE_ICON[tone] || Clock;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${t.chip}`}>
      <Icon className="h-3.5 w-3.5" />
      {OVERALL_LABEL[tone] || "Unknown"}
    </span>
  );
}

// A row inside the expanded detail: one backup layer.
function LayerDetail({ icon: Icon, iconCls, name, status, statusLabel, lastAt, size, count, extra, sub, children }) {
  const tone = toneFor(status);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/60 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${iconCls}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{name}</span>
            <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.chip}`}>{statusLabel}</span>
          </div>
          {sub && <div className="text-[10px] text-muted-foreground/80">{sub}</div>}
          <div className="text-[11px] text-muted-foreground">
            {lastAt ? <>{fmtRelative(lastAt)} · {fmtDate(lastAt)}</> : "No backup recorded"}
            {size != null && <> · {fmtBytes(size)}</>}
            {count != null && <> · {count} kept</>}
            {extra && <> · {extra}</>}
          </div>
        </div>
      </div>
      {children && <div className="flex shrink-0 flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export default function SiteBackupRow({
  model, kopiaEnabled, onPullDb, onPullConfig, downloading, downloadingConfig, onRestore,
}) {
  const [open, setOpen] = useState(false);
  const m = model;
  const busyDb = downloading === m.id;
  const busyCfg = downloadingConfig === m.id;

  return (
    <div className="border-b border-border/60 last:border-0">
      {/* Collapsed row */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="grid w-full grid-cols-[1.4fr_auto_1fr_1fr_1fr_1fr_auto] items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{m.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">{m.url || "No URL"}</div>
          </div>
        </div>
        <HealthPill tone={m.overallTone} />
        <div className="hidden sm:block"><LayerCell status={m.local.status} lastAt={m.local.lastAt} /></div>
        <div className="hidden sm:block"><LayerCell status={m.hub.status} lastAt={m.hub.lastAt} /></div>
        <div className="hidden sm:block"><LayerCell status={m.offsite.status} lastAt={m.offsite.lastAt} na={!kopiaEnabled} /></div>
        <div className="hidden sm:block"><LayerCell status={m.sql.status} lastAt={m.sql.lastAt} na={m.sql.status === "unavailable" && m.sql.databases.length === 0} /></div>
        <span className="text-[11px] text-muted-foreground pr-1">{open ? "Hide" : "Details"}</span>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="space-y-2 bg-muted/10 px-3 pb-4 pt-1 sm:px-10">
          {m.error && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${toneFor("error").chip}`}>
              Live poll failed: {m.error}
            </div>
          )}

          <LayerDetail
            icon={Database} iconCls="border-accent/30 bg-accent/10 text-accent"
            name="Local (on site)" status={m.local.status} statusLabel={statusText(m.local.status)}
            lastAt={m.local.lastAt} size={m.local.size} count={m.local.count}
            extra={m.local.dbSize != null ? `live DB ${fmtBytes(m.local.dbSize)}` : null}
          >
            <Button size="sm" variant="outline" disabled={!m.url || busyDb} onClick={() => onPullDb(m.raw)} className="h-7 px-3 text-xs">
              <Download className="mr-1.5 h-3 w-3" />{busyDb ? "Pulling…" : "Pull DB"}
            </Button>
            <Button size="sm" variant="outline" disabled={!m.url || busyCfg} onClick={() => onPullConfig(m.raw)} className="h-7 px-3 text-xs text-status-warn">
              <Download className="mr-1.5 h-3 w-3" />{busyCfg ? "Pulling…" : "Pull .env"}
            </Button>
          </LayerDetail>

          <LayerDetail
            icon={HardDrive} iconCls="border-border bg-muted/40 text-foreground"
            name="Hub copy (pulled)" status={m.hub.status} statusLabel={m.hub.integrity === "corrupt" ? "Corrupt" : statusText(m.hub.status)}
            lastAt={m.hub.lastAt} size={m.hub.size} count={m.hub.count}
          >
            <Button size="sm" variant="outline" disabled={!m.url || m.hub.count === 0} onClick={() => onRestore(m.raw, "hub")}
              className="h-7 px-3 text-xs text-status-critical hover:border-status-critical/60">
              <Upload className="mr-1.5 h-3 w-3" />Restore from hub
            </Button>
          </LayerDetail>

          {kopiaEnabled && (
            <LayerDetail
              icon={m.offsite.status === "ok" ? Cloud : CloudOff}
              iconCls="border-border bg-muted/40 text-foreground"
              name="Off-site (Kopia)" status={m.offsite.status} statusLabel={offsiteText(m.offsite)}
              lastAt={m.offsite.lastAt} size={m.offsite.bytes}
              extra={m.offsite.count ? `${m.offsite.count} snapshots` : null}
            >
              <Button size="sm" variant="outline" disabled={!m.offsite.count} onClick={() => onRestore(m.raw, "offsite")}
                className="h-7 px-3 text-xs text-status-critical hover:border-status-critical/60">
                <Upload className="mr-1.5 h-3 w-3" />Restore off-site
              </Button>
            </LayerDetail>
          )}

          {/* SQL layer — always shown so SQL is first-class alongside the other
              backup types; sites with no SQL Server say so plainly. */}
          <LayerDetail
            icon={ShieldCheck} iconCls="border-border bg-muted/40 text-foreground"
            name="SQL Server (DAT)" status={m.sql.status} statusLabel={statusText(m.sql.status)}
            lastAt={m.sql.lastAt}
            sub="Held on the site's remote SQL Server — separate from the local app backup above"
          >
            {m.sql.databases.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {m.sql.databases.map((d) => {
                  const t = toneFor(d.isSuccess === true ? "ok" : d.isSuccess === false ? "failed" : "unknown");
                  return (
                    <span key={d.name} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono ${t.chip}`} title={d.backupAt ? fmtDate(d.backupAt) : ""}>
                      {d.name}
                    </span>
                  );
                })}
              </div>
            ) : (
              <span className="text-[11px] text-muted-foreground">{m.sql.message || "No SQL Server backup configured"}</span>
            )}
          </LayerDetail>
        </div>
      )}
    </div>
  );
}

function statusText(s) {
  const map = {
    ok: "OK", warning: "Overdue", stale: "Stale", never: "None", error: "Error",
    unreachable: "Offline", failed: "Failed", unavailable: "N/A", corrupt: "Corrupt", unknown: "Unknown",
  };
  return map[s] || s;
}
function offsiteText(o) {
  if (!o.enabled) return "Disabled";
  if (o.status === "ok") return "OK";
  if (o.reason === "never") return "None";
  return "Stale";
}
