// Hub-side Kopia status reader.
//
// The hub runs the Kopia repository server (see docs/kopia-backups.md); every
// site agent pushes snapshots of its data tree to it. This module lets the hub
// app READ that repo — without being the thing that creates backups — so the
// dashboard and an alert rule can answer "is each site's off-site backup
// actually working?".
//
// Design: the impure part (shelling `kopia`) is isolated in getKopiaStatus();
// the verdict logic (summarizeKopiaSnapshots) is a pure function over the JSON
// kopia emits, so it's unit-tested without a real binary or repo.
//
// Everything is gated behind KOPIA_ENABLED — absent/false ⇒ the feature is
// inert and getKopiaStatus() reports { enabled: false }.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// 24h site cadence + 2h buffer, matching the rest of the system's "stale"
// convention (BACKUP_STALE_HOURS / NIGHTLY_STALE_HOURS). Env-tunable.
export function getKopiaStaleHours() {
  const n = parseInt(process.env.KOPIA_SITE_STALE_HOURS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 26;
}

export function isKopiaEnabled() {
  return process.env.KOPIA_ENABLED === 'true';
}

/**
 * Group a flat `kopia snapshot list --json` array by site and compute a
 * per-site freshness verdict. Pure — no I/O.
 *
 * Site identity = the snapshot source host (the agent connects with
 * --override-hostname=<SiteName>). Pure function so tests can pin the
 * fire/clear boundaries without a kopia binary.
 *
 * @param {Array<object>} snapshots  parsed `kopia snapshot list --json`
 * @param {{ now?: number, staleHours?: number }} [opts]
 * @returns {Array<{ site: string, user: string|null, count: number,
 *   last_snapshot_at: string|null, age_hours: number|null, total_bytes: number|null,
 *   status: 'ok'|'critical', reason: string }>} one row per site, sorted by site
 */
export function summarizeKopiaSnapshots(snapshots, { now = Date.now(), staleHours = 26 } = {}) {
  const bySite = new Map();
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    const src = s?.source || {};
    const site = src.host || 'unknown';
    // endTime is when the snapshot finished; fall back to startTime.
    const tsStr = s?.endTime || s?.startTime || null;
    const t = tsStr ? new Date(tsStr).getTime() : NaN;
    const bytes = Number(s?.stats?.totalSize);

    const cur = bySite.get(site) || { site, user: src.userName || null, count: 0, newestMs: -Infinity, newestStr: null, total_bytes: null };
    cur.count += 1;
    if (Number.isFinite(t) && t > cur.newestMs) {
      cur.newestMs = t;
      cur.newestStr = tsStr;
      cur.total_bytes = Number.isFinite(bytes) ? bytes : cur.total_bytes;
    }
    bySite.set(site, cur);
  }

  return [...bySite.values()]
    .map((c) => {
      const ageHours = c.newestMs > -Infinity ? (now - c.newestMs) / 3_600_000 : null;
      const stale = ageHours == null || ageHours > staleHours;
      return {
        site: c.site,
        user: c.user,
        count: c.count,
        last_snapshot_at: c.newestStr,
        age_hours: ageHours == null ? null : Number(ageHours.toFixed(2)),
        total_bytes: c.total_bytes,
        status: stale ? 'critical' : 'ok',
        reason: ageHours == null ? 'no_valid_timestamp' : stale ? 'stale' : 'ok',
      };
    })
    .sort((a, b) => a.site.localeCompare(b.site));
}

/**
 * The Kopia source HOST identity for a site. Kopia's repository server requires
 * a lowercase `username@hostname`, so a display name like "Cardoso Site" or
 * "Ermelo" can't be used directly (spaces / uppercase). The agent connects with
 * `--override-hostname=<this>` and the hub matches snapshots back to sites by
 * the same value. Prefer slug, then id; lowercase + sanitise.
 *
 * @param {{ id?: string, slug?: string }} site
 * @returns {string}
 */
