import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Lock, Plus, RotateCcw, ClipboardList, MapPin, EyeOff, ChevronRight } from "lucide-react";
import { toast } from "sonner";

// The supervisor's view: progress, variance, recounts, and closing the count.
//
// This is the ONLY place expected quantities, cost and variance appear — the
// API withholds them from everyone else, so blind counting holds even if a
// counter goes looking.
//
// Nothing here writes to Sage. The output is a report and a CSV; a person
// keys any correction in Sage.

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

function num(v, dp = 2) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-ZA", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function money(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n < 0 ? "-" : ""}R${Math.abs(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What is odd about a row, in words, for both the card and the table. */
function rowNotes(r) {
  const notes = [];
  if (r.never_counted && r.expected_qty !== 0) notes.push("never counted");
  if (r.not_in_snapshot) notes.push("not expected here");
  if (r.counted_in_multiple_zones) notes.push(`counted in ${r.zone_count} zones`);
  if (r.recount_done) notes.push(`recounted (first pass ${num(r.pass1_qty)})`);
  else if (r.recount_required) notes.push("needs recount");
  return notes.join(" · ");
}

const FILTERS = [
  ["recount", "Needs recount"],
  ["differences", "Differences"],
  ["never_counted", "Never counted"],
  ["unexpected", "Not expected here"],
  ["all", "Everything"],
];

