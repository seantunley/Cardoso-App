import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Barcode, Camera, RefreshCw, Search, Trash2, AlertTriangle, CheckCircle2, Info, Pencil, X, Check } from "lucide-react";
import { toast } from "sonner";
import BarcodeScanner, { cameraUnavailableReason } from "@/components/inventory/BarcodeScanner";
import CountTab from "@/components/inventory/stocktake/CountTab";
import SuperviseTab from "@/components/inventory/stocktake/SuperviseTab";

// Stock Take — the barcode map.
//
// Built for a phone held in one hand on a warehouse floor: one column, large
// targets, and an always-focused input so a Bluetooth (keyboard-wedge) scanner
// works with no taps at all.
//
// Sage is never written to from this screen. The only Sage traffic is the
// read-only item-list refresh.

const LOCATION_KEY = "stocktake.location";

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiSend(url, method, body) {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    Object.assign(err, data);
    throw err;
  }
  return data;
}

function num(v, dp = 0) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-ZA", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function money(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `R${Number(v).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Banner({ tone = "info", icon: Icon = Info, children }) {
  const tones = {
    info: "border-sky-500/40 bg-sky-500/10 text-sky-200",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    error: "border-red-500/40 bg-red-500/10 text-red-200",
    ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  };
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${tones[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export default function StockTake() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("count");
  const [location, setLocation] = useState(() => {
    try { return localStorage.getItem(LOCATION_KEY) || ""; } catch { return ""; }
  });
  const [entry, setEntry] = useState("");
  const [scanned, setScanned] = useState(/** @type {string | null} */ (null));
  const [cameraOpen, setCameraOpen] = useState(false);
  const [itemQuery, setItemQuery] = useState("");
  const [chosenItem, setChosenItem] = useState(/** @type {any} */ (null));
  // The unit the operator actually tapped, kept so a "re-point it anyway"
  // confirmation resends THAT unit rather than guessing at the first one.
  const [pendingUnit, setPendingUnit] = useState(/** @type {string | null} */ (null));
  const [mapSearch, setMapSearch] = useState("");
  // Editing the barcode ON a row — an imported number with a digit out, or a
  // supplier reprinting an outer. Re-pointing it at a different item is the
  // other job, done from the Scan tab.
  const [editingId, setEditingId] = useState(/** @type {number | null} */ (null));
  const [editValue, setEditValue] = useState("");
  const [editCamera, setEditCamera] = useState(false);
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  const cameraBlocked = useMemo(() => cameraUnavailableReason(), []);
  const debouncedItemQuery = useDebouncedValue(itemQuery, 250);
  const debouncedMapSearch = useDebouncedValue(mapSearch, 250);

  const meta = useQuery({ queryKey: ["stock-take-meta"], queryFn: () => apiFetch("/api/stock-take/meta") });
  const hubMode = meta.data?.hub === true;

  const sessionsQuery = useQuery({
    queryKey: ["stock-take-sessions"],
    queryFn: () => apiFetch("/api/stock-take/sessions"),
    enabled: !hubMode,
    refetchInterval: 30_000,
  });
  const canSupervise = sessionsQuery.data?.can_supervise === true;

  // Default the location to the only one, or the first, once the list arrives.
  useEffect(() => {
    const locs = meta.data?.locations;
    if (!locs?.length || location) return;
    setLocation(locs[0].location);
  }, [meta.data, location]);

  useEffect(() => {
    try { if (location) localStorage.setItem(LOCATION_KEY, location); } catch { /* private mode — not worth failing over */ }
  }, [location]);

  const lookup = useQuery({
    queryKey: ["stock-take-lookup", scanned, location],
    queryFn: () => apiFetch(`/api/stock-take/lookup?barcode=${encodeURIComponent(scanned || "")}&location=${encodeURIComponent(location)}`),
    enabled: Boolean(scanned) && !hubMode,
  });

  const items = useQuery({
    queryKey: ["stock-take-items", debouncedItemQuery, location],
    queryFn: () => apiFetch(`/api/stock-take/items?q=${encodeURIComponent(debouncedItemQuery)}&location=${encodeURIComponent(location)}`),
    enabled: debouncedItemQuery.trim().length >= 2 && !hubMode,
  });

  const units = useQuery({
    queryKey: ["stock-take-units", chosenItem?.item_number],
    queryFn: () => apiFetch(`/api/stock-take/items/${encodeURIComponent(chosenItem.item_number)}/units`),
    enabled: Boolean(chosenItem?.item_number),
  });

  const barcodes = useQuery({
    queryKey: ["stock-take-barcodes", debouncedMapSearch],
    queryFn: () => apiFetch(`/api/stock-take/barcodes?search=${encodeURIComponent(debouncedMapSearch)}`),
    enabled: tab === "map" && !hubMode,
  });

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["stock-take-meta"] });
    queryClient.invalidateQueries({ queryKey: ["stock-take-lookup"] });
    queryClient.invalidateQueries({ queryKey: ["stock-take-barcodes"] });
  }, [queryClient]);

  const syncItems = useMutation({
    mutationFn: () => apiSend("/api/stock-take/sync-items", "POST"),
    onSuccess: (r) => {
      toast.success(`Item list refreshed from Sage: ${num(r.rows)} item/unit rows.${r.orphanBarcodes ? ` ${r.orphanBarcodes} mapped barcode(s) now point at a unit Sage no longer has — check the Map tab.` : ""}`);
      refreshAll();
      queryClient.invalidateQueries({ queryKey: ["stock-take-items"] });
    },
    onError: (e) => toast.error(e.message),
  });

  const saveMapping = useMutation({
    mutationFn: (body) => apiSend("/api/stock-take/barcodes", "POST", body),
    onSuccess: (r) => {
      toast.success(r.changed ? `Barcode ${r.barcode} mapped to item ${r.item_number} (${r.unit}).` : `Barcode ${r.barcode} was already mapped to item ${r.item_number} (${r.unit}).`);
      setChosenItem(null);
      setPendingUnit(null);
      setItemQuery("");
      refreshAll();
      focusEntry();
    },
    onError: (e) => {
      if (e.code === "BARCODE_IN_USE") return; // handled inline with a confirm button
      toast.error(e.message);
    },
  });

  const changeBarcode = useMutation({
    mutationFn: ({ id, barcode }) => apiSend(`/api/stock-take/barcodes/${id}`, "PATCH", { barcode }),
    onSuccess: (r) => {
      toast.success(r.changed
        ? `Item ${r.item_number} now reads ${r.barcode} (was ${r.previous_barcode}).`
        : "That is already the barcode on this item.");
      setEditingId(null);
      refreshAll();
    },
    onError: (e) => toast.error(e.message),
  });

  const removeMapping = useMutation({
    mutationFn: (id) => apiSend(`/api/stock-take/barcodes/${id}`, "DELETE"),
    onSuccess: (r) => {
      toast.success(`Mapping removed: ${r.removed.barcode} was item ${r.removed.item_number} (${r.removed.unit}).`);
      refreshAll();
    },
    onError: (e) => toast.error(e.message),
  });

  function focusEntry() {
    // A wedge scanner types into whatever has focus, so the input takes it back
    // after every action. Skipped on the map tab, where people are reading.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (tab === "scan" && !cameraOpen) focusEntry();
  }, [tab, cameraOpen, scanned]);

  function submitEntry(raw) {
    const code = String(raw || "").trim();
    if (!code) return;
    setScanned(code);
    setEntry("");
    setChosenItem(null);
    setPendingUnit(null);
    setItemQuery("");
    saveMapping.reset();
  }

  const result = lookup.data;
  const conflict = saveMapping.error?.code === "BARCODE_IN_USE" ? saveMapping.error : null;

  if (hubMode) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <h1 className="mb-3 flex items-center gap-2 text-xl font-semibold"><Barcode className="h-5 w-5" /> Stock Take</h1>
        <Banner tone="info">{meta.data?.message}</Banner>
      </div>
    );
  }

  return (
    // Counting is done one-handed on a phone, so those tabs stay in a narrow
    // column even on a big screen. Supervising is a desk job with a wide table
    // — squeezing it into the phone width clipped the notes and wrapped the
    // minus sign off the figures.
    <div className={`mx-auto p-3 pb-24 sm:p-4 ${tab === "supervise" ? "max-w-[1400px]" : "max-w-2xl"}`}>
      {cameraOpen && (
        <BarcodeScanner
          onDetect={(code) => { setCameraOpen(false); submitEntry(code); }}
          onClose={() => { setCameraOpen(false); focusEntry(); }}
        />
      )}

      {editCamera && (
        <BarcodeScanner
          onDetect={(code) => { setEditCamera(false); setEditValue(code); }}
          onClose={() => setEditCamera(false)}
        />
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold"><Barcode className="h-5 w-5" /> Stock Take</h1>
        <button
          onClick={() => syncItems.mutate()}
          disabled={syncItems.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncItems.isPending ? "animate-spin" : ""}`} />
          {syncItems.isPending ? "Refreshing…" : "Refresh item list"}
        </button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        Sage has no barcode field, so the map lives here. Scanning and mapping never change anything in Sage — this screen only reads from it.
      </p>

      {/* Where we are counting, and how far the map has got. */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span className="shrink-0 text-muted-foreground">Location</span>
          <select
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
          >
            <option value="">Not set</option>
            {(meta.data?.locations || []).map((l) => (
              <option key={l.location} value={l.location}>{l.location} ({num(l.items)} items)</option>
            ))}
          </select>
        </label>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span className="text-muted-foreground">Mapped: </span>
          <span className="font-medium">{num(meta.data?.stocked_items_mapped)} of {num(meta.data?.stocked_items)}</span>
          <span className="text-muted-foreground"> items holding stock</span>
        </div>
      </div>

      {meta.data?.items_cached === 0 && (
        <div className="mb-3">
          <Banner tone="warn" icon={AlertTriangle}>
            The item list has never been loaded, so nothing can be mapped yet. Tap <strong>Refresh item list</strong> above to read the items and their pack sizes from Sage.
          </Banner>
        </div>
      )}

      {meta.data?.locations?.length === 0 && (
        <div className="mb-3">
          <Banner tone="warn" icon={AlertTriangle}>
            No branch has any stock on hand recorded here, so there is no location to pick and no quantities to show. On-hand figures come from the <strong>Inventory Movement</strong> sync — run that once and this fills in. Scanning and mapping still work without it.
          </Banner>
        </div>
      )}

      {cameraBlocked && (
        <div className="mb-3">
          <Banner tone="warn" icon={AlertTriangle}>{cameraBlocked}</Banner>
        </div>
      )}

      <div className="mb-3 flex gap-2">
        {[
          ["count", "Count"],
          ["scan", "Look up"],
          ["map", `Map (${num(meta.data?.barcodes_mapped)})`],
          ...(canSupervise ? [["supervise", "Supervise"]] : []),
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === key ? "border-sky-500 bg-sky-500/15 text-sky-300" : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "count" && (
        <CountTab
          sessions={sessionsQuery.data?.sessions || []}
          me={sessionsQuery.data?.me}
          onNeedSessions={() => sessionsQuery.refetch()}
        />
      )}

      {tab === "supervise" && canSupervise && (
        <SuperviseTab
          locations={meta.data?.locations || []}
          sessions={sessionsQuery.data?.sessions || []}
          onSessionsChanged={() => sessionsQuery.refetch()}
        />
      )}

      {tab === "scan" && (
        <div className="space-y-3">
          <form
            onSubmit={(e) => { e.preventDefault(); submitEntry(entry); }}
            className="flex gap-2"
          >
            <input
              ref={inputRef}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="Scan, or type the barcode"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-3 text-base outline-none focus:border-sky-500"
            />
            {!cameraBlocked && (
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-3 text-sm font-medium"
              >
                <Camera className="h-4 w-4" /> Camera
              </button>
            )}
          </form>

          {lookup.isFetching && <p className="text-sm text-muted-foreground">Looking up {scanned}…</p>}
          {lookup.isError && <Banner tone="error" icon={AlertTriangle}>{lookup.error.message}</Banner>}

          {result?.found && (
            <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                <div className="min-w-0">
                  <div className="text-base font-semibold">{result.item_description || "(no description)"}</div>
                  <div className="text-sm text-muted-foreground">
                    Item {result.item_number} · {result.barcode}
                  </div>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">This barcode is</dt>
                  <dd className="font-medium">
                    1 {result.unit}
                    {result.conversion !== 1 && result.stock_unit ? ` = ${num(result.conversion, 2)} ${result.stock_unit}` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">On hand{result.location ? ` at ${result.location}` : ""}</dt>
                  <dd className="font-medium">
                    {result.qty_on_hand == null ? "Pick a location" : `${num(result.qty_on_hand, 2)} ${result.stock_unit || ""}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">That is</dt>
                  <dd className="font-medium">
                    {result.qty_on_hand_in_unit == null ? "—" : `${num(result.qty_on_hand_in_unit, 2)} ${result.unit}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Average cost</dt>
                  <dd className="font-medium">{money(result.average_cost)}{result.average_cost != null && result.stock_unit ? ` / ${result.stock_unit}` : ""}</dd>
                </div>
              </dl>

              {result.unit_warning && <Banner tone="warn" icon={AlertTriangle}>{result.unit_warning}</Banner>}

              <p className="text-xs text-muted-foreground">
                Mapped by {result.mapped_by || "unknown"}{result.mapped_date ? ` on ${result.mapped_date}` : ""}.
              </p>

              <div className="flex gap-2">
                <button
                  onClick={() => { setChosenItem(null); setItemQuery(result.item_description || result.item_number); }}
                  className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium"
                >
                  Change what it maps to
                </button>
                <button
                  onClick={() => removeMapping.mutate(result.id)}
                  disabled={removeMapping.isPending}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" /> Remove
                </button>
              </div>
            </div>
          )}

          {result && !result.found && (
            <Banner tone={result.reason === "invalid" ? "error" : "warn"} icon={AlertTriangle}>
              {result.message}
            </Banner>
          )}

          {/* Mapping form: shown for an unmapped scan, or when re-pointing one. */}
          {scanned && result && (!result.found || itemQuery !== "") && (
            <div className="space-y-3 rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-medium">Map {scanned} to an item</div>

              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  value={itemQuery}
                  onChange={(e) => { setItemQuery(e.target.value); setChosenItem(null); }}
                  placeholder="Item number or description"
                  className="min-w-0 flex-1 bg-transparent text-base outline-none"
                />
              </div>

              {!chosenItem && items.data?.items?.length > 0 && (
                <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {items.data.items.map((it) => (
                    <li key={it.item_number}>
                      <button
                        onClick={() => setChosenItem(it)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{it.item_description || "(no description)"}</span>
                          <span className="block text-xs text-muted-foreground">
                            {it.item_number} · {num(it.qty_on_hand, 2)} {it.stock_unit || ""} on hand
                            {it.has_barcode ? " · already has a barcode" : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {!chosenItem && debouncedItemQuery.trim().length >= 2 && items.data?.items?.length === 0 && (
                <p className="text-sm text-muted-foreground">No item matches that. Try the item number, or part of the description as Sage spells it.</p>
              )}

              {chosenItem && (
                <div className="space-y-2">
                  <div className="text-sm">
                    <span className="font-medium">{chosenItem.item_description}</span>
                    <span className="text-muted-foreground"> · {chosenItem.item_number}</span>
                  </div>
                  {units.data?.units?.length === 1 ? (
                    <Banner tone="warn" icon={AlertTriangle}>
                      Sage holds only one unit for this item ({units.data.units[0].unit}), so it cannot tell a carton label from a single. Map the barcode that is on the {units.data.units[0].unit} you count, and leave smaller labels alone — otherwise the count is out by a whole pack.
                    </Banner>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Which pack size does this barcode sit on? Get this wrong and the count is wrong by the whole carton.
                    </p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(units.data?.units || []).map((u) => (
                      <button
                        key={u.unit}
                        onClick={() => { setPendingUnit(u.unit); saveMapping.mutate({ barcode: scanned, item_number: chosenItem.item_number, unit: u.unit }); }}
                        disabled={saveMapping.isPending}
                        className="rounded-md border border-border bg-background px-3 py-3 text-left text-sm hover:border-sky-500 disabled:opacity-50"
                      >
                        <span className="block font-medium">{u.unit}</span>
                        <span className="block text-xs text-muted-foreground">
                          {u.conversion === 1 ? "the stocking unit" : `= ${num(u.conversion, 2)} ${u.stock_unit || "stock units"}`}
                        </span>
                      </button>
                    ))}
                  </div>
                  {units.isError && <Banner tone="error" icon={AlertTriangle}>{units.error.message}</Banner>}
                </div>
              )}

              {conflict && (
                <Banner tone="warn" icon={AlertTriangle}>
                  <div>{conflict.message}</div>
                  <button
                    onClick={() => saveMapping.mutate({ barcode: scanned, item_number: chosenItem?.item_number, unit: pendingUnit, allow_remap: true })}
                    className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/20 px-3 py-1.5 text-xs font-medium"
                  >
                    Re-point it anyway
                  </button>
                </Banner>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "map" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={mapSearch}
              onChange={(e) => setMapSearch(e.target.value)}
              placeholder="Search the map by barcode, item or description"
              className="min-w-0 flex-1 bg-transparent text-base outline-none"
            />
          </div>

          {barcodes.isError && <Banner tone="error" icon={AlertTriangle}>{barcodes.error.message}</Banner>}

          {barcodes.data?.records?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {mapSearch ? "Nothing in the map matches that." : "The map is empty. Scan something on the Scan tab to start it off."}
            </p>
          )}

          <ul className="divide-y divide-border rounded-lg border border-border">
            {(barcodes.data?.records || []).map((b) => (
              <li key={b.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{b.item_description || "(no description)"}</div>
                    {editingId === b.id ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); changeBarcode.mutate({ id: b.id, barcode: editValue }); }
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          autoFocus
                          autoComplete="off"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-2 font-mono text-sm outline-none focus:border-sky-500"
                          aria-label={`Barcode for item ${b.item_number}`}
                        />
                        {!cameraBlocked && (
                          <button
                            onClick={() => setEditCamera(true)}
                            className="rounded-md border border-border p-2"
                            title="Scan the new label instead of typing it"
                          >
                            <Camera className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          onClick={() => changeBarcode.mutate({ id: b.id, barcode: editValue })}
                          disabled={changeBarcode.isPending}
                          className="rounded-md border border-emerald-500/50 bg-emerald-500/15 p-2 text-emerald-300 disabled:opacity-50"
                          title="Save"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button onClick={() => setEditingId(null)} className="rounded-md border border-border p-2" title="Cancel">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{b.barcode}</span> → item {b.item_number} · 1 {b.unit}
                        {b.conversion != null && b.conversion !== 1 && b.stock_unit ? ` = ${num(b.conversion, 2)} ${b.stock_unit}` : ""}
                      </div>
                    )}
                    {b.conversion == null && (
                      <div className="text-xs text-amber-400">
                        Sage no longer lists unit &quot;{b.unit}&quot; for this item — re-map it before counting.
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      by {b.created_by || "unknown"}{b.created_date ? ` · ${b.created_date}` : ""}
                      {b.updated_by && b.updated_by !== b.created_by ? ` · changed by ${b.updated_by} on ${b.updated_date}` : ""}
                    </div>
                  </div>
                  {editingId !== b.id && (
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => { setEditingId(b.id); setEditValue(b.barcode); }}
                        className="rounded-md border border-border p-2 text-muted-foreground"
                        aria-label={`Change the barcode on item ${b.item_number}`}
                        title="Change the barcode itself"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => removeMapping.mutate(b.id)}
                        disabled={removeMapping.isPending}
                        className="rounded-md border border-red-500/40 p-2 text-red-300 disabled:opacity-50"
                        aria-label={`Remove the mapping for ${b.barcode}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {meta.data?.items_synced_at && (
            <p className="text-xs text-muted-foreground">
              Item list last read from Sage on {meta.data.items_synced_at} — {num(meta.data.items_cached)} items, {num(meta.data.item_units_cached)} pack sizes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
