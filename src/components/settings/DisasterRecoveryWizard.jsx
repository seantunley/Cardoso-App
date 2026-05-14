// Disaster recovery wizard — restore this site from Hub backups.
//
// Lives in the Settings panel (admin-only, site-mode only). Six steps:
//   1. Hub credentials + new-machine URL
//   2. Pick a site by name from the Hub's known sites
//   3. Pick a snapshot timestamp for that site
//   4. Snapshot metadata preview + which artifacts to include
//   5. (only when install is non-empty) triple safety gate:
//      tickbox + local admin password + typed confirmation phrase
//   6. Progress page (polls /api/dr/restore-status every 1s)
//
// All state is kept in this component — credentials are deliberately
// not persisted anywhere (no localStorage, no .env). Once the wizard
// closes or the page reloads, the operator types creds again. Hub URL
// gets persisted to .env by the restored snapshot's contents.

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Database,
  Download, Globe, KeyRound, Loader2, Lock, RefreshCw, ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// ── Helpers ────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// Thin wrapper around fetch that surfaces the response body in errors
// (the default fetch errors are useless for diagnosing 4xx responses).
async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const msg = body?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── Component ──────────────────────────────────────────────────────

export default function DisasterRecoveryWizard() {
  // Step navigation
  const [step, setStep] = useState(1);

  // Step 1: Hub creds + new machine URL
  const [hubUrl, setHubUrl] = useState("");
  const [hubEmail, setHubEmail] = useState("");
  const [hubPassword, setHubPassword] = useState("");
  const [newSiteUrl, setNewSiteUrl] = useState(() => {
    if (typeof window !== "undefined" && window.location) {
      return `${window.location.protocol}//${window.location.host}`;
    }
    return "";
  });

  // Step 1 → 2: list-sites response
  const [sites, setSites] = useState(null); // null = not loaded; [] = no sites
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);

  // Step 2: chosen site
  const [selectedSiteId, setSelectedSiteId] = useState("");

  // Step 3: chosen snapshot
  const [selectedSnapshotFilename, setSelectedSnapshotFilename] = useState("");

  // Step 4: snapshot metadata preview + includes
  const [snapshotMeta, setSnapshotMeta] = useState(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState(null);
  const [includes, setIncludes] = useState({
    previews: true, jti_archive: true, bat_archive: true, env: true,
  });

  // Local install state — used only for the wizard's UX summary
  // ("this install has X reconciliations, restoring will overwrite").
  // The auth gate (step 5) is REQUIRED ALWAYS regardless — the previous
  // design's "skip the gate on empty installs" was a real LAN-attacker
  // race. Re-fetched on entering step 4 in case anything changed
  // mid-wizard. Fail-CLOSED: a fetch error reports the install as
  // non-empty so the wizard's UX warning still appears.
  const [installState, setInstallState] = useState(null); // { empty, hub_mode } | null
  const refreshInstallState = useCallback(() => {
    fetch("/api/dr/install-state")
      .then((r) => r.json())
      .then((data) => setInstallState(data))
      .catch(() => setInstallState({ empty: false })); // fail-closed
  }, []);
  useEffect(() => { refreshInstallState(); }, [refreshInstallState]);
  useEffect(() => { if (step === 4) refreshInstallState(); }, [step, refreshInstallState]);

  // Step 5: override gate
  const [overrideAck, setOverrideAck] = useState(false);
  const [overrideLocalPassword, setOverrideLocalPassword] = useState("");
  const [overrideConfirmPhrase, setOverrideConfirmPhrase] = useState("");

  // Step 6: kick-off + status polling
  const [restoreId, setRestoreId] = useState(null);
  const [restoreStatus, setRestoreStatus] = useState(null);
  const [pollError, setPollError] = useState(null);
  const pollAbortRef = useRef(false);

  // Derived: site/snapshot lookups
  const selectedSite = useMemo(
    () => sites?.find((s) => s.id === selectedSiteId) || null,
    [sites, selectedSiteId],
  );
  const selectedSnapshot = useMemo(
    () => selectedSite?.snapshots?.find((s) => s.filename === selectedSnapshotFilename) || null,
    [selectedSite, selectedSnapshotFilename],
  );

  // Phrase the operator must type verbatim during the override gate.
  const expectedPhrase = useMemo(() => {
    if (!selectedSite) return "";
    return `OVERWRITE ${selectedSite.name}`;
  }, [selectedSite]);

  // Whether the install is in "empty" state — affects only the
  // wizard's UX copy. The override gate (step 5) shows ALWAYS.
  const installIsNonEmpty = !!(installState && !installState.empty);

  // ── Step 1 → 2: fetch sites ──
  const handleListSites = useCallback(async () => {
    setListError(null);
    setListLoading(true);
    try {
      // Plain http:// allowed for now (per design decision); the
      // wizard shows a yellow warning in step 1 instead of blocking.
      const data = await jsonFetch(`${hubUrl.replace(/\/$/, "")}/api/hub/dr/list-sites`, {
        method: "POST",
        body: { email: hubEmail, password: hubPassword },
      });
      setSites(data.sites || []);
      setStep(2);
    } catch (e) {
      setListError(e.message);
    } finally {
      setListLoading(false);
    }
  }, [hubUrl, hubEmail, hubPassword]);

  // ── Step 3 → 4: fetch snapshot metadata preview ──
  useEffect(() => {
    if (step !== 4 || !selectedSiteId || !selectedSnapshotFilename) return;
    setMetaError(null);
    setSnapshotMeta(null);
    setMetaLoading(true);
    jsonFetch(
      `${hubUrl.replace(/\/$/, "")}/api/hub/dr/snapshot-meta/${encodeURIComponent(selectedSiteId)}/${encodeURIComponent(selectedSnapshotFilename)}`,
      { method: "POST", body: { email: hubEmail, password: hubPassword } },
    )
      .then((data) => setSnapshotMeta(data))
      .catch((e) => setMetaError(e.message))
      .finally(() => setMetaLoading(false));
  }, [step, selectedSiteId, selectedSnapshotFilename, hubUrl, hubEmail, hubPassword]);

  // ── Step 5/6: kick off restore ──
  const handleStartRestore = useCallback(async () => {
    setPollError(null);
    try {
      const body = {
        hub_url: hubUrl.replace(/\/$/, ""),
        hub_email: hubEmail,
        hub_password: hubPassword,
        site_id: selectedSiteId,
        snapshot_filename: selectedSnapshotFilename,
        includes,
        new_site_url: newSiteUrl,
        // Override block is REQUIRED ALWAYS. The server derives the
        // expected phrase from the Hub's authoritative site name — we
        // do NOT send our local `expectedPhrase` since the server
        // shouldn't trust a client-supplied "what I'm supposed to
        // match" value.
        override: {
          local_admin_password: overrideLocalPassword,
          confirmation_phrase: overrideConfirmPhrase,
        },
      };
      const data = await jsonFetch("/api/dr/restore-from-hub", {
        method: "POST",
        body,
      });
      setRestoreId(data.restore_id);
      setStep(6);
    } catch (e) {
      setPollError(e.message);
    }
  }, [
    hubUrl, hubEmail, hubPassword, selectedSiteId, selectedSnapshotFilename,
    includes, newSiteUrl, installIsNonEmpty, overrideLocalPassword,
    overrideConfirmPhrase, expectedPhrase,
  ]);

  // ── Step 6: poll status ──
  useEffect(() => {
    if (step !== 6 || !restoreId) return;
    pollAbortRef.current = false;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled && !pollAbortRef.current) {
        try {
          const r = await fetch(`/api/dr/restore-status/${restoreId}`);
          if (!r.ok) {
            // 404 likely means the service has rebooted post-restore;
            // memory-resident status is gone but the swap succeeded.
            if (r.status === 404 && restoreStatus?.phase === "handed_off") {
              return; // stop polling — terminal state already shown
            }
            throw new Error(`HTTP ${r.status}`);
          }
          const data = await r.json();
          if (!cancelled) setRestoreStatus(data);
          if (data.terminal) return; // stop polling at handed_off / failed
        } catch (e) {
          // Connection refused after handed_off is the EXPECTED swap
          // window — service is rebooting. Surface as informational
          // rather than a poll error.
          if (restoreStatus?.phase === "handed_off") return;
          if (!cancelled) setPollError(e.message);
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    };
    poll();
    return () => { cancelled = true; pollAbortRef.current = true; };
  }, [step, restoreId, restoreStatus?.phase]);

  // ── Render: route to step ──
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-amber-500" />
          Restore this site from Hub backups
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Pull this site's data from the Hub and apply it locally. Use this on a
          fresh install (cold restore) or to roll back to a known-good snapshot.
          Live files are backed up to <code>*.before-restore-&lt;ts&gt;</code> on
          disk; rollback is automatic on any failure.
        </p>
      </div>

      <StepIndicator step={step} />

      {step === 1 && (
        <Step1Credentials
          hubUrl={hubUrl} setHubUrl={setHubUrl}
          hubEmail={hubEmail} setHubEmail={setHubEmail}
          hubPassword={hubPassword} setHubPassword={setHubPassword}
          newSiteUrl={newSiteUrl} setNewSiteUrl={setNewSiteUrl}
          onNext={handleListSites}
          loading={listLoading} error={listError}
        />
      )}

      {step === 2 && (
        <Step2PickSite
          sites={sites} selectedSiteId={selectedSiteId}
          setSelectedSiteId={setSelectedSiteId}
          onBack={() => setStep(1)} onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <Step3PickSnapshot
          site={selectedSite}
          selectedSnapshotFilename={selectedSnapshotFilename}
          setSelectedSnapshotFilename={setSelectedSnapshotFilename}
          onBack={() => setStep(2)} onNext={() => setStep(4)}
        />
      )}

      {step === 4 && (
        <Step4Confirm
          site={selectedSite} snapshot={selectedSnapshot}
          meta={snapshotMeta} metaLoading={metaLoading} metaError={metaError}
          includes={includes} setIncludes={setIncludes}
          installIsNonEmpty={installIsNonEmpty}
          onBack={() => setStep(3)}
          onNext={() => setStep(5)}
          startError={pollError}
        />
      )}

      {step === 5 && (
        <Step5Override
          site={selectedSite} expectedPhrase={expectedPhrase}
          ack={overrideAck} setAck={setOverrideAck}
          localPassword={overrideLocalPassword} setLocalPassword={setOverrideLocalPassword}
          confirmPhrase={overrideConfirmPhrase} setConfirmPhrase={setOverrideConfirmPhrase}
          onBack={() => setStep(4)}
          onStart={handleStartRestore}
          startError={pollError}
        />
      )}

      {step === 6 && (
        <Step6Progress
          status={restoreStatus} pollError={pollError}
        />
      )}
    </div>
  );
}

