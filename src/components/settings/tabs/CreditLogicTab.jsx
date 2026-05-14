import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/lib/permissions";

// UI
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Icons
import { RefreshCw, GitBranch, Send, Info } from "lucide-react";

export default function CreditLogicTab({ hubMode = false, currentUser }) {
  const queryClient = useQueryClient();
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || currentUser?.role === "admin";
  const [draft, setDraft] = useState(null);
  const [notes, setNotes] = useState("");
  const [selectedSiteIds, setSelectedSiteIds] = useState(new Set());

  const query = useQuery({
    queryKey: [hubMode ? "hub-credit-logic" : "site-credit-logic"],
    queryFn: async () => {
      const response = await fetch(hubMode ? "/api/hub/credit-logic" : "/api/credit-logic/current", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load credit logic");
      return data;
    },
    enabled: !!currentUser,
  });

  useEffect(() => {
    const sourceConfig = hubMode ? query.data?.current?.config : query.data?.current?.config;
    if (sourceConfig) setDraft(sourceConfig);
  }, [hubMode, query.data]);

  const publishMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/hub/credit-logic/publish", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: draft, notes }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to publish credit logic");
      return data;
    },
    onSuccess: () => {
      toast.success("Credit logic published");
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["hub-credit-logic"] });
      queryClient.invalidateQueries({ queryKey: ["creditLogicCurrent"] });
    },
    onError: (error) => toast.error(error.message || "Failed to publish credit logic"),
  });

  const pushMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/hub/credit-logic/push", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_ids: selectedSiteIds.size > 0 ? Array.from(selectedSiteIds) : [] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 207) throw new Error(data.error || "Failed to push credit logic");
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Pushed v${data.version} to ${data.pushed} site${data.pushed === 1 ? "" : "s"}`);
      if (data.failed) toast.error(`${data.failed} site${data.failed === 1 ? "" : "s"} failed to update`);
      queryClient.invalidateQueries({ queryKey: ["hub-credit-logic"] });
    },
    onError: (error) => toast.error(error.message || "Failed to push credit logic"),
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/credit-logic/sync-from-hub", { method: "POST", credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 207) throw new Error(data.error || "Failed to sync credit logic");
      return data;
    },
    onSuccess: (data) => {
      if (data.ok) toast.success(`Synced credit logic v${data.logicVersion}`);
      else toast.error(data.error || "Credit logic sync completed with issues");
      queryClient.invalidateQueries({ queryKey: ["site-credit-logic"] });
      queryClient.invalidateQueries({ queryKey: ["creditLogicCurrent"] });
    },
    onError: (error) => toast.error(error.message || "Failed to sync credit logic"),
  });

  const setNested = (path, value) => {
    setDraft((current) => {
      if (!current) return current;
      const clone = structuredClone(current);
      let cursor = clone;
      for (let i = 0; i < path.length - 1; i += 1) cursor = cursor[path[i]];
      cursor[path[path.length - 1]] = value;
      return clone;
    });
  };

  const toggleSite = (siteId) => {
    setSelectedSiteIds((current) => {
      const next = new Set(current);
      next.has(siteId) ? next.delete(siteId) : next.add(siteId);
      return next;
    });
  };

  const statuses = query.data?.siteStatuses || [];
  const current = query.data?.current;
  const modeBadge = hubMode ? "Hub Source of Truth" : "Site Cache";
  const driftTone = {
    current: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    outdated: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    error: "bg-red-500/15 text-red-400 border-red-500/30",
    unreachable: "bg-red-500/15 text-red-400 border-red-500/30",
    never_synced: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  };

  if (query.isLoading || !draft) return <div className="h-32 animate-pulse rounded-xl bg-muted" />;
  if (query.error) return <div className="rounded-xl border border-rose-700 bg-rose-900/20 p-4 text-sm text-rose-300">{query.error.message}</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Centralised Credit Logic</h3>
            <Badge variant="outline" className="border-border text-muted-foreground">{modeBadge}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Active version: <span className="font-medium text-foreground">v{hubMode ? query.data?.current?.version : current?.logicVersion}</span>
            {!hubMode && current?.syncStatus ? <span> · sync status: {current.syncStatus.replaceAll("_", " ")}</span> : null}
          </p>
          {!hubMode && current?.lastError ? <p className="text-xs text-rose-400">Last sync error: {current.lastError}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {hubMode ? (
            <>
              <Button size="sm" variant="outline" onClick={() => publishMutation.mutate()} disabled={!canManageRules || publishMutation.isPending} className="gap-1.5">
                <GitBranch className="h-3.5 w-3.5" />{publishMutation.isPending ? "Publishing…" : "Publish new version"}
              </Button>
              <Button size="sm" onClick={() => pushMutation.mutate()} disabled={!canManageRules || pushMutation.isPending || statuses.length === 0} className="gap-1.5">
                <Send className="h-3.5 w-3.5" />{pushMutation.isPending ? "Pushing…" : "Push to sites"}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => syncMutation.mutate()} disabled={!canManageRules || syncMutation.isPending || !query.data?.hubSyncConfigured} className="gap-1.5">
              <RefreshCw className={cn("h-3.5 w-3.5", syncMutation.isPending && "animate-spin")} />{syncMutation.isPending ? "Syncing…" : "Sync from Hub"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Thresholds</h4>
              <p className="text-xs text-muted-foreground">These values drive the scoring thresholds enforced in analysis.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Payment term days", ["thresholds", "paymentTermDays"], "Expected payment window. Invoices paid within this many days are considered on time and score positively."],
                ["Breach days", ["thresholds", "breachDays"], "Hard overdue limit. Any unpaid invoice older than this forces a Hold verdict, regardless of score."],
                ["Approaching breach days", ["thresholds", "approachingBreachDays"], "Warning zone before the hard breach. Unpaid invoices in this range deduct points and trigger a caution flag."],
                ["Caution below score", ["thresholds", "cautionScoreBelow"], "Score threshold for the Caution verdict. Customers scoring below this value are shown as Caution instead of Approve."],
                ["Hold below score", ["thresholds", "holdScoreBelow"], "Reserved for future use. Currently Hold is triggered by breach days, not score alone."],
                ["Dormant threshold days", ["thresholds", "dormantThresholdDays"], "Inactivity cutoff. Customers with no invoice or receipt activity beyond this many days are flagged as Dormant instead of Approve."],
              ].map(([label, path, hint]) => (
                <div key={path.join(".")} className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label>{label}</Label>
                    {hint && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[260px]">{hint}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <Input type="number" value={path.reduce((acc, key) => acc?.[key], draft) ?? ""} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(path, Number(e.target.value || 0))} />
                  {hint && <p className="text-xs text-muted-foreground leading-snug">{hint}</p>}
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm">
                  <Checkbox checked={Boolean(draft.outstandingBalanceCap.enabled)} disabled={!hubMode || !canManageRules} onCheckedChange={(checked) => setNested(["outstandingBalanceCap", "enabled"], Boolean(checked))} />
                  Enable exposure cap deduction
                </label>
                <p className="text-xs text-muted-foreground leading-snug px-1">When enabled, a customer whose outstanding balance exceeds their average invoice multiplied by the cap multiplier below receives a score deduction.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Exposure cap multiplier</Label>
                <Input type="number" value={draft.outstandingBalanceCap.multiplier} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(["outstandingBalanceCap", "multiplier"], Number(e.target.value || 0))} />
                <p className="text-xs text-muted-foreground leading-snug">e.g. a multiplier of 3 means: if the outstanding balance is more than 3× their average invoice, points are deducted. Lower = stricter.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Verdict wording</h4>
              <p className="text-xs text-muted-foreground">Admin-editable labels and summaries pushed from Hub to every site.</p>
            </div>
            {[
              ["approve", "Approve"],
              ["caution", "Caution"],
              ["hold", "Hold"],
              ["dormant", "Dormant"],
            ].map(([key, label]) => (
              <div key={key} className="space-y-2 rounded-xl border border-border p-3">
                <Label>{label} title</Label>
                <Input value={draft.wording.verdicts[key].title} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(["wording", "verdicts", key, "title"], e.target.value)} />
                <Label>{label} summary</Label>
                <Textarea value={draft.wording.verdicts[key].summary} disabled={!hubMode || !canManageRules} onChange={(e) => setNested(["wording", "verdicts", key, "summary"], e.target.value)} rows={3} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {hubMode ? (
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label>Publish notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What changed in this logic version?" disabled={!canManageRules} />
              </div>
              <div className="space-y-1.5 min-w-[220px]">
                <Label>Recent versions</Label>
                <div className="rounded-xl border border-border p-3 text-sm text-muted-foreground">
                  {(query.data?.versions || []).slice(0, 5).map((version) => (
                    <div key={version.version} className="flex items-center justify-between gap-2 py-1 first:pt-0 last:pb-0">
                      <span>v{version.version}</span>
                      <span className="text-xs">{version.isActive ? "active" : "history"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-foreground">Site sync status</h4>
                <p className="text-xs text-muted-foreground">Select sites below to push a targeted update, or leave all unchecked to push everywhere.</p>
              </div>
              <div className="rounded-xl border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
                      <th className="px-4 py-2.5 text-left">Push</th>
                      <th className="px-4 py-2.5 text-left">Site</th>
                      <th className="px-4 py-2.5 text-left">Version</th>
                      <th className="px-4 py-2.5 text-left">Drift</th>
                      <th className="px-4 py-2.5 text-left">Last synced</th>
                      <th className="px-4 py-2.5 text-left">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statuses.map((site) => (
                      <tr key={site.siteId} className="border-b border-border last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-2.5"><Checkbox checked={selectedSiteIds.has(site.siteId)} onCheckedChange={() => toggleSite(site.siteId)} /></td>
                        <td className="px-4 py-2.5 font-medium text-foreground">{site.siteName || site.siteSlug}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{site.logicVersion ? `v${site.logicVersion}` : "—"}</td>
                        <td className="px-4 py-2.5"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${driftTone[site.driftStatus] || driftTone.never_synced}`}>{site.driftStatus.replaceAll("_", " ")}</span></td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{site.lastSyncedAt ? new Date(site.lastSyncedAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</td>
                        <td className="px-4 py-2.5 text-xs text-rose-400 max-w-[260px] truncate">{site.lastError || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
        <Card className="border-border bg-card">
          <CardContent className="space-y-4 p-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">How scoring works</h4>
              <p className="text-xs text-muted-foreground mt-0.5">A walk-through of the logic applied to every customer analysis.</p>
            </div>
            <ol className="space-y-3 text-xs text-muted-foreground list-none">
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center font-semibold text-[10px]">1</span>
                <div><span className="font-medium text-foreground">Zero balance → instant Approve.</span> If the outstanding balance is below R1 the customer passes immediately. Score is 100. Manual red/orange flags can still override this.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-slate-500/15 text-slate-300 flex items-center justify-center font-semibold text-[10px]">2</span>
                <div><span className="font-medium text-foreground">No history with a balance → Caution.</span> If there are no invoices or receipts on record but the customer has an outstanding balance, a fixed low score is applied and the verdict is Caution.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-red-500/15 text-red-400 flex items-center justify-center font-semibold text-[10px]">3</span>
                <div><span className="font-medium text-foreground">Hard breach gate.</span> If the oldest unpaid invoice is older than <em>Breach days</em>, the verdict is forced to Hold — no score calculation matters. This is a hard block.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500/15 text-amber-400 flex items-center justify-center font-semibold text-[10px]">4</span>
                <div><span className="font-medium text-foreground">Score deductions (start at 100).</span> Points are deducted for: unpaid invoices approaching breach, average payment lag above terms, outstanding balance exceeding the exposure cap, and historical red/orange flag events. Multiple deductions stack.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-sky-500/15 text-sky-400 flex items-center justify-center font-semibold text-[10px]">5</span>
                <div><span className="font-medium text-foreground">Verdict from score.</span> Score below <em>Caution threshold</em> → Caution. Above it → Approve. (<em>Hold below score</em> is reserved for future use; Hold is currently breach-only.)</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-purple-500/15 text-purple-400 flex items-center justify-center font-semibold text-[10px]">6</span>
                <div><span className="font-medium text-foreground">Dormant check.</span> If the customer would Approve but has had no invoice or receipt activity for longer than <em>Dormant threshold days</em>, the verdict becomes Dormant instead — a prompt to re-evaluate before extending credit.</div>
              </li>
              <li className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-slate-500/15 text-slate-300 flex items-center justify-center font-semibold text-[10px]">7</span>
                <div><span className="font-medium text-foreground">Manual flag overrides (final pass).</span> A manually applied red flag forces Hold. A manually applied orange flag downgrades Approve to Caution. Auto-flags do not trigger these overrides — only human-set flags do.</div>
              </li>
            </ol>
          </CardContent>
        </Card>

      <Card className="border-border bg-card">
        <CardContent className="space-y-2 p-4 text-sm text-muted-foreground">
          <p>Sites analyse credit using the locally cached config, so the last good version keeps working if Hub is unreachable.</p>
          <p>Current source: <span className="font-medium text-foreground">{current?.source || "default"}</span></p>
          <p>Last synced: <span className="font-medium text-foreground">{current?.lastSyncedAt ? new Date(current.lastSyncedAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "Never"}</span></p>
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
}
