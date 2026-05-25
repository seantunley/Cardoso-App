import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

async function fetchStockReceiptLines({ search, missingExpiry, siteId }) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (missingExpiry) params.set("missing_expiry", "true");
  if (siteId) params.set("site_id", siteId);
  params.set("limit", "300");
  const res = await fetch(`/api/stock-receipts?${params.toString()}`, { credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || "Failed to load stock receipts");
  return res.json();
}
async function fetchLineExpiry(receiptLineId, siteId) {
  const qs = siteId ? `?site_id=${encodeURIComponent(siteId)}` : "";
  const res = await fetch(`/api/stock-receipts/${receiptLineId}/expiry${qs}`, { credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || "Failed to load expiry entries");
  return res.json();
}
async function createLineExpiry(payload) {
  const res = await fetch(`/api/stock-receipts/${payload.receiptLineId}/expiry`, { method:"POST", credentials:"include", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || "Failed to save expiry");
  return res.json();
}
export default function StockReceiptExpiry(){const qc=useQueryClient(); const [search,setSearch]=useState(""); const [missing,setMissing]=useState(true); const [siteId,setSiteId]=useState(""); const [rows,setRows]=useState([]); const [sel,setSel]=useState(null); const [date,setDate]=useState(""); const [qty,setQty]=useState(""); const [notes,setNotes]=useState(""); const [sites,setSites]=useState([]); const [hubMode,setHubMode]=useState(false);
useEffect(()=>{fetch('/api/app-info').then(r=>r.ok?r.json():null).then(d=>setHubMode(!!d?.hub_mode)); fetch('/api/hub/my-sites',{credentials:'include'}).then(r=>r.ok?r.json():[]).then(setSites).catch(()=>{});},[]);
const q=useQuery({queryKey:['stock-expiry',search,missing,siteId],queryFn:()=>fetchStockReceiptLines({search,missingExpiry:missing,siteId}),enabled:!hubMode||!!siteId});
useEffect(()=>{setRows(q.data?.records||[])},[q.data]);
const visible=useMemo(()=>new Set(rows.map(r=>Number(r.receipt_line_id))),[rows]);
useEffect(()=>{if(!rows.length) return setSel(null); if(!sel||!visible.has(Number(sel))) setSel(rows[0].receipt_line_id)},[rows,sel,visible]);
const d=useQuery({queryKey:['stock-expiry-detail',sel,siteId],queryFn:()=>fetchLineExpiry(sel,siteId),enabled:!!sel&&(!hubMode||!!siteId)});
const m=useMutation({mutationFn:createLineExpiry,onSuccess:()=>{setDate('');setQty('');setNotes('');qc.invalidateQueries({queryKey:['stock-expiry']});qc.invalidateQueries({queryKey:['stock-expiry-detail',sel,siteId]});}});
return <div className="p-6 space-y-4"><h1 className="text-2xl font-semibold">Stock Receipt Expiry</h1>{hubMode&&<select value={siteId} onChange={e=>setSiteId(e.target.value)} className="border rounded px-2 py-1"><option value="">Select site…</option>{sites.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>}<div className="flex gap-2"><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search" className="border rounded px-2 py-1"/><label><input type="checkbox" checked={missing} onChange={e=>setMissing(e.target.checked)}/> Missing only</label></div><div className="grid grid-cols-1 lg:grid-cols-2 gap-4"><div className="border rounded max-h-96 overflow-auto">{q.isLoading?'Loading...':rows.map(r=><button key={r.receipt_line_id} onClick={()=>setSel(r.receipt_line_id)} className={`block w-full text-left p-2 border-b ${sel===r.receipt_line_id?'bg-accent/20':''}`}><div>{r.receipt_number} · {r.item_number}</div><div className="text-xs text-muted-foreground">Line {r.line_no ?? '—'} · Expiry rows: {r.expiry_rows}</div></button>)}</div><div className="border rounded p-3 space-y-2">{d.isLoading?'Loading...':(d.data?.expiries||[]).map(e=><div key={e.id} className="text-sm border-b py-1">{e.expiry_date} · {e.qty_at_expiry||'—'} · {e.entered_by||'unknown'}</div>)}<input type="date" value={date} onChange={e=>setDate(e.target.value)} className="border rounded px-2 py-1 w-full"/><input value={qty} onChange={e=>setQty(e.target.value)} placeholder="Qty" className="border rounded px-2 py-1 w-full"/><input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Notes" className="border rounded px-2 py-1 w-full"/><button disabled={!sel||!date||m.isPending} onClick={()=>m.mutate({receiptLineId:sel,expiry_date:date,qty_at_expiry:qty,notes,site_id:siteId})} className="px-3 py-1 rounded bg-primary text-primary-foreground">{m.isPending?'Saving…':'Add expiry'}</button></div></div></div>}