// ── Step indicator ────────────────────────────────────────────────

function StepIndicator({ step }) {
  const labels = ["1. Credentials", "2. Site", "3. Snapshot", "4. Confirm", "5. Override gate", "6. Restoring"];
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      {labels.map((label, i) => {
        const stepNum = i + 1;
        const active = step === stepNum;
        const done = step > stepNum;
        return (
          <span key={label} className={
            done ? "text-phosphor"
            : active ? "text-foreground font-bold"
            : "text-muted-foreground"
          }>
            {label}{i < labels.length - 1 ? " →" : ""}
          </span>
        );
      })}
    </div>
  );
}

// ── Step 1: Hub credentials + new machine URL ─────────────────────

function Step1Credentials(props) {
  const {
    hubUrl, setHubUrl, hubEmail, setHubEmail,
    hubPassword, setHubPassword, newSiteUrl, setNewSiteUrl,
    onNext, loading, error,
  } = props;

  const isHttp = /^http:/i.test(hubUrl);
  const canNext = hubUrl && hubEmail && hubPassword && newSiteUrl && !loading;

  return (
    <div className="space-y-4 border border-border rounded-lg p-5">
      <div className="space-y-2">
        <Label htmlFor="hub-url" className="flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5" /> Hub URL
        </Label>
        <Input
          id="hub-url" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)}
          placeholder="https://hub.example.com"
        />
        {isHttp && (
          <p className="text-xs text-amber-600 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Sending Hub credentials over plain HTTP. Switch to https:// once
            the Hub has TLS configured.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="hub-email">Hub admin email</Label>
          <Input
            id="hub-email" type="email" value={hubEmail}
            onChange={(e) => setHubEmail(e.target.value)}
            placeholder="admin@example.com" autoComplete="username"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="hub-pass">Hub admin password</Label>
          <Input
            id="hub-pass" type="password" value={hubPassword}
            onChange={(e) => setHubPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
      </div>

      <div className="space-y-2 pt-2 border-t border-border">
        <Label htmlFor="new-url" className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" /> URL the Hub should use to reach this machine
        </Label>
        <Input
          id="new-url" value={newSiteUrl}
          onChange={(e) => setNewSiteUrl(e.target.value)}
          placeholder="https://this-machine.example.com"
        />
        <p className="text-xs text-muted-foreground">
          Defaults to the URL in your browser. After restore, the Hub will use
          this URL to push restores and check site health.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Cannot reach Hub</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end pt-2">
        <Button onClick={onNext} disabled={!canNext}>
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArrowRight className="h-4 w-4 mr-2" />}
          Continue
        </Button>
      </div>
    </div>
  );
}

