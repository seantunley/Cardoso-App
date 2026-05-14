import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";
import { humanizeApiError } from "@/lib/humanizeApiError";

// UI
import { Button } from "@/components/ui/button";

// Icons
import { RefreshCw, AlertCircle, AlertTriangle } from "lucide-react";

// Lists hub_sites rows whose id is no longer in HUB_SITES env. Each
// row shows how much hub_records / hub_inventory data exists for it
// (so the operator knows what the Forget cascade would remove) plus
// a Forget button that DELETEs everything referencing that site.
//
// Renders nothing when there are no orphans — keeps the
// HubMaintenanceTab tidy in the healthy case.
function OrphanSitesSection() {
  const [orphans, setOrphans] = useState(null); // null = loading
  const [forgetting, setForgetting] = useState(null); // siteId being forgotten

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/hub/orphan-sites', { credentials: 'include' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setOrphans(Array.isArray(data.orphans) ? data.orphans : []);
    } catch (e) {
      reportClientError('SettingsPanel.orphanSites.load', e);
      setOrphans([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleForget = async (orphan) => {
    const recCount = orphan.record_count || 0;
    const invCount = orphan.inventory_count || 0;
    const summary = `${recCount} record(s)${invCount ? ` + ${invCount} inventory row(s)` : ''}`;
    if (!confirm(
      `Forget orphan site "${orphan.name || orphan.slug || orphan.id}"?\n\n` +
      `This will permanently delete the hub_sites row plus ${summary} from the hub. ` +
      `It does NOT touch the site itself — only the hub's cached copy.\n\n` +
      `This cannot be undone.`
    )) return;

    setForgetting(orphan.id);
    try {
      const r = await fetch(`/api/hub/sites/${encodeURIComponent(orphan.id)}/forget`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(`Forgot ${orphan.name || orphan.slug}: removed ${data.counts.records} records, ${data.counts.inventory} inventory rows.`);
      await load();
    } catch (e) {
      toast.error(humanizeApiError(e, `forget ${orphan.name || orphan.slug || orphan.id}`));
    } finally {
      setForgetting(null);
    }
  };

  if (orphans === null) return null; // loading — don't flash empty state
  if (orphans.length === 0) return null; // no orphans — hide entirely

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Orphan sites ({orphans.length})
        </h3>
        <p className="text-xs text-muted-foreground">
          These sites are still in <span className="font-mono">hub_sites</span> but no longer in <span className="font-mono">HUB_SITES</span> env.
          The schedulers don't refresh them and per-site actions refuse on them. Either re-add the site to <span className="font-mono">HUB_SITES</span> env to reactivate, or use Forget to remove the hub's cached copy.
        </p>
      </div>
      <div className="space-y-2">
        {orphans.map((o) => {
          const ageMs = o.removed_from_env_at ? Date.now() - new Date(o.removed_from_env_at).getTime() : null;
          const ageDays = ageMs != null ? Math.floor(ageMs / (24 * 60 * 60 * 1000)) : null;
          return (
            <div key={o.id} className="rounded-md border border-border bg-card p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate">{o.name || o.slug || o.id}</div>
                <div className="text-[11px] text-muted-foreground">
                  {ageDays != null ? `Orphaned ${ageDays} day${ageDays === 1 ? '' : 's'} ago · ` : ''}
                  {o.record_count || 0} record{o.record_count === 1 ? '' : 's'}
                  {o.inventory_count ? ` · ${o.inventory_count} inventory row${o.inventory_count === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleForget(o)}
                disabled={forgetting === o.id}
                className="border-amber-500/40 text-amber-500 hover:bg-amber-500/10 hover:text-amber-400 shrink-0"
              >
                {forgetting === o.id ? 'Forgetting…' : 'Forget'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HubMaintenanceTab() {
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [sites, setSites] = useState([]);
  const [deletingSite, setDeletingSite] = useState(null);

  useEffect(() => {
    fetch('/api/hub/sites', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => setSites(Array.isArray(data) ? data : data.sites || []))
      .catch(err => { toast.error(`Couldn't load sites: ${err.message}`); reportClientError("SettingsPanel.sites", err); });
  }, []);

  const handleDeleteSite = async (siteId, siteName) => {
    if (!confirm(`Delete site "${siteName}" and ALL its hub data? This cannot be undone.`)) return;
    setDeletingSite(siteId);
    try {
      const r = await fetch(`/api/hub/site/${siteId}`, { method: 'DELETE', credentials: 'include' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      toast.success(data.message);
      setSites(prev => prev.filter(s => s.id !== siteId));
    } catch (e) {
      toast.error(e.message || 'Failed to delete site');
    } finally {
      setDeletingSite(null);
    }
  };

  const handlePreview = async () => {
    setLoadingPreview(true);
    try {
      const r = await fetch('/api/hub/dedupe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPreview(data);
      toast.success(`Dry run: ${data.totalRemoved} duplicates found across ${data.groups} groups`);
    } catch (e) {
      toast.error(e.message || 'Dry run failed');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const r = await fetch('/api/hub/dedupe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setPreview(data);
      toast.success(`Removed ${data.totalRemoved} duplicates across ${data.groups} groups`);
    } catch (e) {
      toast.error(e.message || 'Dedupe failed');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <OrphanSitesSection />
      <div>
        <h3 className="text-sm font-semibold mb-1">Hub Maintenance</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Remove duplicate hub records. Keeps the newest record per customer number (per site), preserving flagged records.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handlePreview} disabled={loadingPreview || applying}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loadingPreview ? 'animate-spin' : ''}`} />
            {loadingPreview ? 'Running dry-run...' : 'Dry-run dedupe'}
          </Button>
          <Button size="sm" variant="destructive" onClick={handleApply} disabled={applying || loadingPreview || !preview}>
            <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
            {applying ? 'Applying...' : 'Apply dedupe'}
          </Button>
        </div>
      </div>

      {preview && (
        <div className="space-y-2">
          <p className="text-xs font-medium">
            {preview.dryRun ? 'Preview' : 'Result'}: {preview.groups} duplicate groups, {preview.totalRemoved} records to remove
          </p>
          <div className="max-h-64 overflow-y-auto rounded border text-xs">
            <table className="w-full">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="text-left px-2 py-1">Site</th>
                  <th className="text-left px-2 py-1">Customer #</th>
                  <th className="text-left px-2 py-1">Name</th>
                  <th className="text-right px-2 py-1">Dupes</th>
                </tr>
              </thead>
              <tbody>
                {preview.report.slice(0, 100).map((g, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 text-muted-foreground">{g.site_id?.substring(0, 8)}</td>
                    <td className="px-2 py-1">{g.customer_number}</td>
                    <td className="px-2 py-1">{g.customer_name}</td>
                    <td className="px-2 py-1 text-right">{g.removed_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="border-t pt-4">
        <h3 className="text-sm font-semibold mb-1">Registered Sites</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Remove old or duplicate site registrations. Deleting a site removes all its synced records, inventory, and sync logs from the hub.
        </p>
        {sites.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sites registered.</p>
        ) : (
          <div className="rounded border text-xs">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-2 py-1.5">ID</th>
                  <th className="text-left px-2 py-1.5">Name</th>
                  <th className="text-left px-2 py-1.5">Slug</th>
                  <th className="text-left px-2 py-1.5">Status</th>
                  <th className="text-right px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {sites.map(s => (
                  <tr key={s.id} className="border-t">
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">{s.id}</td>
                    <td className="px-2 py-1.5">{s.name}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{s.slug}</td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        s.status === 'ok' ? 'bg-emerald-500/10 text-emerald-500' :
                        s.status === 'error' ? 'bg-red-500/10 text-red-500' :
                        'bg-muted text-muted-foreground'
                      }`}>{s.status || 'unknown'}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={() => handleDeleteSite(s.id, s.name)}
                        disabled={deletingSite === s.id}
                      >
                        {deletingSite === s.id ? 'Deleting...' : 'Delete'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
