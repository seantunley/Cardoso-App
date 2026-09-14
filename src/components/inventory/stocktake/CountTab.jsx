import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CheckCircle2, AlertTriangle, Undo2, CloudOff, Send, ClipboardList, Search, Keyboard } from "lucide-react";
import { toast } from "sonner";
import BarcodeScanner, { cameraUnavailableReason } from "@/components/inventory/BarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { loadQueue, saveQueue, enqueue, dequeue, pending, applyResult, makeClientId } from "@/lib/stocktakeQueue";

// The counter's screen.
//
// Blind by design: nothing here shows what Sage expects. The server withholds
// it as well, so this is not a matter of hiding a field.

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

function Banner({ tone = "info", icon: Icon = AlertTriangle, children }) {
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

export default function CountTab({ sessions, onNeedSessions, me }) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState(null);
  const [zoneId, setZoneId] = useState(null);
  const [zoneName, setZoneName] = useState("");
  const [recountMode, setRecountMode] = useState(false);
  const [entry, setEntry] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [held, setHeld] = useState(/** @type {any} */ (null));
  const [qty, setQty] = useState("");
  const [queue, setQueue] = useState(() => loadQueue());
  const [storageWorks, setStorageWorks] = useState(true);
  const [problems, setProblems] = useState(/** @type {any[]} */ ([]));
  const [sending, setSending] = useState(false);
  const [byName, setByName] = useState("");
  const [showByName, setShowByName] = useState(false);
  const scanRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const qtyRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  const cameraBlocked = useMemo(() => cameraUnavailableReason(), []);
  const debouncedByName = useDebouncedValue(byName, 250);
  const openSessions = useMemo(() => (sessions || []).filter((s) => s.status === "open"), [sessions]);

  // One open count is the normal case — drop straight into it.
  useEffect(() => {
    if (sessionId || openSessions.length !== 1) return;
    setSessionId(openSessions[0].id);
  }, [openSessions, sessionId]);

  const zones = useQuery({
    queryKey: ["stock-take-zones", sessionId],
    queryFn: () => apiFetch(`/api/stock-take/sessions/${sessionId}/zones`),
    enabled: Boolean(sessionId),
  });

  const zoneScans = useQuery({
    queryKey: ["stock-take-zone-scans", zoneId],
    queryFn: () => apiFetch(`/api/stock-take/zones/${zoneId}/scans?limit=50`),
    enabled: Boolean(zoneId),
  });

  // Blind, like everything else a counter sees: this returns the item and its
  // unit, never a quantity.
  const byNameResults = useQuery({
    queryKey: ["stock-take-count-items", debouncedByName, sessionId],
    queryFn: () => apiFetch(`/api/stock-take/count-items?q=${encodeURIComponent(debouncedByName)}&session_id=${sessionId}`),
    enabled: showByName && debouncedByName.trim().length >= 2 && Boolean(sessionId),
  });

  const recounts = useQuery({
    queryKey: ["stock-take-recounts", sessionId],
    queryFn: () => apiFetch(`/api/stock-take/sessions/${sessionId}/recounts`),
    enabled: Boolean(sessionId) && recountMode,
  });

  const outbox = useMemo(() => pending(queue, sessionId, zoneId), [queue, sessionId, zoneId]);

  const persist = useCallback((next) => {
    setQueue(next);
    setStorageWorks(saveQueue(next));
  }, []);

  /** Send whatever is waiting. Safe to call at any time — repeats are ignored. */
  const flush = useCallback(async () => {
    const waiting = pending(loadQueue(), sessionId, zoneId);
    if (!sessionId || !zoneId || waiting.length === 0 || sending) return;
    setSending(true);
    try {
      const result = await apiSend(`/api/stock-take/sessions/${sessionId}/scans`, "POST", {
        zone_id: zoneId,
        scans: waiting.map((s) => ({
          client_id: s.client_id, pass: s.pass, barcode: s.barcode,
          item_number: s.item_number, unit: s.unit, qty: s.qty, counted_at: s.queued_at,
        })),
      });
      persist(applyResult(loadQueue(), result));
      if (result.rejected_count) {
        setProblems((p) => [...result.rejected, ...p].slice(0, 20));
        toast.error(`${result.rejected_count} scan(s) were not accepted — see the list below.`);
      }
      queryClient.invalidateQueries({ queryKey: ["stock-take-zone-scans", zoneId] });
      queryClient.invalidateQueries({ queryKey: ["stock-take-zones", sessionId] });
    } catch (err) {
      // Left in the outbox on purpose: a failed send is almost always Wi-Fi,
      // and the next attempt carries the same client_ids so nothing doubles.
      toast.error(`Not sent yet: ${err.message}. The scans are saved on this phone and will go when the connection is back.`);
    } finally {
      setSending(false);
    }
  }, [sessionId, zoneId, sending, persist, queryClient]);

  // Send on a timer and the moment the phone says it is back online.
  useEffect(() => {
    if (!zoneId) return undefined;
    const timer = setInterval(flush, 8000);
    const onOnline = () => flush();
    window.addEventListener("online", onOnline);
    return () => { clearInterval(timer); window.removeEventListener("online", onOnline); };
  }, [flush, zoneId]);

  // Entering a zone: push anything the last session left behind. Intentionally
  // keyed on zoneId alone — re-running this whenever flush() changes identity
  // would send on every render.
  useEffect(() => { if (zoneId) flush(); }, [zoneId, flush]);

  function focusScan() { setTimeout(() => scanRef.current?.focus(), 0); }

  /** Take an aisle from the branch's list. Counters cannot invent one. */
  async function claimZone(zone) {
    try {
      const claimed = await apiSend(`/api/stock-take/zones/${zone.id}/claim`, "POST");
      setZoneId(claimed.id);
      setZoneName(claimed.name);
      zones.refetch();
      focusScan();
    } catch (err) {
      toast.error(err.message);
    }
  }

  /** Give it back, so somebody else can take it if you are done for the day. */
  async function leaveZone(release) {
    if (release && zoneId) {
      try {
        await apiSend(`/api/stock-take/zones/${zoneId}/release`, "POST");
        zones.refetch();
      } catch (err) {
        toast.error(err.message);
      }
    }
    setZoneId(null);
    setHeld(null);
  }

  /** A label that will not scan: pick the item by hand instead. */
  function holdItem(item) {
    setHeld({
      found: true,
      barcode: null,
      item_number: item.item_number,
      item_description: item.item_description,
      unit: item.stock_unit,
      picked_by_name: true,
    });
    setByName("");
    setShowByName(false);
    setQty("");
    setTimeout(() => qtyRef.current?.focus(), 0);
  }

  async function onScan(raw) {
    const code = String(raw || "").trim();
    if (!code) return;
    setEntry("");
    try {
      const found = await apiFetch(`/api/stock-take/count-lookup?barcode=${encodeURIComponent(code)}`);
      setHeld(found);
      setQty("");
      setTimeout(() => qtyRef.current?.focus(), 0);
    } catch (err) {
      toast.error(err.message);
      focusScan();
    }
  }

  function addCount() {
    const n = Number(qty);
    if (!Number.isFinite(n) || n === 0) {
      toast.error("Enter how many you counted. Zero is not a count — if there are none, leave it and the report will show it as never counted.");
      return;
    }
    const scan = {
      client_id: makeClientId(),
      session_id: sessionId,
      zone_id: zoneId,
      pass: recountMode ? 2 : 1,
      barcode: held?.barcode || null,
      item_number: held?.found ? held.item_number : null,
      unit: held?.found ? held.unit : null,
      qty: n,
      label: held?.found ? (held.item_description || held.item_number) : `Unknown barcode ${held?.barcode}`,
    };
    persist(enqueue(queue, scan));
    setHeld(null);
    setQty("");
    focusScan();
    flush();
  }

  function undoPending(clientId) {
    persist(dequeue(queue, clientId));
    toast.success("Taken back before it was sent.");
  }

  async function undoSent(scanId) {
    try {
      await apiSend(`/api/stock-take/scans/${scanId}/void`, "POST");
      zoneScans.refetch();
      queryClient.invalidateQueries({ queryKey: ["stock-take-zones", sessionId] });
      toast.success("Scan undone. It stays in the record, marked as taken back.");
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function submitZone() {
    if (outbox.length) {
      toast.error(`${outbox.length} scan(s) have not reached the server yet. Wait for them to send before you hand the zone in.`);
      flush();
      return;
    }
    try {
      await apiSend(`/api/stock-take/zones/${zoneId}/submit`, "POST");
      toast.success(`"${zoneName}" handed in.`);
      setZoneId(null);
      setZoneName("");
      zones.refetch();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (openSessions.length === 0) {
    return (
      <Banner tone="info" icon={ClipboardList}>
        There is no count open at the moment. A supervisor opens one on the <strong>Supervise</strong> tab.
        {onNeedSessions ? <button onClick={onNeedSessions} className="ml-2 underline">Refresh</button> : null}
      </Banner>
    );
  }

  return (
    <div className="space-y-3">
      {cameraOpen && (
        <BarcodeScanner
          onDetect={(code) => { setCameraOpen(false); onScan(code); }}
          onClose={() => { setCameraOpen(false); focusScan(); }}
        />
      )}

      {openSessions.length > 1 && (
        <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span className="shrink-0 text-muted-foreground">Count</span>
          <select
            value={sessionId || ""}
            onChange={(e) => { setSessionId(Number(e.target.value)); setZoneId(null); }}
            className="min-w-0 flex-1 bg-transparent outline-none"
          >
            <option value="">Choose…</option>
            {openSessions.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.location}</option>)}
          </select>
        </label>
      )}

      {!storageWorks && (
        <Banner tone="error">
          This phone will not let the app save scans locally, so anything not yet sent is lost if the page reloads. Keep the signal up, or count somewhere with a connection.
        </Banner>
      )}

      {sessionId && !zoneId && (
        <div className="space-y-3">
          <Banner tone="info" icon={ClipboardList}>
            Pick the aisle or shelf you are about to count. One person per zone — if two of you count the same rack it reads as a surplus.
          </Banner>

          {(zones.data?.zones || []).length === 0 ? (
            <Banner tone="warn">
              This branch has no aisles set up yet, so there is nothing to count against. A supervisor adds them on the <strong>Supervise</strong> tab — they are set up once and every count reuses them.
            </Banner>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {zones.data.zones.map((z) => {
                const mine = z.assigned_to === me;
                const takenByOther = Boolean(z.assigned_to) && !mine;
                return (
                  <li key={z.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{z.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {z.status === "submitted"
                          ? `handed in by ${z.submitted_by || "someone"}`
                          : takenByOther
                            ? `being counted by ${z.assigned_to}`
                            : mine ? "yours" : "free"}
                        {z.scans ? ` · ${z.scans} scan(s)` : ""}
                      </div>
                    </div>
                    {z.status !== "submitted" && !takenByOther && (
                      <button
                        onClick={() => claimZone(z)}
                        className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium ${mine ? "border-sky-500 bg-sky-500/15 text-sky-300" : "border-border"}`}
                      >
                        {mine ? "Carry on" : "Take it"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {zoneId && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="text-muted-foreground">Counting </span>
              <span className="font-semibold">{zoneName}</span>
            </div>
            <div className="flex items-center gap-2">
              {outbox.length > 0 && (
                <span className="flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300">
                  <CloudOff className="h-3.5 w-3.5" /> {outbox.length} waiting
                </span>
              )}
              <button onClick={() => leaveZone(false)} className="rounded-md border border-border px-3 py-1.5 text-xs">
                Pause
              </button>
              <button onClick={() => leaveZone(true)} className="rounded-md border border-border px-3 py-1.5 text-xs" title="Give the aisle back so somebody else can take it">
                Give back
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <input type="checkbox" checked={recountMode} onChange={(e) => setRecountMode(e.target.checked)} className="h-4 w-4" />
            <span>This is a recount</span>
            <span className="text-xs text-muted-foreground">— a second pass, which must be done by someone who did not count it first</span>
          </label>

          {recountMode && (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-2 text-sm font-medium">Items sent back for a recount</div>
              {recounts.data?.items?.length ? (
                <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
                  {recounts.data.items.map((it) => (
                    <li key={it.item_number} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate">{it.item_description || "(no description)"}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{it.item_number}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing is waiting for a recount.</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                No quantities are shown, on purpose. Count what is there and enter it.
              </p>
            </div>
          )}

          <form onSubmit={(e) => { e.preventDefault(); onScan(entry); }} className="flex gap-2">
            <input
              ref={scanRef}
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
              <button type="button" onClick={() => setCameraOpen(true)} className="rounded-lg border border-border bg-card px-3 py-3">
                <Camera className="h-4 w-4" />
              </button>
            )}
          </form>

          <div>
            <button
              onClick={() => { setShowByName((v) => !v); setByName(""); }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground underline"
            >
              <Keyboard className="h-3.5 w-3.5" />
              {showByName ? "Hide" : "Barcode will not scan? Find the item by name"}
            </button>
          </div>

          {showByName && (
            <div className="space-y-2 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={byName}
                  onChange={(e) => setByName(e.target.value)}
                  placeholder="Item number or name"
                  className="min-w-0 flex-1 bg-transparent text-base outline-none"
                />
              </div>
              {byNameResults.data?.items?.length > 0 && (
                <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {byNameResults.data.items.map((it) => (
                    <li key={it.item_number}>
                      <button onClick={() => holdItem(it)} className="w-full px-3 py-2.5 text-left hover:bg-muted/50">
                        <span className="block truncate text-sm font-medium">{it.item_description || "(no description)"}</span>
                        <span className="block text-xs text-muted-foreground">
                          {it.item_number}{it.stock_unit ? ` · counted in ${it.stock_unit}` : ""}{it.has_barcode ? "" : " · no barcode on file"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {debouncedByName.trim().length >= 2 && byNameResults.data?.items?.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing matches that. Try the item number, or part of the name as Sage spells it.</p>
              )}
            </div>
          )}

          {held && (
            <div className={`space-y-3 rounded-lg border p-3 ${held.found ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}>
              {held.found ? (
                <div>
                  <div className="text-base font-semibold">{held.item_description || "(no description)"}</div>
                  <div className="text-sm text-muted-foreground">
                    Item {held.item_number} · counting in {held.unit}
                    {held.picked_by_name ? " · picked by name" : ""}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-base font-semibold">Barcode not on the map</div>
                  <div className="text-sm text-muted-foreground">{held.message}</div>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  ref={qtyRef}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCount(); } }}
                  inputMode="decimal"
                  placeholder={held.found ? `How many ${held.unit}` : "How many"}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-3 text-base outline-none focus:border-sky-500"
                />
                <button onClick={addCount} className="rounded-lg border border-sky-500 bg-sky-500/15 px-4 py-3 text-sm font-medium text-sky-300">
                  Add
                </button>
                <button onClick={() => { setHeld(null); focusScan(); }} className="rounded-lg border border-border px-3 py-3 text-sm">
                  Skip
                </button>
              </div>
            </div>
          )}

          {problems.length > 0 && (
            <Banner tone="error">
              <div className="font-medium">Not accepted</div>
              <ul className="mt-1 space-y-1 text-xs">
                {problems.map((p, i) => <li key={`${p.client_id}-${i}`}>{p.reason}</li>)}
              </ul>
              <button onClick={() => setProblems([])} className="mt-2 underline">Clear</button>
            </Banner>
          )}

          <div className="space-y-1">
            {outbox.map((s) => (
              <div key={s.client_id} className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{s.qty} × {s.label}</span>
                <button onClick={() => undoPending(s.client_id)} className="shrink-0 text-xs text-muted-foreground underline">
                  <Undo2 className="mr-1 inline h-3 w-3" />undo
                </button>
              </div>
            ))}
            {(zoneScans.data?.scans || []).filter((s) => !s.voided).map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-emerald-400" />
                  {s.qty} × {s.item_description || s.barcode || s.item_number}
                  {s.pass === 2 ? <span className="ml-1 text-xs text-sky-400">recount</span> : null}
                </span>
                <button onClick={() => undoSent(s.id)} className="shrink-0 text-xs text-muted-foreground underline">
                  <Undo2 className="mr-1 inline h-3 w-3" />undo
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={flush} disabled={sending || outbox.length === 0} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-3 text-sm disabled:opacity-40">
              <Send className="h-4 w-4" /> {sending ? "Sending…" : `Send ${outbox.length || ""}`.trim()}
            </button>
            <button onClick={submitZone} className="flex-1 rounded-lg border border-emerald-500 bg-emerald-500/15 px-3 py-3 text-sm font-medium text-emerald-300">
              Hand in {zoneName}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