// ── Step 2: pick site ──────────────────────────────────────────────

function Step2PickSite({ sites, selectedSiteId, setSelectedSiteId, onBack, onNext }) {
  return (
    <div className="space-y-4 border border-border rounded-lg p-5">
      <div className="space-y-2">
        <Label>Site to restore as</Label>
        {sites?.length ? (
          <Select value={selectedSiteId} onValueChange={setSelectedSiteId}>
            <SelectTrigger><SelectValue placeholder="Pick a site by name" /></SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} <span className="text-muted-foreground ml-2">
                    ({s.snapshots?.length ?? 0} snapshot{s.snapshots?.length === 1 ? "" : "s"})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Alert>
            <AlertTitle>No sites available</AlertTitle>
            <AlertDescription>
              The Hub returned no sites with backups. Check that the Hub has at least
              one site configured and that backups have been pulled at least once.
            </AlertDescription>
          </Alert>
        )}
      </div>
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
        <Button onClick={onNext} disabled={!selectedSiteId}>
          <ArrowRight className="h-4 w-4 mr-2" /> Continue
        </Button>
      </div>
    </div>
  );
}

// ── Step 3: pick snapshot ──────────────────────────────────────────

function Step3PickSnapshot(props) {
  const { site, selectedSnapshotFilename, setSelectedSnapshotFilename, onBack, onNext } = props;
  const snapshots = site?.snapshots || [];
  return (
    <div className="space-y-4 border border-border rounded-lg p-5">
      <div className="space-y-2">
        <Label>Snapshot for {site?.name}</Label>
        {snapshots.length ? (
          <div className="border border-border rounded-md max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider sticky top-0 bg-background">
                <tr className="border-b border-border">
                  <th className="text-left px-3 py-2">Pick</th>
                  <th className="text-left px-3 py-2">Timestamp</th>
                  <th className="text-right px-3 py-2">DB size</th>
                  <th className="text-center px-3 py-2">prev</th>
                  <th className="text-center px-3 py-2">jti</th>
                  <th className="text-center px-3 py-2">bat</th>
                  <th className="text-center px-3 py-2">env</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.filename}
                    className={`border-b border-border last:border-0 cursor-pointer hover:bg-muted/40 ${
                      selectedSnapshotFilename === s.filename ? "bg-phosphor/5" : ""
                    }`}
                    onClick={() => setSelectedSnapshotFilename(s.filename)}
                  >
                    <td className="px-3 py-2">
                      <input type="radio" checked={selectedSnapshotFilename === s.filename} readOnly />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{fmtDate(s.mtime)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtBytes(s.size_bytes)}</td>
                    <td className="px-3 py-2 text-center">{s.previews_filename ? "✓" : "—"}</td>
                    <td className="px-3 py-2 text-center">{s.jti_archive_filename ? "✓" : "—"}</td>
                    <td className="px-3 py-2 text-center">{s.bat_archive_filename ? "✓" : "—"}</td>
                    <td className="px-3 py-2 text-center">{s.env_filename ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Alert>
            <AlertTitle>No snapshots</AlertTitle>
            <AlertDescription>This site has no Hub-side backups yet.</AlertDescription>
          </Alert>
        )}
      </div>
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
        <Button onClick={onNext} disabled={!selectedSnapshotFilename}>
          <ArrowRight className="h-4 w-4 mr-2" /> Continue
        </Button>
      </div>
    </div>
  );
}

