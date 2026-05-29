// HubCommission — hub-mode overview of received commission archives.
//
// Modelled on HubJti (see src/pages/HubJti.jsx) but rendered as a flat
// (month × site) grid for the last 12 commission periods. The hub's
// commission feed is one archive per (site, period); a row is
// "complete" once every expected site has reported for that period.
//
// Backed by GET /api/hub/commission/archives, which returns:
//   - expected_sites: [{id, name}]                from HUB_SITES env
//   - archives: [hub_commission_archive row...]   joined with site_name
//
// Period grouping is done client-side: archives are bucketed by
// (period_year, period_month) and rendered in reverse chronological
// order so the latest month is at the top.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Download, Archive, AlertTriangle, CheckCircle2,
} from "lucide-react";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export default function HubCommission() {
  const [archives, setArchives] = useState([]);
  const [expectedSites, setExpectedSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadingId, setDownloadingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    refresh({ cancelledRef: () => cancelled });
    return () => { cancelled = true; };
  }, []);

  async function refresh({ cancelledRef = () => false } = {}) {
    setLoading(true);
    try {
      const r = await fetch("/api/hub/commission/archives?limit=500", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (cancelledRef()) return;
      setArchives(Array.isArray(data.archives) ? data.archives : []);
      setExpectedSites(Array.isArray(data.expected_sites) ? data.expected_sites : []);
      setError("");
    } catch (err) {
      if (!cancelledRef()) {
        setError(`Couldn't load archives: ${err.message}`);
        toast.error(`Couldn't load commission archives: ${err.message}`);
      }
    } finally {
      if (!cancelledRef()) setLoading(false);
    }
  }

  const handleDownload = async (id, filename) => {
    setDownloadingId(id);
    try {
      const r = await fetch(`/api/hub/commission/archives/${id}/download`, { credentials: "include" });
      if (!r.ok) {
        let message = `HTTP ${r.status}`;
        try { message = (await r.json()).error || message; }
        catch (e) { console.error("[hubCommission.download_parse]", { id }, e.message); }
        throw new Error(message);
      }
      const blob = await r.blob();
      triggerDownload(blob, filename || `Commission_hub_archive_${id}.pdf`);
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error(`Archive download failed: ${err.message}`);
    } finally {
      setDownloadingId(null);
    }
  };

  // Bucket archives by (period_year, period_month). Each bucket carries
  // the set of sites that have reported plus a `complete` flag computed
  // against the expected-sites list from HUB_SITES.
  const periods = useMemo(() => {
    const byKey = new Map();
    for (const a of archives) {
      const key = `${a.period_year}-${String(a.period_month).padStart(2, "0")}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          period_year: a.period_year,
          period_month: a.period_month,
          received: [],
          received_by_site: new Map(),
        });
      }
      const bucket = byKey.get(key);
      bucket.received.push(a);
      // If a site has both a 'scheduled' and a 'manual' row for the
      // same period, prefer the scheduled one for the grid cell — it's
      // the canonical month-end snapshot. Operator can still find the
      // manual row via /api/commission/archives on the site itself.
      const existing = bucket.received_by_site.get(a.site_id);
      if (!existing || (a.source === "scheduled" && existing.source !== "scheduled")) {
        bucket.received_by_site.set(a.site_id, a);
      }
    }
    const expectedIds = new Set(expectedSites.map((s) => s.id));
    return Array.from(byKey.values())
      .map((p) => ({
        ...p,
        expected_count: expectedSites.length,
        received_count: Array.from(p.received_by_site.keys()).filter((id) => expectedIds.has(id)).length,
        complete: expectedSites.length > 0
          && expectedSites.every((s) => p.received_by_site.has(s.id)),
        missing_site_ids: expectedSites.filter((s) => !p.received_by_site.has(s.id)).map((s) => s.id),
      }))
      .sort((a, b) => (b.period_year - a.period_year) || (b.period_month - a.period_month))
      .slice(0, 12); // last 12 periods
  }, [archives, expectedSites]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1400px] mx-auto px-8 py-10 space-y-8">
        <div className="border-b border-border pb-5">

          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            Sales Commission <em className="text-phosphor not-italic">archives</em>.
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3">
            {expectedSites.length} sites expected · last 12 periods · row complete when every site has reported
          </p>
        </div>

        {error && (
          <div
            className="relative overflow-hidden border border-border bg-card px-4 py-2.5"
            style={{ borderRadius: "12px" }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: "hsl(var(--destructive))", boxShadow: "0 0 10px hsla(0,72%,50%,0.3)" }}
            />
            <p className="font-mono text-xs text-destructive pl-2 flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-px flex-shrink-0" strokeWidth={1.75} />
              {error}
            </p>
          </div>
        )}

        <section className="bg-card border border-border p-6 space-y-4" style={{ borderRadius: "12px" }}>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1">
              Period × site grid
            </div>
            <h2 className="font-display text-xl text-foreground mb-1 flex items-center gap-2">
              <Archive className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
              Received by month
            </h2>
            <p className="text-sm text-muted-foreground">
              Each row is one commission period. Cells show the archive received from each site —
              click "Download" to fetch the PDF. A period is highlighted as complete when all
              {" "}{expectedSites.length} sites have reported.
            </p>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading archives…
            </div>
          ) : periods.length === 0 ? (
            <div className="border border-dashed border-border px-4 py-6 text-center" style={{ borderRadius: "8px" }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                No archives yet
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                No site has pushed a commission archive yet.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    <th className="py-2 pr-4 sticky left-0 bg-card cursor-help" title="Calendar month the commission archives belong to (24th → 23rd cycle)">Period</th>
                    <th className="py-2 pr-4 cursor-help" title="Completeness: green when all expected sites have reported for the period; amber if any are still missing">Status</th>
                    {expectedSites.map((s) => (
                      <th
                        key={s.id}
                        className="py-2 px-3 text-left whitespace-nowrap cursor-help"
                        title={`Per-month PDF reported by site ${s.name || s.id}. Click a cell to download.`}
                      >
                        {s.name || s.id}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <PeriodRow
                      key={p.key}
                      period={p}
                      expectedSites={expectedSites}
                      onDownload={handleDownload}
                      downloadingId={downloadingId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function PeriodRow({ period, expectedSites, onDownload, downloadingId }) {
  const label = `${MONTH_NAMES[period.period_month - 1] || period.period_month} ${period.period_year}`;
  return (
    <tr
      className={`border-b border-border/40 last:border-b-0 ${
        period.complete ? "bg-amber-500/[0.04]" : ""
      }`}
    >
      <td className="py-2.5 pr-4 font-mono text-xs text-foreground sticky left-0 bg-card">
        {label}
      </td>
      <td className="py-2.5 pr-4">
        <CompletenessPill complete={period.complete} received={period.received_count} expected={period.expected_count} />
      </td>
      {expectedSites.map((s) => {
        const archive = period.received_by_site.get(s.id);
        return (
          <td key={s.id} className="py-2.5 px-3 align-top">
            {archive ? (
              <SiteCell archive={archive} onDownload={onDownload} downloadingId={downloadingId} />
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-400/80">
                missing
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function SiteCell({ archive, onDownload, downloadingId }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] text-muted-foreground" title={archive.filename}>
        {formatTs(archive.generated_at)}
      </div>
      <button
        onClick={() => onDownload(archive.id, archive.filename)}
        disabled={downloadingId === archive.id}
        className="inline-flex items-center gap-1 px-2 py-1 border border-border font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors disabled:opacity-50"
        style={{ borderRadius: "6px" }}
        title={archive.filename}
      >
        {downloadingId === archive.id
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <Download className="h-3 w-3" strokeWidth={1.75} />}
        PDF
      </button>
    </div>
  );
}

function CompletenessPill({ complete, received, expected }) {
  if (complete) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
        style={{
          borderRadius: "4px",
          background: "hsla(33,95%,55%,0.12)",
          color: "var(--phosphor)",
        }}
      >
        <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
        {received}/{expected}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      style={{
        borderRadius: "4px",
        background: "hsla(0,0%,100%,0.06)",
        color: "hsl(var(--muted-foreground))",
      }}
    >
      {received}/{expected}
    </span>
  );
}

function formatTs(s) {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
