import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Printer, FileDown, RefreshCw, AlertTriangle, Tag, Settings as SettingsIcon } from "lucide-react";
import { toast } from "sonner";

const COMMODITY_LABELS = { '1': 'Sweets', '2': 'Cigarettes', '3': 'Tobacco', '4': 'Mixed' };

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const formatPrice = (v) => {
  if (v == null) return "—";
  const n = parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export default function PriceList() {
  const [priceList, setPriceList] = useState("");
  const [commodity, setCommodity] = useState("all");
  const [supplier, setSupplier] = useState("all");
  const [search, setSearch] = useState("");
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const lists = useQuery({
    queryKey: ["pricing-lists"],
    queryFn: () => apiFetch("/api/pricing/lists"),
  });

  // Pick a default price list as soon as we have one. Prefer "STD"
  // (the standard/master list) when it's present; otherwise fall back
  // to the first code returned by Sage so the page never sits empty.
  // useQuery v5 doesn't fire onSuccess on cached responses, so we react
  // to the data presence directly.
  if (!priceList && lists.data?.lists?.length) {
    const codes = lists.data.lists.map(l => l.code);
    const preferred = codes.includes("STD") ? "STD" : codes[0];
    setTimeout(() => setPriceList(preferred), 0);
  }

  const items = useQuery({
    queryKey: ["pricing-items", priceList, commodity, supplier],
    queryFn: () => {
      const params = new URLSearchParams({ price_list: priceList });
      if (commodity !== "all") params.set("commodity", commodity);
      if (supplier !== "all") params.set("supplier", supplier);
      return apiFetch(`/api/pricing/items?${params}`);
    },
    enabled: !!priceList,
    staleTime: 60_000,
  });

  const suppliers = useQuery({
    queryKey: ["pricing-suppliers"],
    queryFn: () => apiFetch("/api/pricing/suppliers"),
    staleTime: 300_000,
  });

  const depot = useQuery({
    queryKey: ["depot-profile"],
    queryFn: () => apiFetch("/api/depot-profile"),
    staleTime: 300_000,
  });

  // Pill is visible to all price-list users. When clicked, we check
  // admin status — non-admins get a clear toast explaining the gate
  // instead of a silent no-op.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch("/api/auth/me"),
    staleTime: 300_000,
  });
  const canManageExclusions = me.data?.role === "admin";

  const openExclusionsSettings = () => {
    if (!canManageExclusions) {
      toast.error("Admin only", {
        description: "Managing price-list exclusions is an admin-only setting. Ask an administrator to add or remove patterns.",
      });
      return;
    }
    window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "pricelist" } }));
  };

  const filteredRows = useMemo(() => {
    const rows = items.data?.items || [];
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(r =>
      String(r.item_number).toLowerCase().includes(q) ||
      String(r.item_description).toLowerCase().includes(q)
    );
  }, [items.data, search]);

  // Both Print and Download go through the same PDF generator so paper
  // and downloaded file look identical. Browser window.print is never
  // used — it pulls in the app chrome and produces customer-unsuitable
  // output.
  const buildPdf = async () => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    await generatePdf({
      doc, autoTable,
      depot: depot.data?.profile || {},
      priceList,
      rows: filteredRows,
      commodityLabel: commodity === "all" ? "All commodities" : (COMMODITY_LABELS[commodity] || commodity),
      supplierLabel: supplier === "all" ? null : supplier,
    });
    return doc;
  };

  const handlePrint = async () => {
    setGeneratingPdf(true);
    try {
      const doc = await buildPdf();
      // autoPrint() embeds a print directive that fires when the PDF
      // opens. Saving to a blob URL in a new tab keeps the source page
      // clean and lets the operator review before printing.
      doc.autoPrint();
      const url = doc.output("bloburl");
      window.open(url, "_blank");
    } catch (err) {
      toast.error("Print failed", { description: err.message });
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handlePdf = async () => {
    setGeneratingPdf(true);
    try {
      const doc = await buildPdf();
      const cl = commodity === "all" ? "" : ` - ${COMMODITY_LABELS[commodity] || commodity}`;
      const sl = supplier === "all" ? "" : ` - ${supplier}`;
      doc.save(`Price List ${priceList}${cl}${sl} - ${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      toast.error("PDF generation failed", { description: err.message });
    } finally {
      setGeneratingPdf(false);
    }
  };

  const depotData = depot.data?.profile || {};
  const todayLong = new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric" });
  const commodityLabel = commodity === "all" ? "All commodities" : (COMMODITY_LABELS[commodity] || commodity);

  return (
    <div className="px-6 py-5 print:px-10 print:py-8">
      {/* Print-only letterhead — invisible on screen, becomes the header
          when the operator hits Ctrl+P or the Print button. Mirrors the
          PDF letterhead so paper and PDF look the same. */}
      <div className="hidden print:block mb-6">
        <div className="flex items-start justify-between">
          <img src="/cardoso-logo.png" alt="Cardoso" className="h-12" />
          <div className="text-right text-[10pt] leading-tight text-slate-700">
            {depotData.name && <div className="font-bold text-[11pt] text-slate-900 mb-1">{depotData.name}</div>}
            {depotData.address_line1 && <div>{depotData.address_line1}</div>}
            {depotData.address_line2 && <div>{depotData.address_line2}</div>}
            {(depotData.city || depotData.postal_code) && <div>{[depotData.city, depotData.postal_code].filter(Boolean).join(" ")}</div>}
            {depotData.phone && <div>Tel: {depotData.phone}</div>}
            {depotData.email && <div>{depotData.email}</div>}
            {depotData.vat_number && <div>VAT: {depotData.vat_number}</div>}
            {depotData.registration_number && <div>Reg: {depotData.registration_number}</div>}
          </div>
        </div>
        <div className="border-b-2 border-orange-500 mt-3 mb-5" />
        <div className="flex items-end justify-between">
          <h1 className="text-[20pt] font-bold text-slate-900 leading-none">Price List</h1>
          <div className="text-[10pt] text-slate-600 leading-snug text-right">
            <div>Price list: <span className="font-semibold text-slate-900">{priceList}</span></div>
            <div>Commodity: {commodityLabel}</div>
            <div>Issued: {todayLong}</div>
            <div>Items: {filteredRows.length.toLocaleString("en-ZA")}</div>
          </div>
        </div>
      </div>

      {/* Header — matches the editorial style used on Inventory Movement
          and other module pages (mono eyebrow → display title with
          phosphor emphasis → sentence-length subtitle). */}
      <div className="border-b border-border pb-5 mb-5 print:hidden">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Price List</div>
        <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
          The <em className="text-phosphor">catalogue</em>, ready to send.
        </h1>
        <p className="text-sm text-muted-foreground mt-3">
          Selling prices sourced live from Sage. Choose a price list and commodity, then print or download a customer-ready PDF.
          {filteredRows.length > 0 && (
            <span className="ml-2 text-muted-foreground/70">
              · {filteredRows.length.toLocaleString("en-ZA")} items{priceList ? ` · ${priceList}` : ""}
            </span>
          )}
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap mb-4 print:hidden">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Price list</label>
          <select
            value={priceList}
            onChange={(e) => setPriceList(e.target.value)}
            disabled={lists.isLoading}
            className="h-8 rounded-full border border-border bg-card px-3 text-xs text-foreground"
          >
            {(lists.data?.lists || []).map((l) => (
              <option key={l.code} value={l.code}>
                {l.code} ({l.item_count})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Commodity</label>
          <select
            value={commodity}
            onChange={(e) => setCommodity(e.target.value)}
            className="h-8 rounded-full border border-border bg-card px-3 text-xs text-foreground"
          >
            <option value="all">All</option>
            {Object.entries(COMMODITY_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </div>

        {/* Supplier — derived from latest Sage PO receipt per item.
            Hidden if no suppliers have been synced yet (no stock_receipt
            rows). Items never received via PO won't appear under any
            supplier; use "All" to see them. */}
        {(suppliers.data?.suppliers || []).length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Supplier</label>
            <select
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className="h-8 rounded-full border border-border bg-card px-3 text-xs text-foreground min-w-[260px]"
            >
              <option value="all">All</option>
              {(suppliers.data?.suppliers || []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search item number or description…"
            className="w-full h-8 pl-8 pr-3 rounded-full border border-border bg-card text-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={openExclusionsSettings}
            title="Manage which item codes are hidden from price lists (admin only)"
            className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 px-3 py-1.5 text-xs hover:bg-amber-500/15 transition-colors"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            Exclusions in Settings
          </button>
          <button
            onClick={handlePrint}
            disabled={!filteredRows.length}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
          <button
            onClick={handlePdf}
            disabled={!filteredRows.length || generatingPdf}
            className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-400 px-3 py-1.5 text-xs hover:bg-amber-500/25 transition-colors disabled:opacity-50"
          >
            {generatingPdf ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
            Download PDF
          </button>
        </div>
      </div>

      {/* Body */}
      {(lists.isError || items.isError) && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="inline h-4 w-4 mr-1.5" />
          {lists.error?.message || items.error?.message}
        </div>
      )}

      {lists.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading price lists…
        </div>
      )}

      {!lists.isLoading && !lists.isError && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto max-h-[calc(100vh-260px)] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-card border-b border-border">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Item</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Description</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">Commodity</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">UOM</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Price (R)</th>
                </tr>
              </thead>
              <tbody>
                {items.isLoading && (
                  <tr><td colSpan={5} className="px-3 py-12 text-center text-muted-foreground"><RefreshCw className="inline h-4 w-4 animate-spin mr-2" /> Loading items…</td></tr>
                )}
                {!items.isLoading && filteredRows.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-12 text-center text-muted-foreground">
                    <Tag className="h-8 w-8 mx-auto mb-2 opacity-60" />
                    No items match the current filters.
                  </td></tr>
                )}
                {filteredRows.map((r, i) => (
                  <tr key={`${r.item_number}-${r.uom}`} className={`border-b border-border last:border-0 ${i % 2 === 0 ? "" : "bg-muted/10"} hover:bg-muted/20`}>
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{r.item_number}</td>
                    <td className="px-3 py-2">{r.item_description || "—"}</td>
                    <td className="px-3 py-2 text-center text-muted-foreground">{COMMODITY_LABELS[r.commodity] || r.commodity || "—"}</td>
                    <td className="px-3 py-2 text-center text-muted-foreground">{r.uom || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">R {formatPrice(r.price)}</td>
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

// ── PDF generator ───────────────────────────────────────────────────
// Customer-facing letterhead + autotable. Both Print and Download
// buttons route here so paper and downloaded file look identical.

async function generatePdf({ doc, autoTable, depot, priceList, rows, commodityLabel, supplierLabel }) {
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = { left: 8, right: 8, top: 8, bottom: 8 };
  const ORANGE = [249, 115, 22];
  const SLATE = [33, 41, 54];
  const SUBTLE = [108, 117, 134];
  const RULE = [225, 228, 234];

  const logoDataUrl = await loadImageAsDataUrl("/cardoso-logo.png").catch(() => null);
  const depotName = depot.name || "Cardoso Depots";

  // ── Letterhead ────────────────────────────────────────────────────
  const drawLetterhead = () => {
    // Logo (or text fallback)
    if (logoDataUrl) {
      try { doc.addImage(logoDataUrl, "PNG", M.left, M.top, 60, 24); } catch {}
    } else {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(28);
      doc.setTextColor(ORANGE[0], ORANGE[1], ORANGE[2]);
      doc.text("CARDOSO", M.left, M.top + 10);
      doc.setFontSize(12);
      doc.setTextColor(SLATE[0], SLATE[1], SLATE[2]);
      doc.text("DEPOTS", M.left, M.top + 16);
    }

    // Depot block (right-aligned)
    const rightX = PAGE_W - M.right;
    let dy = M.top + 2;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(SLATE[0], SLATE[1], SLATE[2]);
    doc.text(depotName, rightX, dy, { align: "right" });
    dy += 4.6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(SUBTLE[0], SUBTLE[1], SUBTLE[2]);
    const lines = [
      depot.address_line1,
      depot.address_line2,
      [depot.city, depot.postal_code].filter(Boolean).join(" "),
      depot.phone && `Tel ${depot.phone}`,
      depot.email,
      depot.vat_number && `VAT  ${depot.vat_number}`,
      depot.registration_number && `Reg  ${depot.registration_number}`,
    ].filter(Boolean);
    for (const ln of lines) { doc.text(ln, rightX, dy, { align: "right" }); dy += 3.7; }

    // Orange accent rule — clears the bottom of the 24mm logo
    const ruleY = Math.max(dy + 2, M.top + 28);
    doc.setDrawColor(ORANGE[0], ORANGE[1], ORANGE[2]);
    doc.setLineWidth(0.7);
    doc.line(M.left, ruleY, PAGE_W - M.right, ruleY);

    return ruleY;
  };

  // ── Title block ───────────────────────────────────────────────────
  const drawTitleBlock = (yStart) => {
    // Eyebrow label — small uppercase orange tag above the title for a
    // refined editorial feel. Letter-spaced to give it air.
    const eyebrowY = yStart + 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(ORANGE[0], ORANGE[1], ORANGE[2]);
    doc.setCharSpace(1.2);
    doc.text("WHOLESALE PRICING", M.left, eyebrowY);
    doc.setCharSpace(0);

    // Main title — Times for a softer, more editorial feel than the
    // chunky Helvetica Bold, set larger to anchor the page.
    let y = eyebrowY + 9;
    doc.setFont("times", "bold");
    doc.setFontSize(30);
    doc.setTextColor(SLATE[0], SLATE[1], SLATE[2]);
    doc.text("Price List", M.left, y);

    // Meta panel on the right (boxed key:value rows). Supplier is an
    // internal filter and is deliberately NOT shown on customer-facing
    // documents — the price list reads as a complete list to the
    // customer regardless of which supplier filter was applied.
    const meta = [
      ["Price list", priceList],
      ["Commodity", commodityLabel],
      ["Issued",   new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric" })],
      ["Items",    rows.length.toLocaleString("en-ZA")],
    ];
    const panelW = 80;
    const padX = 5;
    const padTop = 5;
    const rowGap = 5.2;
    const panelH = padTop + meta.length * rowGap + 2;
    const panelX = PAGE_W - M.right - panelW;
    const panelY = y - 6;

    doc.setFillColor(248, 249, 251);
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.2);
    doc.roundedRect(panelX, panelY, panelW, panelH, 1.5, 1.5, "FD");

    doc.setFontSize(9);
    let my = panelY + padTop;
    for (const [k, v] of meta) {
      doc.setFont("helvetica", "normal");
      doc.setTextColor(SUBTLE[0], SUBTLE[1], SUBTLE[2]);
      doc.text(String(k).toUpperCase(), panelX + padX, my);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(SLATE[0], SLATE[1], SLATE[2]);
      doc.text(String(v), panelX + panelW - padX, my, { align: "right" });
      my += rowGap;
    }

    return Math.max(y + 8, panelY + panelH + 6);
  };

  // ── Render page 1 letterhead + title ─────────────────────────────
  const ruleY = drawLetterhead();
  const tableStartY = drawTitleBlock(ruleY);

  // ── Table ─────────────────────────────────────────────────────────
  const body = rows.map(r => [
    r.item_number,
    r.item_description || "",
    COMMODITY_LABELS[r.commodity] || r.commodity || "",
    r.uom || "",
    `R ${formatPrice(r.price)}`,
  ]);

  autoTable(doc, {
    startY: tableStartY,
    // Top margin is the floor for the table on continuation pages; it
    // must clear the redrawn letterhead + "continued" text. Letterhead
    // height is ~32mm (logo + rule), plus 8mm for the continued title.
    margin: { left: M.left, right: M.right, top: M.top + 42, bottom: M.bottom + 10 },
    head: [["Item", "Description", "Commodity", "UOM", "Price"]],
    body,
    theme: "striped",
    headStyles: {
      fillColor: SLATE,
      textColor: 255,
      fontStyle: "bold",
      halign: "left",
      fontSize: 9,
      cellPadding: { top: 2.2, right: 3, bottom: 2.2, left: 3 },
    },
    bodyStyles: {
      fontSize: 9,
      textColor: SLATE,
      cellPadding: { top: 1.8, right: 3, bottom: 1.8, left: 3 },
      lineColor: RULE,
      lineWidth: 0.1,
    },
    alternateRowStyles: { fillColor: [249, 250, 252] },
    columnStyles: {
      0: { cellWidth: 22, font: "courier", fontStyle: "bold" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 24, halign: "left" },
      3: { cellWidth: 14, halign: "center" },
      4: { cellWidth: 26, halign: "right", fontStyle: "bold" },
    },
    // willDrawPage fires BEFORE the page content is laid down, so the
    // letterhead paints under the (yet-to-come) table header rather
    // than over it. Page 1 already has its letterhead from earlier;
    // skip it here to avoid double-painting.
    willDrawPage: (data) => {
      if (data.pageNumber > 1) {
        const r = drawLetterhead();
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(SLATE[0], SLATE[1], SLATE[2]);
        doc.text(`Price List  ·  ${priceList}  (continued)`, M.left, r + 7);
      }
    },
    // Footer fires after the page is laid out. Two jobs:
    //   1. Paint white wedge masks over the four table corners + an
    //      outline rounded-rect so the table reads as a card with
    //      rounded corners (autotable can't render those natively).
    //   2. Footer strip with depot name + page numbers.
    didDrawPage: (data) => {
      // ── Rounded corners overlay ──
      const cornerR = 2.5;
      const tableLeft = M.left;
      const tableRight = PAGE_W - M.right;
      const tableTop = data.pageNumber === 1
        ? tableStartY
        : M.top + 42; // margin.top from settings
      const tableBottom = data.cursor.y;
      // White wedges in each corner (chamfer ≈ rounded at small radius).
      doc.setFillColor(255, 255, 255);
      doc.triangle(tableLeft, tableTop, tableLeft + cornerR, tableTop, tableLeft, tableTop + cornerR, "F");
      doc.triangle(tableRight, tableTop, tableRight - cornerR, tableTop, tableRight, tableTop + cornerR, "F");
      doc.triangle(tableLeft, tableBottom, tableLeft + cornerR, tableBottom, tableLeft, tableBottom - cornerR, "F");
      doc.triangle(tableRight, tableBottom, tableRight - cornerR, tableBottom, tableRight, tableBottom - cornerR, "F");
      // Outline rounded rect to clean up the chamfer edges.
      doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
      doc.setLineWidth(0.3);
      doc.roundedRect(tableLeft, tableTop, tableRight - tableLeft, tableBottom - tableTop, cornerR, cornerR, "S");

      // ── Footer ──
      const total = doc.internal.getNumberOfPages();
      doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
      doc.setLineWidth(0.2);
      doc.line(M.left, PAGE_H - M.bottom + 2, PAGE_W - M.right, PAGE_H - M.bottom + 2);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(SUBTLE[0], SUBTLE[1], SUBTLE[2]);
      doc.text(`${depotName}  ·  Price list ${priceList}`, M.left, PAGE_H - M.bottom + 6);
      doc.text(`Page ${data.pageNumber} of ${total}`, PAGE_W - M.right, PAGE_H - M.bottom + 6, { align: "right" });
    },
  });

  // Page numbers can only be totalled after the table is fully laid out.
  // Repaint the right-side footer text with the final total on every page.
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(255, 255, 255);
    doc.rect(PAGE_W - M.right - 35, PAGE_H - M.bottom + 3, 35, 5, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(SUBTLE[0], SUBTLE[1], SUBTLE[2]);
    doc.text(`Page ${p} of ${totalPages}`, PAGE_W - M.right, PAGE_H - M.bottom + 6, { align: "right" });
  }
}

async function loadImageAsDataUrl(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`Logo fetch failed: ${r.status}`);
  const blob = await r.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