export default function SuperviseTab({ locations, location, sessions, onSessionsChanged }) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState(null);
  const [filter, setFilter] = useState("recount");
  const [showOpenForm, setShowOpenForm] = useState(false);
  const [form, setForm] = useState({ name: "", location: "", threshold_qty: "1", threshold_value: "500", notes: "" });
  const [pickedCategories, setPickedCategories] = useState(/** @type {string[]} */ ([]));
  const [pickedCommodities, setPickedCommodities] = useState(/** @type {string[]} */ ([]));
  const [pickedVendors, setPickedVendors] = useState(/** @type {string[]} */ ([]));
  const [vendorSearch, setVendorSearch] = useState("");
  const [zoneAdmin, setZoneAdmin] = useState(false);
  const [newZone, setNewZone] = useState("");
  const [openZoneId, setOpenZoneId] = useState(/** @type {number | null} */ (null));

  const openSession = useMemo(() => (sessions || []).find((s) => s.status === "open"), [sessions]);

  useEffect(() => {
    if (sessionId || !sessions?.length) return;
    setSessionId((openSession || sessions[0]).id);
  }, [sessions, openSession, sessionId]);

  // Follow the branch picked at the top of the page. Having its own default
  // meant the groups below were counted for a different branch than the one on
  // screen, which just looks like wrong numbers.
  useEffect(() => {
    const next = location || locations?.[0]?.location;
    if (form.location || !next) return;
    setForm((f) => ({ ...f, location: next }));
  }, [locations, location, form.location]);

  useEffect(() => {
    if (location && location !== form.location) setForm((f) => ({ ...f, location }));
  }, [location]);

  const session = useMemo(() => (sessions || []).find((s) => s.id === sessionId), [sessions, sessionId]);

  const zones = useQuery({
    queryKey: ["stock-take-zones", sessionId],
    queryFn: () => apiFetch(`/api/stock-take/sessions/${sessionId}/zones`),
    enabled: Boolean(sessionId),
  });

  const variance = useQuery({
    queryKey: ["stock-take-variance", sessionId, filter],
    queryFn: () => apiFetch(`/api/stock-take/sessions/${sessionId}/variance?filter=${filter}`),
    enabled: Boolean(sessionId),
  });

  // The branch whose aisles and product groups we are looking at: the count
  // being read, or the one being set up.
  const adminLocation = session?.location || form.location;

  const categories = useQuery({
    queryKey: ["stock-take-categories", form.location],
    queryFn: () => apiFetch(`/api/stock-take/categories?location=${encodeURIComponent(form.location)}`),
    enabled: Boolean(form.location),
  });

  const commodities = useQuery({
    queryKey: ["stock-take-commodities", form.location],
    queryFn: () => apiFetch(`/api/stock-take/commodities?location=${encodeURIComponent(form.location)}`),
    enabled: Boolean(form.location),
  });

  const vendors = useQuery({
    queryKey: ["stock-take-vendors", form.location],
    queryFn: () => apiFetch(`/api/stock-take/vendors?location=${encodeURIComponent(form.location)}`),
    enabled: Boolean(form.location),
  });

  const locationZones = useQuery({
    queryKey: ["stock-take-location-zones", adminLocation],
    queryFn: () => apiFetch(`/api/stock-take/location-zones?location=${encodeURIComponent(adminLocation)}&include_inactive=true`),
    enabled: Boolean(adminLocation),
  });

  const zoneSummary = useQuery({
    queryKey: ["stock-take-zone-summary", sessionId],
    queryFn: () => apiFetch(`/api/stock-take/sessions/${sessionId}/zone-summary`),
    enabled: Boolean(sessionId),
  });

  const zoneItems = useQuery({
    queryKey: ["stock-take-zone-items", sessionId, openZoneId],
    queryFn: () => apiFetch(`/api/stock-take/sessions/${sessionId}/zones/${openZoneId}/items`),
    enabled: Boolean(sessionId && openZoneId),
  });

  const unresolved = useQuery({
    queryKey: ["stock-take-unresolved", sessionId],
    queryFn: () => apiFetch(`/api/stock-take/sessions/${sessionId}/unresolved`),
    enabled: Boolean(sessionId),
  });

  const create = useMutation({
    mutationFn: (body) => apiSend("/api/stock-take/sessions", "POST", body),
    onSuccess: (s) => {
      toast.success(`Count "${s.name}" opened at ${s.location}${s.category_list?.length || s.commodity_list?.length || s.vendor_list?.length ? ` for ${[...(s.category_list || []), ...(s.commodity_list || []).map((c) => `commodity ${c}`), ...(s.vendor_list || []).map((v) => `vendor ${v}`)].join(", ")}` : ""}. ${s.snapshot_rows} item(s) of expected stock recorded, ${s.zones_created} aisle(s) ready to count.`);
      if (s.zones_created === 0) {
        toast.error(`${s.location} has no aisles set up, so nobody can start counting. Add them under "Aisles at this branch".`);
      }
      setShowOpenForm(false);
      setSessionId(s.id);
      onSessionsChanged?.();
    },
    onError: (e) => toast.error(e.message),
  });

  const close = useMutation({
    mutationFn: (body) => apiSend(`/api/stock-take/sessions/${sessionId}/close`, "POST", body),
    onSuccess: (s) => {
      toast.success(`Count "${s.name}" closed.`);
      onSessionsChanged?.();
      queryClient.invalidateQueries({ queryKey: ["stock-take-variance", sessionId] });
    },
    onError: (e) => {
      if (e.code === "COUNT_NOT_FINISHED") return; // shown inline with a confirm
      toast.error(e.message);
    },
  });

  const addZone = useMutation({
    mutationFn: (name) => apiSend("/api/stock-take/location-zones", "POST", { location: adminLocation, name }),
    onSuccess: (z) => {
      toast.success(z.reactivated
        ? `"${z.name}" is back in use at ${z.location}.`
        : `"${z.name}" added to ${z.location}${z.added_to_open_count ? " and to the count that is open there" : ""}.`);
      setNewZone("");
      locationZones.refetch();
      zones.refetch();
      zoneSummary.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const retireZone = useMutation({
    mutationFn: ({ id, active }) => apiSend(`/api/stock-take/location-zones/${id}/active`, "POST", { active }),
    onSuccess: (z) => {
      toast.success(`"${z.name}" ${z.active ? "is back in use" : "retired — counts already done still name it"}.`);
      locationZones.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const reopen = useMutation({
    mutationFn: (zoneId) => apiSend(`/api/stock-take/zones/${zoneId}/reopen`, "POST"),
    onSuccess: () => { zones.refetch(); toast.success("Zone reopened."); },
    onError: (e) => toast.error(e.message),
  });

  const notFinished = close.error?.code === "COUNT_NOT_FINISHED" ? close.error : null;
  const totals = variance.data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={sessionId || ""}
          onChange={(e) => setSessionId(Number(e.target.value))}
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none"
        >
          <option value="">Choose a count…</option>
          {(sessions || []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.location} — {s.status}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowOpenForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500/15 px-3 py-2 text-sm font-medium text-sky-300"
        >
          <Plus className="h-4 w-4" /> Open a count
        </button>
      </div>

      {showOpenForm && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="September count"
                className="w-full rounded-md border border-border bg-background px-3 py-2 outline-none"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">Location</span>
              <select
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-3 py-2 outline-none"
              >
                {(locations || []).map((l) => <option key={l.location} value={l.location}>{l.location}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">Recount if out by (units)</span>
              <input
                value={form.threshold_qty}
                onChange={(e) => setForm({ ...form, threshold_qty: e.target.value })}
                inputMode="decimal"
                className="w-full rounded-md border border-border bg-background px-3 py-2 outline-none"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-muted-foreground">…or by (rand)</span>
              <input
                value={form.threshold_value}
                onChange={(e) => setForm({ ...form, threshold_value: e.target.value })}
                inputMode="decimal"
                className="w-full rounded-md border border-border bg-background px-3 py-2 outline-none"
              />
            </label>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              Product groups at {form.location || "this branch"} — leave all unpicked to count everything
            </div>
            <div className="flex flex-wrap gap-2">
              {(categories.data?.categories || []).map((c) => {
                const picked = pickedCategories.includes(c.category);
                return (
                  <button
                    key={c.category}
                    onClick={() => setPickedCategories((prev) => (picked ? prev.filter((x) => x !== c.category) : [...prev, c.category]))}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${picked ? "border-sky-500 bg-sky-500/15 text-sky-300" : "border-border bg-background text-muted-foreground"}`}
                  >
                    {c.category_description || c.category} · {c.stocked_items} items
                  </button>
                );
              })}
              {categories.data?.categories?.length === 0 && (
                <span className="text-xs text-muted-foreground">No product groups found — refresh the item list from Sage first.</span>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              Commodities — Sage's other grouping, coarser than the product groups above
            </div>
            <div className="flex flex-wrap gap-2">
              {(commodities.data?.commodities || []).map((c) => {
                const picked = pickedCommodities.includes(c.commodity);
                return (
                  <button
                    key={c.commodity}
                    onClick={() => setPickedCommodities((prev) => (picked ? prev.filter((x) => x !== c.commodity) : [...prev, c.commodity]))}
                    title={[c.sample_first, c.sample_last].filter(Boolean).join("  ·  ")}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${picked ? "border-sky-500 bg-sky-500/15 text-sky-300" : "border-border bg-background text-muted-foreground"}`}
                  >
                    Commodity {c.commodity} · {c.stocked_items} items
                  </button>
                );
              })}
              {commodities.data?.commodities?.length === 0 && (
                <span className="text-xs text-muted-foreground">No commodities set on the items at this branch.</span>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Vendors — count one supplier's stock in a pass</span>
              {(vendors.data?.vendors || []).length > 8 && (
                <input
                  value={vendorSearch}
                  onChange={(e) => setVendorSearch(e.target.value)}
                  placeholder="Filter vendors"
                  className="ml-auto w-40 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none"
                />
              )}
            </div>
            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {(vendors.data?.vendors || [])
                .filter((v) => pickedVendors.includes(v.vendor_code)
                  || !vendorSearch.trim()
                  || `${v.vendor_name} ${v.vendor_code}`.toLowerCase().includes(vendorSearch.trim().toLowerCase()))
                .map((v) => {
                  const picked = pickedVendors.includes(v.vendor_code);
                  return (
                    <button
                      key={v.vendor_code}
                      onClick={() => setPickedVendors((prev) => (picked ? prev.filter((x) => x !== v.vendor_code) : [...prev, v.vendor_code]))}
                      title={v.vendor_code}
                      className={`rounded-full border px-3 py-1 text-xs font-medium ${picked ? "border-sky-500 bg-sky-500/15 text-sky-300" : "border-border bg-background text-muted-foreground"}`}
                    >
                      {v.vendor_name || v.vendor_code} · {v.stocked_items} items
                    </button>
                  );
                })}
              {vendors.data?.vendors?.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  No items are attributed to a vendor yet. That list comes from the Inventory Movement sync — run it once and vendors appear here.
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {pickedCategories.length || pickedCommodities.length || pickedVendors.length
                ? `Counting anything in the ${pickedCategories.length} group(s), ${pickedCommodities.length} commodity(ies) or ${pickedVendors.length} vendor(s) picked — an item is in the count if it matches any one of them. Everything else at the branch is left out entirely.`
                : "Counting everything the branch holds."}
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            Either threshold sends an item back for a recount by a different person. Expected quantities are recorded now, so sales during the count do not read as shortfalls.
          </p>
          <button
            onClick={() => create.mutate({ ...form, categories: pickedCategories, commodities: pickedCommodities, vendors: pickedVendors, threshold_qty: Number(form.threshold_qty), threshold_value: Number(form.threshold_value) })}
            disabled={create.isPending}
            className="w-full rounded-md border border-sky-500 bg-sky-500/15 px-3 py-2 text-sm font-medium text-sky-300 disabled:opacity-50"
          >
            {create.isPending ? "Opening…" : "Open the count"}
          </button>
        </div>
      )}

      {!sessionId && (
        <div className="flex items-start gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2.5 text-sm text-sky-200">
          <ClipboardList className="mt-0.5 h-4 w-4 shrink-0" />
          <div>No count chosen. Open one, or pick an earlier one to read its report.</div>
        </div>
      )}

      {(session?.categories || session?.commodities || session?.vendors) && (
        <p className="text-xs text-muted-foreground">
          This count covers{" "}
          {[
            ...(session.categories ? JSON.parse(session.categories) : []),
            ...(session.commodities ? JSON.parse(session.commodities).map((c) => `commodity ${c}`) : []),
            ...(session.vendors ? JSON.parse(session.vendors).map((v) => `vendor ${v}`) : []),
          ].join(", ")}{" "}
          only. Anything outside that is not part of the count and will not show as missing.
        </p>
      )}

      {sessionId && (
        <>
          {/* What each zone found.

              Sage holds stock per branch, not per shelf, so there is no
              expected quantity for an aisle and therefore no per-zone
              variance. What a zone can honestly report is what it found and
              what that is worth — which is enough to spot the aisle that was
              rushed, or the two people who counted the same rack. */}
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-sm font-medium">
                Zones — {(zoneSummary.data?.zones || []).filter((z) => z.status === "submitted").length} of {(zoneSummary.data?.zones || []).length} handed in
              </span>
              <button onClick={() => setZoneAdmin((v) => !v)} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs">
                <MapPin className="h-3.5 w-3.5" /> Aisles at this branch
              </button>
            </div>

            {zoneAdmin && (
              <div className="border-b border-border bg-muted/20 px-3 py-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  The aisles and shelves at <strong>{adminLocation || "this branch"}</strong>. Counters pick from this list and cannot add to it — free text turned the same rack into three different names. Adding one here also adds it to a count that is already open.
                </p>
                <form
                  onSubmit={(e) => { e.preventDefault(); if (newZone.trim()) addZone.mutate(newZone.trim()); }}
                  className="mb-2 flex gap-2"
                >
                  <input
                    value={newZone}
                    onChange={(e) => setNewZone(e.target.value)}
                    placeholder="Aisle 3, or Shelf B cold room"
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
                  />
                  <button type="submit" disabled={addZone.isPending} className="rounded-md border border-sky-500 bg-sky-500/15 px-3 py-2 text-sm font-medium text-sky-300 disabled:opacity-50">
                    Add
                  </button>
                </form>
                {(locationZones.data?.zones || []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No aisles yet. Add them and every count from now on reuses the same list.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border bg-background">
                    {locationZones.data.zones.map((z) => (
                      <li key={z.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                        <span className={z.active ? "" : "text-muted-foreground line-through"}>
                          {z.name}
                          {z.used_in_counts ? <span className="ml-2 text-xs text-muted-foreground">used in {z.used_in_counts} count(s)</span> : null}
                        </span>
                        <button
                          onClick={() => retireZone.mutate({ id: z.id, active: !z.active })}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                          title={z.active ? "Retire this aisle — counts already done still name it" : "Bring it back into use"}
                        >
                          <EyeOff className="h-3 w-3" /> {z.active ? "Retire" : "Restore"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {(zoneSummary.data?.zones || []).length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">
                This count has no aisles. Add them under <strong>Aisles at this branch</strong> — nobody can start counting until it has some.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {zoneSummary.data.zones.map((z) => (
                  <li key={z.id}>
                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                      <button
                        onClick={() => setOpenZoneId(openZoneId === z.id ? null : z.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${openZoneId === z.id ? "rotate-90" : ""}`} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{z.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {z.assigned_to || "nobody yet"} · {z.items} item(s), {num(z.counted_qty)} counted
                            {z.recount_scans ? ` · ${z.recount_scans} recount scan(s)` : ""}
                            {z.unmapped_scans ? ` · ${z.unmapped_scans} unknown barcode(s)` : ""}
                            {z.items_also_in_another_zone ? ` · ${z.items_also_in_another_zone} item(s) also counted elsewhere` : ""}
                          </span>
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="whitespace-nowrap text-sm tabular-nums">{money(z.counted_value)}</span>
                        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${z.status === "submitted" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                          {z.status === "submitted" ? "handed in" : "counting"}
                        </span>
                        {z.status === "submitted" && session?.status === "open" && (
                          <button onClick={() => reopen.mutate(z.id)} className="rounded-md border border-border p-1.5" title="Reopen this zone">
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {openZoneId === z.id && (
                      <div className="border-t border-border bg-muted/10 px-3 py-2">
                        {zoneItems.isFetching && <p className="text-sm text-muted-foreground">Loading…</p>}
                        {zoneItems.data?.items?.length === 0 && <p className="text-sm text-muted-foreground">Nothing counted in this zone yet.</p>}
                        {(zoneItems.data?.items || []).length > 0 && (
                          <ul className="space-y-1">
                            {zoneItems.data.items.map((it) => (
                              <li key={it.item_number || it.barcode} className="flex items-start justify-between gap-3 text-sm">
                                <span className="min-w-0">
                                  <span className="block truncate">{it.item_description || `Unknown barcode ${it.barcode}`}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {it.item_number || "not matched to an item"} · by {it.counted_by}
                                    {it.other_zones ? ` · also counted in ${it.other_zones}` : ""}
                                    {it.branch_expected_qty != null ? ` · branch holds ${num(it.branch_expected_qty)}` : ""}
                                  </span>
                                </span>
                                <span className="shrink-0 text-right">
                                  <span className="block whitespace-nowrap tabular-nums">{num(it.zone_qty)} {it.stock_unit || ""}</span>
                                  <span className="block whitespace-nowrap text-xs tabular-nums text-muted-foreground">{money(it.zone_value)}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-2 text-xs text-muted-foreground">
                          Sage holds stock per branch, not per shelf, so there is no expected figure for one aisle — only what it found. Variance stays a branch-level number.
                        </p>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Totals */}
          {totals && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Items with a difference", String(totals.items_with_difference)],
                ["Awaiting recount", String(totals.recounts_outstanding)],
                ["Never counted", String(totals.never_counted)],
                ["Net difference", money(totals.net_value)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-card px-3 py-2">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  {/* A big rand figure must not wrap its minus sign onto the
                      line below — it reads as a surplus. */}
                  <div className="truncate whitespace-nowrap text-lg font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Variance */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    filter === key ? "border-sky-500 bg-sky-500/15 text-sky-300" : "border-border bg-card text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
              <a
                href={`/api/stock-take/sessions/${sessionId}/variance.csv?filter=${filter}`}
                className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium"
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </a>
            </div>

            {variance.isError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{variance.error.message}
              </div>
            )}

            {/* Phone: one card per item, because a six-column table at 400px
                is unreadable however it is scrolled. Desk: the full table. */}
            <div className="space-y-2 md:hidden">
              {(variance.data?.rows || []).map((r) => (
                <div key={r.item_number} className="rounded-lg border border-border bg-card p-3">
                  <div className="font-medium leading-snug">{r.item_description || "(no description)"}</div>
                  <div className="mb-2 text-xs text-muted-foreground">{r.item_number}{r.stock_unit ? ` · ${r.stock_unit}` : ""}</div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Counted</div>
                      <div className="tabular-nums">{num(r.counted_qty)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Expected</div>
                      <div className="tabular-nums">{num(r.expected_qty)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Out by</div>
                      <div className={`whitespace-nowrap tabular-nums font-medium ${r.diff_qty < 0 ? "text-red-400" : r.diff_qty > 0 ? "text-emerald-400" : ""}`}>
                        {num(r.diff_qty)}
                      </div>
                    </div>
                  </div>
                  <div className={`mt-2 whitespace-nowrap text-lg font-semibold tabular-nums ${r.diff_value < 0 ? "text-red-400" : r.diff_value > 0 ? "text-emerald-400" : ""}`}>
                    {money(r.diff_value)}
                  </div>
                  {rowNotes(r) && <div className="mt-1 text-xs text-muted-foreground">{rowNotes(r)}</div>}
                </div>
              ))}
              {(variance.data?.rows || []).length === 0 && (
                <p className="rounded-lg border border-border px-3 py-4 text-center text-sm text-muted-foreground">Nothing under this filter.</p>
              )}
            </div>

            <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="w-24 px-3 py-2 text-right">Counted</th>
                    <th className="w-24 px-3 py-2 text-right">Expected</th>
                    <th className="w-24 px-3 py-2 text-right">Out by</th>
                    <th className="w-32 px-3 py-2 text-right">Value</th>
                    <th className="w-64 px-3 py-2 text-left">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(variance.data?.rows || []).map((r) => (
                    <tr key={r.item_number}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.item_description || "(no description)"}</div>
                        <div className="text-xs text-muted-foreground">{r.item_number}{r.stock_unit ? ` · ${r.stock_unit}` : ""}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(r.counted_qty)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{num(r.expected_qty)}</td>
                      <td className={`whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ${r.diff_qty < 0 ? "text-red-400" : r.diff_qty > 0 ? "text-emerald-400" : ""}`}>
                        {num(r.diff_qty)}
                      </td>
                      <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${r.diff_value < 0 ? "text-red-400" : r.diff_value > 0 ? "text-emerald-400" : ""}`}>
                        {money(r.diff_value)}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{rowNotes(r)}</td>
                    </tr>
                  ))}
                  {(variance.data?.rows || []).length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-sm text-muted-foreground">Nothing under this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {variance.data && (
              <p className="text-xs text-muted-foreground">Showing {variance.data.shown} of {variance.data.of} items.</p>
            )}
          </div>

          {/* Scans whose barcode was never mapped */}
          {unresolved.data?.scans?.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="mb-1 text-sm font-medium text-amber-200">
                {unresolved.data.scans.length} scan(s) of barcodes that are not on the map
              </div>
              <p className="mb-2 text-xs text-muted-foreground">
                These were counted but could not be matched to an item, so they are not in the variance above. Map the barcode on the Map tab, then attach the scan.
              </p>
              <ul className="space-y-1 text-sm">
                {unresolved.data.scans.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{s.barcode} · {num(s.qty)} · {s.zone_name} · {s.counted_by}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Closing */}
          {session?.status === "open" && (
            <div className="space-y-2 rounded-lg border border-border bg-card p-3">
              {notFinished && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div>{notFinished.message}</div>
                    <button
                      onClick={() => close.mutate({ force: true })}
                      className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/20 px-3 py-1.5 text-xs font-medium"
                    >
                      Close it anyway
                    </button>
                  </div>
                </div>
              )}
              <button
                onClick={() => close.mutate({})}
                disabled={close.isPending}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                <Lock className="h-4 w-4" /> Close this count
              </button>
              <p className="text-xs text-muted-foreground">
                Closing locks the count. It does not change anything in Sage — any correction is keyed in Sage by a person, from this report.
              </p>
            </div>
          )}

          {session?.status === "closed" && (
            <p className="text-xs text-muted-foreground">
              Closed by {session.closed_by} on {session.closed_date}. {session.notes ? session.notes : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}