// ── Step 4: confirm + includes ─────────────────────────────────────

function Step4Confirm(props) {
  const {
    site, snapshot, meta, metaLoading, metaError,
    includes, setIncludes, installIsNonEmpty,
    onBack, onNext, startError,
  } = props;

  const toggleInclude = (key) =>
    setIncludes((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-4 border border-border rounded-lg p-5">
      <div className="space-y-2">
        <div className="text-sm">
          <span className="text-muted-foreground">Restoring as: </span>
          <strong>{site?.name}</strong>
        </div>
        <div className="text-sm font-mono text-xs">
          Snapshot: {snapshot?.filename}
        </div>
      </div>

      <div className="border border-border rounded-md p-3 bg-muted/20">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
          Snapshot contents
        </div>
        {metaLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading snapshot metadata…
          </div>
        )}
        {metaError && (
          <Alert variant="destructive"><AlertDescription>{metaError}</AlertDescription></Alert>
        )}
        {meta && (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <Row label="Integrity" value={
                <Badge variant={meta.integrity === "ok" ? "secondary" : "destructive"}>
                  {meta.integrity}
                </Badge>
              } />
              <Row label="Users" value={`${meta.counts.users ?? "—"} (${meta.counts.admins ?? "—"} admin)`} />
              <Row label="Customers" value={meta.counts.customers ?? "—"} />
              <Row label="Reconciliations" value={meta.counts.reconciliations ?? "—"} />
              <Row label="OCR extractions" value={meta.counts.extractions ?? "—"} />
              <Row label="Audit entries" value={meta.counts.audit_entries ?? "—"} />
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mt-3 pt-3 border-t border-border">
              <Row label="Last audit" value={fmtDate(meta.last_activity?.audit)} />
              <Row label="Last recon" value={fmtDate(meta.last_activity?.reconciliation)} />
            </div>
          </>
        )}
      </div>

      <div className="space-y-2">
        <Label>Companion files to restore</Label>
        <div className="space-y-1.5">
          {[
            { key: "previews",    label: "BAT preview JPEGs",       file: snapshot?.previews_filename, size: snapshot?.previews_size_bytes },
            { key: "jti_archive", label: "JTI export history",      file: snapshot?.jti_archive_filename, size: snapshot?.jti_archive_size_bytes },
            { key: "bat_archive", label: "BAT supplier source files", file: snapshot?.bat_archive_filename, size: snapshot?.bat_archive_size_bytes },
            { key: "env",         label: "Site .env (encryption keys, secrets)", file: snapshot?.env_filename, size: snapshot?.env_size_bytes },
          ].map(({ key, label, file, size }) => (
            <label key={key}
              className={`flex items-center gap-3 p-2 rounded border ${
                file ? "border-border" : "border-dashed border-muted-foreground/40 opacity-60"
              }`}
            >
              <Checkbox
                checked={!!file && includes[key]}
                disabled={!file}
                onCheckedChange={() => toggleInclude(key)}
              />
              <div className="flex-1 text-sm">
                {label}
                {!file && <span className="ml-2 text-xs text-muted-foreground">(not in snapshot)</span>}
              </div>
              <div className="text-xs text-muted-foreground font-mono">{fmtBytes(size)}</div>
            </label>
          ))}
        </div>
      </div>

      <Alert variant={installIsNonEmpty ? "destructive" : "default"}>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>
          {installIsNonEmpty ? "This install is not empty" : "Confirmation required"}
        </AlertTitle>
        <AlertDescription>
          {installIsNonEmpty
            ? "Continuing will OVERWRITE the live database, .env, and uploads folders. Next step requires the local admin password and a typed confirmation phrase."
            : "Even on a fresh install you must enter the local admin password and a typed confirmation phrase in the next step. This prevents a stolen Hub credential from being enough on its own to clobber this machine."}
        </AlertDescription>
      </Alert>

      {startError && (
        <Alert variant="destructive"><AlertDescription>{startError}</AlertDescription></Alert>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
        <Button onClick={onNext}>
          <ArrowRight className="h-4 w-4 mr-2" /> Continue to confirm
        </Button>
      </div>
    </div>
  );
}

// ── Step 5: override gate ─────────────────────────────────────────

function Step5Override(props) {
  const {
    site, expectedPhrase,
    ack, setAck, localPassword, setLocalPassword,
    confirmPhrase, setConfirmPhrase,
    onBack, onStart, startError,
  } = props;

  const phraseMatches = confirmPhrase === expectedPhrase;
  // `ack === true` rather than truthy — Radix's Checkbox can pass
  // `"indeterminate"` to onCheckedChange (a stray click on the
  // chevron-area on some browsers), which would otherwise be truthy
  // and unlock the Restore button on a half-tick.
  const canStart = ack === true && localPassword && phraseMatches;

  return (
    <div className="space-y-4 border border-destructive rounded-lg p-5 bg-destructive/5">
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Triple safety gate</AlertTitle>
        <AlertDescription>
          You're about to overwrite an existing install with snapshot data
          for <strong>{site?.name}</strong>. All three controls below are
          required before the wizard will proceed.
        </AlertDescription>
      </Alert>

      <label className="flex items-start gap-3 p-3 border border-border rounded">
        <Checkbox checked={ack === true} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5" />
        <div className="text-sm">
          <strong>I understand this will replace all local data.</strong>
          <p className="text-xs text-muted-foreground mt-1">
            Live files will be moved to *.before-restore-&lt;ts&gt; for
            rollback, but only if apply-restore.ps1 starts cleanly.
          </p>
        </div>
      </label>

      <div className="space-y-2">
        <Label htmlFor="local-pass" className="flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5" /> Local admin password
        </Label>
        <Input
          id="local-pass" type="password" value={localPassword}
          onChange={(e) => setLocalPassword(e.target.value)}
          autoComplete="current-password"
        />
        <p className="text-xs text-muted-foreground">
          The password for an admin account on THIS install (not the Hub).
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="phrase" className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5" /> Type to confirm
        </Label>
        <div className="text-xs font-mono p-2 bg-muted rounded border border-border">
          {expectedPhrase}
        </div>
        <Input
          id="phrase" value={confirmPhrase}
          onChange={(e) => setConfirmPhrase(e.target.value)}
          placeholder="Type the phrase above exactly"
          className={confirmPhrase && !phraseMatches ? "border-destructive" : ""}
        />
        {confirmPhrase && !phraseMatches && (
          <p className="text-xs text-destructive">Phrase doesn't match.</p>
        )}
      </div>

      {startError && (
        <Alert variant="destructive"><AlertDescription>{startError}</AlertDescription></Alert>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
        <Button variant="destructive" onClick={onStart} disabled={!canStart}>
          <Download className="h-4 w-4 mr-2" /> Restore (will overwrite)
        </Button>
      </div>
    </div>
  );
}

// ── Step 6: progress ──────────────────────────────────────────────

function Step6Progress({ status, pollError }) {
  if (!status) {
    return (
      <div className="space-y-4 border border-border rounded-lg p-5">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Queuing restore…
        </div>
      </div>
    );
  }

  const pct = status.total_files
    ? Math.round((status.files_completed / status.total_files) * 100)
    : 0;
  const isHandedOff = status.phase === "handed_off";
  const isFailed = status.phase === "failed";

  return (
    <div className="space-y-4 border border-border rounded-lg p-5">
      <div className="flex items-center gap-2">
        {isHandedOff ? (
          <CheckCircle2 className="h-5 w-5 text-phosphor" />
        ) : isFailed ? (
          <AlertTriangle className="h-5 w-5 text-destructive" />
        ) : (
          <RefreshCw className="h-4 w-4 animate-spin text-foreground" />
        )}
        <div className="font-mono text-xs uppercase tracking-wider">{status.phase}</div>
      </div>

      <div className="text-sm">{status.message}</div>

      {status.current_file && (
        <div className="text-xs font-mono text-muted-foreground">
          → {status.current_file}
        </div>
      )}

      {status.total_files > 0 && (
        <>
          <Progress value={pct} />
          <div className="text-xs text-muted-foreground">
            {status.files_completed} of {status.total_files} files · {fmtBytes(status.bytes_downloaded)} downloaded
          </div>
        </>
      )}

      {status.companion_failures?.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Some companion files were skipped</AlertTitle>
          <AlertDescription>
            <ul className="text-xs font-mono mt-2 space-y-0.5">
              {status.companion_failures.map((f, i) => (
                <li key={i}>
                  {f.key}: {f.missing ? "not in snapshot (404)" : f.error}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {status.error && (
        <Alert variant="destructive">
          <AlertTitle>Restore failed</AlertTitle>
          <AlertDescription className="font-mono text-xs">{status.error}</AlertDescription>
        </Alert>
      )}

      {isHandedOff && (
        <Alert>
          <Database className="h-4 w-4" />
          <AlertTitle>File swap in progress</AlertTitle>
          <AlertDescription>
            The Cardoso service is stopping for the swap. Your browser tab may
            disconnect for a few seconds. Once it reconnects, log in with the
            credentials from the RESTORED snapshot — not the local bootstrap
            admin. If anything fails, the live files were saved as
            <code> *.before-restore-&lt;ts&gt;</code> for manual rollback.
          </AlertDescription>
        </Alert>
      )}

      {pollError && status.phase !== "handed_off" && (
        <Alert variant="destructive"><AlertDescription>Poll error: {pollError}</AlertDescription></Alert>
      )}
    </div>
  );
}

// ── Local helper ──────────────────────────────────────────────────

function Row({ label, value }) {
  return (
    <>
      <div className="text-muted-foreground text-xs uppercase tracking-wider">{label}</div>
      <div className="text-right font-mono text-xs">{value}</div>
    </>
  );
}
