import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Calendar, Download, FileSpreadsheet, Loader2, PlayCircle, Receipt, Settings } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/AuthContext";

// Format helpers — keep R-prefixed amounts compact + thousands-separated,
// matching the legacy spreadsheet ("R 104,105.00").
function formatRand(n) {
  const v = Number.isFinite(n) ? n : 0;
  return `R ${v.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatPct(rate) {
  const v = Number.isFinite(rate) ? rate : 0;
  return `${(v * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

// Default to the same one-month window the spreadsheet uses (24th of the
// previous month -> 23rd of this month). Operators can drag either end.
function defaultRange() {
  const today = new Date();
  const to = new Date(today.getFullYear(), today.getMonth(), 23);
  const from = new Date(today.getFullYear(), today.getMonth() - 1, 24);
  if (to > today) {
    to.setMonth(to.getMonth() - 1);
    from.setMonth(from.getMonth() - 1);
  }
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default function SalesCommission() {
  const initial = defaultRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  // Holds the range last submitted so editing the inputs doesn't refetch
  // until the operator hits "Generate".
  const [submitted, setSubmitted] = useState(initial);

  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const queryClient = useQueryClient();

  const report = useQuery({
    queryKey: ["commission-report", submitted.from, submitted.to],
    queryFn: async () => {
      const r = await fetch(`/api/commission/report?from=${submitted.from}&to=${submitted.to}`, {
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `Failed (${r.status})`);
      }
      return r.json();
    },
    enabled: Boolean(submitted.from && submitted.to),
    staleTime: 60_000,
  });

  // Branch name used in PDF heading + filename — same source as the
  // price list's letterhead so the two stay in sync.
  const depotProfile = useQuery({
    queryKey: ["depot-profile"],
    queryFn: async () => {
      const r = await fetch("/api/depot-profile", { credentials: "include" });
      if (!r.ok) return { profile: {} };
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const depotName = depotProfile.data?.profile?.name?.trim() || "";

  // Past commission archives — populated by the monthly cron (24th of
  // each month) plus any operator-triggered "Run now" calls.
  const archives = useQuery({
    queryKey: ["commission-archives"],
    queryFn: async () => {
      const r = await fetch("/api/commission/archives?limit=60", { credentials: "include" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    staleTime: 30_000,
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/commission/archives/run-now", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (res) => {
      if (res?.status === "archived") {
        toast.success(`Archived ${res.period?.year}-${String(res.period?.month).padStart(2, "0")} (#${res.archiveId})`);
      } else {
        toast.info(`Run skipped: ${res?.reason || "no work to do"}`);
      }
      queryClient.invalidateQueries({ queryKey: ["commission-archives"] });
    },
    onError: (err) => toast.error(`Run-now failed: ${err.message}`),
  });

  const downloadArchive = async (id, filename) => {
    try {
      const r = await fetch(`/api/commission/archives/${id}/download`, { credentials: "include" });
      if (!r.ok) {
        let message = `HTTP ${r.status}`;
        try { message = (await r.json()).error || message; }
        catch (e) { console.error("[salesCommission.archive_download_parse]", { id }, e.message); }
        throw new Error(message);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || `Commission_archive_${id}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      toast.error(`Archive download failed: ${err.message}`);
    }
  };

  const data = report.data;
  const reps = data?.reps || [];
  const totals = data?.totals;
  const settings = data?.settings;

  const headerTitle = useMemo(() => {
    if (!submitted.from || !submitted.to) return "Commission Sales Report";
    return `Commission Sales Report — ${submitted.from} to ${submitted.to}`;
  }, [submitted.from, submitted.to]);

  const onGenerate = (e) => {
    e?.preventDefault?.();
    if (!from || !to) {
      toast.error("Pick a date range first");
      return;
    }
    if (from > to) {
      toast.error("'From' must be on or before 'To'");
      return;
    }
    setSubmitted({ from, to });
  };

  const exportExcel = useMutation({
    mutationFn: async () => {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const sweetsRate = settings?.sweets_rate ?? 0.015;
      const cigtobRate = settings?.cigtob_rate ?? 0.0017;
      const refRate = settings?.reference_rate ?? 0.01;
      // Mirror the spreadsheet layout: two stacked sections (raw figures
      // up top, commission calculations below) so the file lands in an
      // operator's email looking the same as the legacy report.
      const sheet = [
        ...(depotName ? [[depotName]] : []),
        [headerTitle],
        [],
        ["Sales Person", "Sweet Sales", "Credits", "Net Sweets", "Customer Payment Total", "Cig + Tob Base"],
        ...reps.map(r => [
          r.sales_rep, r.sweet_sales, r.sweet_credits, r.net_sweets, r.customer_payments, r.cig_tob_base,
        ]),
        ["TOTAL", totals?.sweet_sales ?? 0, totals?.sweet_credits ?? 0, totals?.net_sweets ?? 0, totals?.customer_payments ?? 0, totals?.cig_tob_base ?? 0],
        [],
        ["Sales Person", "Net Sweets", `Sweets ${formatPct(sweetsRate)}`, `Ref ${formatPct(refRate)}`, "Cig + Tob Base", `Cig+Tob ${formatPct(cigtobRate)}`, "Total Commission"],
        ...reps.map(r => [
          r.sales_rep, r.net_sweets, r.sweet_commission, r.reference_commission, r.cig_tob_base, r.cigtob_commission, r.total_commission,
        ]),
        ["TOTAL", totals?.net_sweets ?? 0, totals?.sweet_commission ?? 0, totals?.reference_commission ?? 0, totals?.cig_tob_base ?? 0, totals?.cigtob_commission ?? 0, totals?.total_commission ?? 0],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheet);
      XLSX.utils.book_append_sheet(wb, ws, "Commission");
      const prefix = depotName ? `${depotName} Commission` : "Commission";
      const fname = `${prefix} ${submitted.from} to ${submitted.to}.xlsx`;
      XLSX.writeFile(wb, fname);
      return fname;
    },
    onSuccess: (fname) => toast.success(`Saved ${fname}`),
    onError: (err) => toast.error(`Excel export failed: ${err.message}`),
  });

  const exportPdf = useMutation({
    mutationFn: async () => {
      const { jsPDF } = await import("jspdf");
      const autoTable = (await import("jspdf-autotable")).default;
      const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
      const sweetsRate = settings?.sweets_rate ?? 0.015;
      const cigtobRate = settings?.cigtob_rate ?? 0.0017;
      const refRate = settings?.reference_rate ?? 0.01;
      if (depotName) {
        doc.setFontSize(11);
        doc.setTextColor(80);
        doc.text(depotName, 14, 12);
      }
      doc.setFontSize(14);
      doc.setTextColor(0);
      doc.text(headerTitle, 14, depotName ? 19 : 14);
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.text(
        `Sweets rate ${formatPct(sweetsRate)} · Cig+Tob rate ${formatPct(cigtobRate)} · Reference rate ${formatPct(refRate)}`,
        14, depotName ? 25 : 20,
      );
      autoTable(doc, {
        startY: depotName ? 31 : 26,
        head: [["Sales Person", "Sweet Sales", "Credits", "Net Sweets", "Customer Payment Total", "Cig + Tob Base"]],
        body: [
          ...reps.map(r => [
            r.sales_rep, formatRand(r.sweet_sales), formatRand(r.sweet_credits),
            formatRand(r.net_sweets), formatRand(r.customer_payments), formatRand(r.cig_tob_base),
          ]),
          ["TOTAL", formatRand(totals?.sweet_sales), formatRand(totals?.sweet_credits),
            formatRand(totals?.net_sweets), formatRand(totals?.customer_payments), formatRand(totals?.cig_tob_base)],
        ],
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [33, 33, 33] },
        footStyles: { fillColor: [60, 60, 60] },
        columnStyles: { 0: { fontStyle: "bold" } },
      });
      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 8,
        head: [["Sales Person", "Net Sweets", `Sweets ${formatPct(sweetsRate)}`, `Ref ${formatPct(refRate)}`, "Cig + Tob Base", `Cig+Tob ${formatPct(cigtobRate)}`, "Total"]],
        body: [
          ...reps.map(r => [
            r.sales_rep, formatRand(r.net_sweets), formatRand(r.sweet_commission),
            formatRand(r.reference_commission), formatRand(r.cig_tob_base),
            formatRand(r.cigtob_commission), formatRand(r.total_commission),
          ]),
          ["TOTAL", formatRand(totals?.net_sweets), formatRand(totals?.sweet_commission),
            formatRand(totals?.reference_commission), formatRand(totals?.cig_tob_base),
            formatRand(totals?.cigtob_commission), formatRand(totals?.total_commission)],
        ],
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [33, 33, 33] },
      });
      const prefix = depotName ? `${depotName} Commission` : "Commission";
      const fname = `${prefix} ${submitted.from} to ${submitted.to}.pdf`;
      doc.save(fname);
      return fname;
    },
    onSuccess: (fname) => toast.success(`Saved ${fname}`),
    onError: (err) => toast.error(`PDF export failed: ${err.message}`),
  });

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "commission" } }));
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Receipt className="w-6 h-6 text-amber-500" />
          <h1 className="text-2xl font-semibold">Sales Commission</h1>
        </div>
        <button
          onClick={openSettings}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card hover:bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
          title="Edit rates in Settings"
        >
          <Settings className="w-3.5 h-3.5" />
          Rates
        </button>
      </div>

      <form
        onSubmit={onGenerate}
        className="rounded-xl border border-border bg-card px-4 py-3 mb-4 flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col">
          <label className="text-xs text-muted-foreground mb-1">From</label>
          <div className="relative">
            <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="pl-7 pr-2 py-1.5 bg-background border border-border rounded-md text-sm"
            />
          </div>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-muted-foreground mb-1">To</label>
          <div className="relative">
            <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="pl-7 pr-2 py-1.5 bg-background border border-border rounded-md text-sm"
            />
          </div>
        </div>
        <button
          type="submit"
          className="rounded-md bg-amber-500 text-black hover:bg-amber-400 px-4 py-1.5 text-sm font-medium"
          disabled={report.isFetching}
        >
          {report.isFetching ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}
          Generate
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => exportExcel.mutate()}
            disabled={!data || exportExcel.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card hover:bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Excel
          </button>
          <button
            type="button"
            onClick={() => exportPdf.mutate()}
            disabled={!data || exportPdf.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card hover:bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            PDF
          </button>
        </div>
      </form>

      {report.isError && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 text-red-300 px-4 py-3 mb-4 text-sm">
          {String(report.error?.message || "Failed to load report")}
        </div>
      )}

      {report.isLoading && (
        <div className="rounded-xl border border-border bg-card px-4 py-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          Querying Sage for the selected period…
        </div>
      )}

      {data && (
        <>
          <ReportTable
            title="Period figures"
            sectionHeader={null}
            columns={[
              { label: "Sales Person", className: "text-left font-semibold", get: (r) => r.sales_rep },
              { label: "Sweet Sales", className: "text-right tabular-nums", get: (r) => formatRand(r.sweet_sales) },
              { label: "Credits", className: "text-right tabular-nums", get: (r) => formatRand(r.sweet_credits) },
              { label: "Net Sweets", className: "text-right tabular-nums text-amber-300", get: (r) => formatRand(r.net_sweets) },
              { label: "Customer Payment Total", className: "text-right tabular-nums", get: (r) => formatRand(r.customer_payments) },
              { label: "Cig + Tob Base", className: "text-right tabular-nums text-amber-300", get: (r) => formatRand(r.cig_tob_base) },
            ]}
            reps={reps}
            totalRow={totals && [
              "TOTAL", formatRand(totals.sweet_sales), formatRand(totals.sweet_credits),
              formatRand(totals.net_sweets), formatRand(totals.customer_payments), formatRand(totals.cig_tob_base),
            ]}
          />

          <ReportTable
            title="Commission calculation"
            sectionHeader={
              <div className="text-xs text-muted-foreground">
                Sweets <span className="text-amber-300">{formatPct(settings?.sweets_rate)}</span> · Cig+Tob{" "}
                <span className="text-amber-300">{formatPct(settings?.cigtob_rate)}</span> · Reference{" "}
                <span className="text-amber-300">{formatPct(settings?.reference_rate)}</span>
              </div>
            }
            columns={[
              { label: "Sales Person", className: "text-left font-semibold", get: (r) => r.sales_rep },
              { label: "Net Sweets", className: "text-right tabular-nums", get: (r) => formatRand(r.net_sweets) },
              { label: `Sweets ${formatPct(settings?.sweets_rate)}`, className: "text-right tabular-nums text-amber-300", get: (r) => formatRand(r.sweet_commission) },
              { label: `Reference ${formatPct(settings?.reference_rate)}`, className: "text-right tabular-nums text-muted-foreground", get: (r) => formatRand(r.reference_commission) },
              { label: "Cig + Tob Base", className: "text-right tabular-nums", get: (r) => formatRand(r.cig_tob_base) },
              { label: `Cig+Tob ${formatPct(settings?.cigtob_rate)}`, className: "text-right tabular-nums text-amber-300", get: (r) => formatRand(r.cigtob_commission) },
              { label: "Total Commission", className: "text-right tabular-nums font-semibold text-emerald-300", get: (r) => formatRand(r.total_commission) },
            ]}
            reps={reps}
            totalRow={totals && [
              "TOTAL", formatRand(totals.net_sweets), formatRand(totals.sweet_commission),
              formatRand(totals.reference_commission), formatRand(totals.cig_tob_base),
              formatRand(totals.cigtob_commission), formatRand(totals.total_commission),
            ]}
          />
        </>
      )}

      <ArchivesPanel
        archives={archives.data?.archives || []}
        loading={archives.isLoading}
        error={archives.isError ? String(archives.error?.message || "Failed to load archives") : ""}
        isAdmin={isAdmin}
        onRunNow={() => runNow.mutate()}
        runNowPending={runNow.isPending}
        onDownload={downloadArchive}
      />
    </div>
  );
}

// Past commission archives — same period covered as the report above,
// but persisted on disk + pushed to the hub. The monthly cron writes
// 'scheduled' rows on the 24th; admins can ad-hoc-trigger a run via
// the "Run now" button (creates an additional 'manual' or 'scheduled'
// row depending on whether one already exists for the period).
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function formatPeriod(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  return `${MONTH_NAMES[month - 1]} ${year}`;
}
function formatTs(s) {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function ArchivesPanel({ archives, loading, error, isAdmin, onRunNow, runNowPending, onDownload }) {
  return (
    <div className="rounded-xl border border-border bg-card mb-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Archive className="w-4 h-4 text-muted-foreground" />
          Archives
        </h2>
        {isAdmin && (
          <button
            type="button"
            onClick={onRunNow}
            disabled={runNowPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card hover:bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
            title="Generate the commission archive for the current period now"
          >
            {runNowPending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <PlayCircle className="w-3.5 h-3.5" />}
            Run now
          </button>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-300 bg-red-500/10 border-b border-red-500/40">
          {error}
        </div>
      )}

      {loading ? (
        <div className="px-4 py-6 text-center text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
          Loading archives…
        </div>
      ) : archives.length === 0 ? (
        <div className="px-4 py-6 text-center text-muted-foreground text-sm">
          No archives yet. The monthly cron fires on the 24th of each month;
          admins can trigger a run on demand with "Run now".
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card">
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Period</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Generated</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Source</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Hub push</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Download</th>
              </tr>
            </thead>
            <tbody>
              {archives.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-1.5 font-medium text-foreground">
                    {formatPeriod(a.period_year, a.period_month)}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {formatTs(a.generated_at)}
                  </td>
                  <td className="px-3 py-1.5">
                    <SourceBadge source={a.source} />
                  </td>
                  <td className="px-3 py-1.5">
                    <HubPushBadge status={a.hub_push_status} error={a.hub_push_error} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => onDownload(a.id, a.filename)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-card hover:bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
                      title={a.filename}
                    >
                      <Download className="w-3 h-3" />
                      PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SourceBadge({ source }) {
  const isScheduled = source === "scheduled";
  return (
    <span
      className={`inline-block px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide rounded ${
        isScheduled
          ? "bg-amber-500/15 text-amber-300"
          : "bg-muted/40 text-muted-foreground"
      }`}
    >
      {source || "—"}
    </span>
  );
}

function HubPushBadge({ status, error }) {
  const map = {
    pushed:           { label: "pushed",   cls: "bg-emerald-500/15 text-emerald-300" },
    pending:          { label: "pending",  cls: "bg-muted/40 text-muted-foreground" },
    failed:           { label: "failed",   cls: "bg-red-500/15 text-red-300" },
    skipped_no_hub:   { label: "no hub",   cls: "bg-muted/40 text-muted-foreground" },
  };
  const cfg = map[status] || { label: status || "—", cls: "bg-muted/40 text-muted-foreground" };
  return (
    <span
      className={`inline-block px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide rounded ${cfg.cls}`}
      title={error || undefined}
    >
      {cfg.label}
    </span>
  );
}

function ReportTable({ title, sectionHeader, columns, reps, totalRow }) {
  return (
    <div className="rounded-xl border border-border bg-card mb-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {sectionHeader}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-card">
              {columns.map((c) => (
                <th key={c.label} className={`px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide ${c.className.includes("text-left") ? "text-left" : "text-right"}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reps.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground text-xs">
                  No commission activity for the selected period.
                </td>
              </tr>
            )}
            {reps.map((r) => (
              <tr key={r.sales_rep} className="border-b border-border last:border-0 hover:bg-muted/30">
                {columns.map((c) => (
                  <td key={c.label} className={`px-3 py-1.5 ${c.className}`}>
                    {c.get(r)}
                  </td>
                ))}
              </tr>
            ))}
            {totalRow && (
              <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                {totalRow.map((cell, idx) => (
                  <td key={idx} className={`px-3 py-2 ${idx === 0 ? "text-left" : "text-right tabular-nums"}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
