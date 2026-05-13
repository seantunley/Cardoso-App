import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/lib/permissions";
import { humanizeApiError } from "@/lib/humanizeApiError";
import { cleanImportToastMessage, resetCleanSyncStreak } from "@/lib/fun";

// UI
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

// Icons
import {
  Zap, Plus,
  RefreshCw, AlertCircle, CheckCircle2, Clock, LogIn, ClipboardList,
  Download, Upload, GitBranch, Send, Info, Workflow, AlertTriangle,
  Lock, ShieldCheck, ShieldAlert, ExternalLink, Save, Database,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ReconResetModal from "@/components/reconciliation/ReconResetModal";

// Sub-components
import AutoFlagRuleForm from "@/components/settings/AutoFlagRuleForm";
import AuditLogTable from "@/components/audit/AuditLogTable";

// Tabs
import ConnectionsTab from "@/components/settings/tabs/ConnectionsTab";
import FieldsTab from "@/components/settings/tabs/FieldsTab";
import SyncLogTab from "@/components/settings/tabs/SyncLogTab";
import AuditTab from "@/components/settings/tabs/AuditTab";
import AutoFlagTab from "@/components/settings/tabs/AutoFlagTab";
import MaintenanceTab from "@/components/settings/tabs/MaintenanceTab";
import HubMaintenanceTab from "@/components/settings/tabs/HubMaintenanceTab";
import CreditLogicTab from "@/components/settings/tabs/CreditLogicTab";
import AccountingTab from "@/components/settings/tabs/AccountingTab";
import ReconciliationSettingsTab from "@/components/settings/tabs/ReconciliationSettingsTab";



// ─── Main SettingsPanel ──────────────────────────────────────────────────────





// ─── ntopng / Network Settings Tab ────────────────────────────────────────
function NtopngTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["ntopng-settings"],
    queryFn: async () => {
      const r = await fetch("/api/hub/ntopng/settings", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load ntopng settings");
      return r.json();
    },
  });

  const [form, setForm] = useState({ ntopng_url: "", ntopng_user: "", ntopng_password: "" });
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (data) {
      setForm({
        ntopng_url: data.ntopng_url || "http://localhost:3000",
        ntopng_user: data.ntopng_user || "admin",
        // password is redacted server-side; keep blank so user can update it
        ntopng_password: "",
      });
      setDirty(false);
    }
  }, [data]);

  const handleChange = (field, value) => {
    setForm(f => ({ ...f, [field]: value }));
    setDirty(true);
    setTestResult(null);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/hub/ntopng/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error("Save failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("ntopng settings saved");
      queryClient.invalidateQueries(["ntopng-settings"]);
      setDirty(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/hub/ntopng/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      const d = await r.json();
      setTestResult(d.ok ? { ok: true, msg: "Connected — " + (d.version || "ntopng responding") } : { ok: false, msg: d.error || "Connection failed" });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-base font-semibold mb-1">ntopng Connection</h3>
        <p className="text-sm text-muted-foreground mb-4">Configure the ntopng instance running on this Hub machine. Used by the Network Devices dashboard.</p>

        <div className="space-y-4">
          <div>
            <Label className="text-sm font-medium">ntopng URL</Label>
            <Input
              className="mt-1"
              placeholder="http://localhost:3000"
              value={form.ntopng_url}
              onChange={e => handleChange("ntopng_url", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-sm font-medium">Username</Label>
            <Input
              className="mt-1"
              placeholder="admin"
              value={form.ntopng_user}
              onChange={e => handleChange("ntopng_user", e.target.value)}
            />
          </div>
          <div>
            <Label className="text-sm font-medium">Password</Label>
            <Input
              className="mt-1"
              type="password"
              placeholder={data?.password_set ? "(password saved — leave blank to keep)" : "ntopng admin password"}
              value={form.ntopng_password}
              onChange={e => handleChange("ntopng_password", e.target.value)}
            />
          </div>
        </div>

        {testResult && (
          <p className={cn("text-sm mt-3", testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
            {testResult.ok ? "✓" : "✗"} {testResult.msg}
          </p>
        )}

        <div className="flex gap-2 mt-5">
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? "Testing…" : "Test Connection"}
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <h3 className="text-base font-semibold mb-1">Interface Naming Convention</h3>
        <p className="text-sm text-muted-foreground">
          Each site's nProbe instance must use <code className="text-xs bg-muted px-1 py-0.5 rounded">--interface-name nprobe-&lt;slug&gt;</code> where
          <code className="text-xs bg-muted px-1 py-0.5 rounded ml-1">&lt;slug&gt;</code> matches the site slug configured in <strong>HUB_SITES</strong>.
          For example: <code className="text-xs bg-muted px-1 py-0.5 rounded">nprobe-jhb</code>.
        </p>
      </div>
    </div>
  );
}

// ─── TLS Tab ──────────────────────────────────────────────────────────────────
// Surfaces the live state of the Hub's reverse-proxy / TLS deployment so an
// admin can see whether HTTPS is actually fronting the app, when the cert
// expires, and whether the CardosoCaddy service is running. Backed by
// /api/system/tls-status (read-only) and /api/system/tls-renew-cert (POST).
function HubConnectionSection() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState(null);
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/system/hub-url', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      setData(json);
      setDraft(json.configured || json.envSeed || '');
    } catch (e) {
      reportClientError('SettingsPanel.hubUrl.load', e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      const r = await fetch('/api/system/hub-probe', { method: 'POST', credentials: 'include' });
      const json = await r.json();
      setProbe(json);
    } catch (e) {
      setProbe({ ok: false, error: e.message });
    } finally {
      setProbing(false);
    }
  }, []);

  // Auto-probe once on first load so the operator sees green/red without
  // having to click. Subsequent probes are manual via the button.
  useEffect(() => { if (data && !probe) runProbe(); }, [data, probe, runProbe]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/system/hub-url', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: draft.trim() }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      toast.success(draft.trim() ? 'Hub URL updated' : 'Hub URL override cleared');
      setProbe(json.probe || null);
      setEditing(false);
      await load();
    } catch (e) {
      toast.error(e.message || 'Failed to save Hub URL');
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <div className="h-20 animate-pulse bg-muted rounded-xl" />;

  const probeBadge = !probe ? null : probe.ok ? (
    <Badge className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">REACHABLE</Badge>
  ) : (
    <Badge variant="destructive" className="text-[10px]">UNREACHABLE</Badge>
  );

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold mb-1">Hub connection</h3>
          <p className="text-xs text-muted-foreground">
            URL this site uses to reach the Hub for credit-logic sync, central reporting, and SSO. Override the
            installer's <code className="text-[11px] bg-muted px-1 py-0.5 rounded">.env</code> seed without editing files on disk.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {probeBadge}
          <Button variant="ghost" size="sm" onClick={runProbe} disabled={probing} title="Re-test now">
            <RefreshCw className={cn("h-3.5 w-3.5", probing && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="space-y-2 text-xs">
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground w-28 shrink-0">Effective</span>
          <code className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded break-all">{data.effective || '— (not configured)'}</code>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground w-28 shrink-0">Override</span>
          <code className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded break-all">{data.configured || '— (none — using .env)'}</code>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground w-28 shrink-0">.env seed</span>
          <code className="font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded break-all">{data.envSeed || '—'}</code>
        </div>
        {probe && !probe.ok && (
          <div className="flex items-start gap-2 mt-2 text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="break-all">{probe.error}</span>
          </div>
        )}
      </div>

      {!editing ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit override
          </Button>
        </div>
      ) : (
        <div className="space-y-2 pt-1 border-t border-border">
          <label className="text-xs font-medium text-foreground">New hub URL</label>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://cardoso-headoffice.your-tailnet.ts.net:8443"
            className="w-full rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
          />
          <p className="text-[10px] text-muted-foreground">
            Include scheme and any non-default port (e.g. <code>:8443</code> if Caddy isn't on 443). Leave blank to clear the override.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setEditing(false); setDraft(data.configured || data.envSeed || ''); }} disabled={saving}>
              Cancel
            </Button>
            <Button variant="default" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save & probe'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TlsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/system/tls-status', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      setData(json);
    } catch (e) {
      setError(e.message || 'Failed to load TLS status');
      reportClientError('SettingsPanel.tls.load', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRenew = async () => {
    if (!confirm('Re-issue the TLS cert via tailscale and restart the CardosoCaddy service? Brief downtime (~2s) while Caddy restarts.')) return;
    setRenewing(true);
    try {
      const r = await fetch('/api/system/tls-renew-cert', { method: 'POST', credentials: 'include' });
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      toast.success(json.message || 'Cert renewed.');
      await load();
    } catch (e) {
      toast.error(e.message || 'Renewal failed');
      reportClientError('SettingsPanel.tls.renew', e);
    } finally {
      setRenewing(false);
    }
  };

  if (loading && !data) return <div className="h-20 animate-pulse bg-muted rounded-xl" />;
  if (error && !data) {
    return (
      <div className="space-y-3 max-w-3xl">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  const postureMeta = {
    tls_fronted:   { label: 'TLS fronted',     icon: ShieldCheck, tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' },
    http_lan_only: { label: 'HTTP (LAN only)', icon: Lock,        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' },
    partial:       { label: 'Partial / inconsistent', icon: ShieldAlert, tone: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30' },
  };
  const posture = postureMeta[data.posture] || postureMeta.partial;
  const PostureIcon = posture.icon;

  const isWindows = data.platform === 'win32';
  const canRenew = isWindows && data.posture === 'tls_fronted' && data.caddyfile?.hostname;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Posture summary */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-1">TLS deployment status</h3>
          <p className="text-xs text-muted-foreground">
            Live state of the Hub's reverse-proxy and TLS configuration. Read-only — install/uninstall is done via{' '}
            <code className="text-[11px] bg-muted px-1 py-0.5 rounded">scripts/install-hub-caddy.ps1</code> on the Hub server.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} title="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <div className={cn("flex items-center gap-3 rounded-lg border px-4 py-3", posture.tone)}>
        <PostureIcon className="h-5 w-5 shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-semibold">{posture.label}</div>
          <div className="text-xs opacity-80">
            Backend bound to <code className="text-[11px] bg-black/5 dark:bg-white/10 px-1 rounded">{data.bind_address}:{data.port}</code>
            {' · '}TLS_FRONTING={String(data.tls_fronting)}
          </div>
        </div>
      </div>

      {/* Hub connection — sites only. Hub URL was historically only in
          .env, which made port/scheme drift (e.g. Caddy on :8443 but .env
          says :443) invisible until a sync silently failed. Surfacing it
          here lets the operator fix it from the UI without RDP'ing. */}
      {!data.hub_mode && <HubConnectionSection />}

      {/* Runtime */}
      <Section title="Runtime">
        <Row label="Platform" value={data.platform} />
        <Row label="Hub mode" value={String(data.hub_mode)} />
        <Row label="Bind address" value={`${data.bind_address}:${data.port}`} mono />
        <Row label="TLS fronting" value={String(data.tls_fronting)} />
      </Section>

      {/* Caddy install */}
      <Section title="Caddy">
        {!isWindows ? (
          <p className="text-xs text-muted-foreground">Caddy install detection is Windows-only. (Running on {data.platform}.)</p>
        ) : !data.caddy?.installed ? (
          <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Not installed. Run <code className="bg-muted px-1 py-0.5 rounded">scripts/install-hub-caddy.ps1</code> on the Hub server.
          </div>
        ) : (
          <>
            <Row label="Install dir" value={data.caddy.dir} mono />
            <Row label="Executable" value={data.caddy.exe} mono />
          </>
        )}
      </Section>

      {/* Caddyfile */}
      {isWindows && (
        <Section title="Caddyfile">
          {!data.caddyfile ? (
            <p className="text-xs text-muted-foreground">No Caddyfile found.</p>
          ) : (
            <>
              <Row label="Path" value={data.caddyfile.path} mono />
              <Row label="Hostname" value={data.caddyfile.hostname || '—'} mono />
              <Row label="Backend port" value={data.caddyfile.backend_port ?? '—'} mono />
            </>
          )}
        </Section>
      )}

      {/* Cert */}
      {isWindows && (
        <Section title="TLS certificate">
          {!data.cert ? (
            <p className="text-xs text-muted-foreground">No cert found at expected path.</p>
          ) : data.cert.error ? (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {data.cert.error}
            </div>
          ) : (
            <>
              <Row label="Subject" value={data.cert.subject} mono />
              <Row label="Issuer" value={data.cert.issuer} mono />
              <Row label="Valid from" value={data.cert.valid_from} mono />
              <Row label="Valid to" value={data.cert.valid_to} mono />
              <Row
                label="Days until expiry"
                value={
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{data.cert.days_until_expiry}</span>
                    {data.cert.warning === 'expired' && (
                      <Badge variant="destructive" className="text-[10px]">EXPIRED</Badge>
                    )}
                    {data.cert.warning === 'expiring_soon' && (
                      <Badge className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">EXPIRING SOON</Badge>
                    )}
                    {!data.cert.warning && data.cert.days_until_expiry > 0 && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </span>
                }
              />
            </>
          )}
        </Section>
      )}

      {/* Service */}
      {isWindows && (
        <Section title="Windows service">
          <Row label="Name" value={data.service?.name || 'CardosoCaddy'} mono />
          <Row
            label="Status"
            value={
              <span className="flex items-center gap-2">
                <span className="font-mono">{data.service?.status || 'unknown'}</span>
                {data.service?.status === 'running' && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                )}
                {data.service?.status === 'stopped' && (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                )}
                {data.service?.status === 'not_installed' && (
                  <Badge variant="outline" className="text-[10px]">NOT INSTALLED</Badge>
                )}
              </span>
            }
          />
        </Section>
      )}

      {/* Actions */}
      {isWindows && (
        <div className="border-t pt-4 flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={handleRenew}
            disabled={renewing || !canRenew}
            title={!canRenew ? 'Renewal requires a fully TLS-fronted Hub with a Caddyfile hostname.' : undefined}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", renewing && "animate-spin")} />
            {renewing ? 'Renewing…' : 'Renew cert now'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Re-runs <code className="text-[11px] bg-muted px-1 py-0.5 rounded">tailscale cert</code> and restarts Caddy.
          </span>
        </div>
      )}

      {/* Docs */}
      <div className="border-t pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Docs</h4>
        <ul className="space-y-1 text-xs">
          {Object.entries(data.docs || {}).map(([k, v]) => (
            <li key={k} className="flex items-center gap-1.5">
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
              <span className="capitalize text-muted-foreground">{k.replace(/_/g, ' ')}:</span>
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">{v}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border-t pt-4">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("flex-1 break-all", mono && "font-mono")}>{value}</span>
    </div>
  );
}

export default function SettingsPanel({ open, onClose, hubMode }) {
  const { data: currentUser } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });
  const isAdmin = currentUser?.role === "admin";
  const canManageUsers = hasPermission(currentUser, "can_manage_users") || isAdmin;
  const canManageRules = hasPermission(currentUser, "can_manage_rules") || isAdmin;

  // Build tabs based on context
  const tabs = [
    canManageUsers && { id: "users", label: "Users" },
    canManageRules && { id: "creditlogic", label: "Credit Logic" },
    { id: "autoflag", label: "Auto-Flag Rules" },
    { id: "fields", label: "Fields" },
    !hubMode && { id: "connections", label: "Connections" },
    !hubMode && isAdmin && { id: "audit", label: "Audit Log" },
    // System Log + Updates moved to the Operations page (PR #185). Kept
    // out of Settings to avoid two-places-to-look for the same data.
    isAdmin && { id: "tls", label: "TLS" },
    !hubMode && isAdmin && { id: "maintenance", label: "Maintenance" },
    hubMode && { id: "synclog", label: "Sync Log" },
    hubMode && isAdmin && { id: "hubmaintenance", label: "Maintenance" },
    hubMode && isAdmin && { id: "network", label: "Network" },
    isAdmin && { id: "reconciliation", label: "Reconciliation" },
    isAdmin && { id: "accounting", label: "Accounting" },
  ].filter(Boolean);

  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? "autoflag");

  // Reset to first tab when opened
  useEffect(() => { if (open) setActiveTab(tabs[0]?.id ?? "autoflag"); }, [open]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-6xl w-full h-[100dvh] sm:h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-2">
            § Settings
          </div>
          <DialogTitle className="font-display text-4xl leading-tight tracking-tight text-foreground">
            Configure the <em className="text-phosphor">ledger</em>.
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 overflow-hidden">
          <TabsList className="mx-6 mt-4 shrink-0 justify-start overflow-x-auto flex-nowrap">
            {tabs.map(t => (
              <TabsTrigger key={t.id} value={t.id} className="shrink-0">{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <TabsContent value={activeTab} className="mt-0">
              {activeTab === "users" && <UsersTabContent />}
              {activeTab === "creditlogic" && <CreditLogicTab hubMode={hubMode} currentUser={currentUser} />}
              {activeTab === "autoflag" && <AutoFlagTab hubMode={hubMode} />}
              {activeTab === "fields" && <FieldsTab />}
              {activeTab === "audit" && <AuditTab />}
              {activeTab === "tls" && <TlsTab />}
              {activeTab === "synclog" && <SyncLogTab />}
              {activeTab === "connections" && <ConnectionsTab currentUser={currentUser} />}
              {activeTab === "maintenance" && <MaintenanceTab />}
              {activeTab === "hubmaintenance" && <HubMaintenanceTab />}
              {activeTab === "network" && <NtopngTab />}
              {activeTab === "reconciliation" && <ReconciliationSettingsTab />}
              {activeTab === "accounting" && <AccountingTab />}
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// UsersTabContent — render the Users page in embedded mode
function UsersTabContent() {
  // Dynamic import to avoid circular issues at module load time
  const [UsersPage, setUsersPage] = useState(null);
  useEffect(() => {
    import("../../pages/Users").then(m => setUsersPage(() => m.default));
  }, []);
  if (!UsersPage) return <div className="h-20 animate-pulse bg-muted rounded-xl" />;
  return <UsersPage embedded />;
}