export function normalizeKopiaHost(site) {
  return String(site?.slug || site?.id || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Merge the per-site snapshot summary with the hub's known site list so sites
 * that have NEVER pushed a snapshot show up as critical rather than silently
 * missing. Pure. Matches by the normalized Kopia host (slug/id), NOT the display
 * name — the agent's --override-hostname is that normalized value.
 *
 * @param {Array<{id:string,name?:string,slug?:string}>} knownSites  from hub_sites
 * @param {Array<object>} summary  output of summarizeKopiaSnapshots (keyed by host)
 * @returns {Array<object>} one row per known site (+ any extra sites in the repo)
 */
export function mergeWithKnownSites(knownSites, summary) {
  const bySite = new Map(summary.map((r) => [r.site, r]));
  const out = [];
  const seen = new Set();
  for (const ks of knownSites || []) {
    const host = normalizeKopiaHost(ks);
    seen.add(host);
    const found = bySite.get(host);
    if (found) {
      out.push({ ...found, site_id: ks.id, site_name: ks.name || null });
    } else {
      out.push({
        site: host, site_id: ks.id, site_name: ks.name || null,
        user: null, count: 0, last_snapshot_at: null, age_hours: null,
        total_bytes: null, status: 'critical', reason: 'never',
      });
    }
  }
  // Snapshots present in the repo for a host we don't recognise — surface them
  // too rather than hiding data.
  for (const r of summary) {
    if (!seen.has(r.site)) out.push({ ...r, site_id: null, site_name: null });
  }
  return out.sort((a, b) => String(a.site_name || a.site).localeCompare(String(b.site_name || b.site)));
}

function kopiaEnv() {
  const env = { ...process.env };
  if (process.env.KOPIA_PASSWORD) env.KOPIA_PASSWORD = process.env.KOPIA_PASSWORD;
  return env;
}

// Async on purpose. This app is event-loop-freeze sensitive (the very thing
// that broke backups); shelling kopia synchronously inside a request handler /
// the once-a-minute alert loop would block every other request for up to the
// timeout. execFile keeps it off the main thread.
async function runKopiaJson(args) {
  const exe = process.env.KOPIA_EXE || 'kopia';
  const fullArgs = [...args];
  if (process.env.KOPIA_CONFIG_FILE) fullArgs.unshift('--config-file', process.env.KOPIA_CONFIG_FILE);
  const { stdout } = await execFileAsync(exe, fullArgs, {
    env: kopiaEnv(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

/**
 * Read live Kopia status for the dashboard. Shells `kopia` (read-only, async).
 * Never throws — failures become a structured error verdict so a kopia/repo
 * problem is surfaced, not swallowed.
 *
 * @param {{ now?: number, knownSites?: Array }} [opts]
 * @returns {Promise<{ enabled: boolean, ok: boolean, repo: object|null, sites: Array, error: string|null, stale_hours: number }>}
 */
export async function getKopiaStatus({ now = Date.now(), knownSites = [] } = {}) {
  const stale_hours = getKopiaStaleHours();
  // Optional link to Kopia's own web UI (`kopia server start --ui`). Set
  // KOPIA_UI_URL to the server address to surface an "Open Kopia UI" button on
  // the Hub Backups page. Null when unset — the button stays hidden.
  const ui_url = process.env.KOPIA_UI_URL || null;
  if (!isKopiaEnabled()) {
    return { enabled: false, ok: false, repo: null, sites: [], error: null, stale_hours, ui_url };
  }

  let snapshots;
  try {
    snapshots = await runKopiaJson(['snapshot', 'list', '--all', '--json']);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).slice(0, 500);
    return {
      enabled: true, ok: false, repo: { ok: false, error: msg }, sites: [],
      error: `kopia snapshot list failed: ${msg}`, stale_hours, ui_url,
    };
  }

  let repo = { ok: true };
  try {
    const status = await runKopiaJson(['repository', 'status', '--json']);
    repo = { ok: true, config_file: status?.configFile || null, storage: status?.storage || null };
  } catch (err) {
    // Snapshot list worked, so the repo is reachable enough; record the soft error.
    repo = { ok: true, status_error: String(err?.message || err).slice(0, 300) };
  }

  const summary = summarizeKopiaSnapshots(snapshots, { now, staleHours: stale_hours });
  const sites = mergeWithKnownSites(knownSites, summary);
  const ok = sites.length > 0 && sites.every((s) => s.status === 'ok');
  return { enabled: true, ok, repo, sites, error: null, stale_hours, ui_url };
}

/**
 * Every snapshot for ONE site's Kopia host, newest first — powers the in-app
 * "View snapshots" viewer on the Hub Backups page. Read-only: shells `kopia
 * snapshot list --all --json` (off the main thread) and filters to the host,
 * so it can't mutate the repo. Never throws — a kopia/repo failure comes back
 * as a structured error.
 *
 * @param {{ host: string }} args  host = normalizeKopiaHost(site)
 * @returns {Promise<{ enabled: boolean, snapshots: object[], error: string|null }>}
 */
export async function listHostSnapshots({ host } = {}) {
  if (!isKopiaEnabled()) return { enabled: false, snapshots: [], error: null };
  if (!host) return { enabled: true, snapshots: [], error: null };

  let raw;
  try {
    raw = await runKopiaJson(['snapshot', 'list', '--all', '--json']);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).slice(0, 500);
    return { enabled: true, snapshots: [], error: `kopia snapshot list failed: ${msg}` };
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const snapshots = (Array.isArray(raw) ? raw : [])
    .filter((s) => (s?.source?.host || '') === host)
    .map((s) => {
      const endTime = s?.endTime || s?.startTime || null;
      const totalSize = num(s?.stats?.totalSize ?? s?.rootEntry?.summ?.size);
      return {
        id: s?.id || null,
        rootID: s?.rootEntry?.obj || null,
        startTime: s?.startTime || null,
        endTime,
        totalSize,
        fileCount: num(s?.stats?.fileCount ?? s?.rootEntry?.summ?.files),
        dirCount: num(s?.stats?.dirCount ?? s?.rootEntry?.summ?.dirs),
        incomplete: !!s?.incomplete,
        // Fields the source-agnostic RestoreDialog reads, so the Off-site tab
        // of the restore flow can list these same snapshots.
        filename: s?.id || endTime || 'snapshot',
        mtime: endTime,
        size_bytes: totalSize,
        previews_filename: null,
        previews_size_bytes: null,
        integrity: null,
      };
    })
    .sort((a, b) => new Date(b.endTime || 0).getTime() - new Date(a.endTime || 0).getTime());

  return { enabled: true, snapshots, error: null };
}
