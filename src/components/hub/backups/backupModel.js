// Normalises the three independent hub-backup data sources into ONE per-site
// model the view renders from. The old page threaded `site`, `hubData`,
// `kopia`, `kopiaEnabled` into every component and re-derived status inline;
// this collapses them into a stable `{ id, name, layers, overallTone }` shape
// so the view is pure and the demo fixtures can produce the exact same thing.
//
// The three sources (all keyed by site id):
//   backupStatus.sites[]  — live poll of each site: App backup + SQL backup
//   hubBackupMap[id]       — the .db copies the hub has PULLED for that site
//   kopiaMap[id]           — the off-site (Kopia) snapshot verdict
//
// Four logical layers per site: local (App backup on the site), hub (pulled
// copy), offsite (Kopia), sql (SQL Server DAT backup). Each carries a raw
// status + the fields the row/detail needs; tone is derived at render via
// backupTone so there's one colour source of truth.

import { worstTone } from "./backupTone.js";

export function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtRelative(iso, now = Date.now()) {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = now - t;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

const FMT_DATE = new Intl.DateTimeFormat("en-ZA", {
  year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return FMT_DATE.format(d);
}

// SQL health can arrive as an object { status } or be absent.
function sqlStatusOf(site) {
  const h = site.sql_backup?.health;
  if (h?.status) return h.status;
  if (site.sql_backup?.ok === false) return "unavailable";
  return "unavailable";
}

/**
 * Build the per-site view model array from the raw query payloads.
 * @param {{ sites?: object[] }} backupStatus
 * @param {Record<string, object>} hubBackupMap
 * @param {Record<string, object>} kopiaMap
 * @param {boolean} kopiaEnabled
 * @param {boolean} [hubKnown=true]  whether the hub-copy query has resolved.
 *   While it's still loading or has errored, hubBackupMap is empty — a site
 *   missing from it must read as 'unknown', NOT 'never', or every hub layer
 *   scores critical and healthy sites flip to Problems until (or unless) that
 *   query returns.
 */
export function normalizeSites({ backupStatus, hubBackupMap = {}, kopiaMap = {}, kopiaEnabled = false, hubKnown = true }) {
  const sites = backupStatus?.sites || [];
  return sites.map((site) => {
    const id = site.site_id;
    const hub = hubBackupMap[id] || null;
    const kopia = kopiaMap[id] || null;

    // A fresh backup that simply hasn't been integrity-verified yet comes back as
    // the site's 'warn' health with reason 'unverified'. Label it distinctly so
    // it shows "Unverified" rather than "Overdue" (which wrongly implies age).
    const local = {
      status: site.status === "warning" && site.health?.reason === "unverified" ? "unverified" : (site.status || "unknown"),
      lastAt: site.last_backup?.mtime || null,
      size: site.last_backup?.size ?? null,
      count: site.last_backup?.total_backups ?? null,
      dbSize: site.db_size ?? null,
      // When the site last passed an integrity check, so the UI can show
      // whether the 03:30 verify is actually running vs. quietly stopped.
      verifiedAt: site.health?.verify?.at || null,
      verifyStatus: site.health?.verify?.status || null,
    };

    // Hub copy: a copy existing isn't enough — a hub pull that stopped days ago
    // leaves an OLD .db that must NOT read as healthy. Age the status the same
    // way the local layer does (>25h overdue, >48h stale) so a stalled pull
    // surfaces instead of a green dot.
    const hubAgeH = hub?.hub_last_backup ? (Date.now() - new Date(hub.hub_last_backup).getTime()) / 3_600_000 : null;
    const hubStatus =
      !hub ? (hubKnown ? "never" : "unknown")
        : !(hub.hub_backup_count > 0) ? "never"
          : hub.integrity === "corrupt" ? "corrupt"
            : hubAgeH == null ? "unknown"
              : hubAgeH > 48 ? "stale"
                : hubAgeH > 25 ? "warning"
                  : "ok";
    const hubLayer = {
      status: hubStatus,
      lastAt: hub?.hub_last_backup || null,
      size: hub?.hub_last_size ?? null,
      count: hub?.hub_backup_count ?? 0,
      integrity: hub?.integrity || null,
    };

    const sql = {
      status: sqlStatusOf(site),
      lastAt: site.sql_backup?.health?.last_success_at || null,
      databases: site.sql_backup?.databases || [],
      ok: site.sql_backup?.ok !== false,
      message: site.sql_backup?.message || null,
    };

    const offsite = {
      enabled: kopiaEnabled,
      status: !kopiaEnabled ? "off" : kopia ? (kopia.status === "ok" ? "ok" : kopia.reason === "never" ? "never" : "stale") : "unknown",
      reason: kopia?.reason || null,
      lastAt: kopia?.last_snapshot_at || null,
      count: kopia?.count ?? 0,
      bytes: kopia?.total_bytes ?? null,
    };

    // Overall rollup reflects the SITE's own protection: local backup + off-site
    // (when enabled) + a CONFIGURED SQL backup (status !== 'unavailable', so a
    // site with no SQL Server isn't dragged down but a failed/stale one is).
    //
    // The HUB COPY is deliberately EXCLUDED. A stale hub copy means the hub's
    // PULL job is behind — not that the site failed. Rolling it in turned a site
    // with an 11-minute-old local backup into "Problem" purely because the hub
    // hadn't collected it, and reddened the whole fleet during a pull outage.
    // Hub-copy age is still shown on its own layer; a hub-wide pull gap is a
    // hub-level signal, not per-site health.
    const rollup = [local.status];
    if (kopiaEnabled) rollup.push(offsite.status);
    if (sql.status !== "unavailable") rollup.push(sql.status);
    const overallTone = site.error ? "critical" : worstTone(rollup);

    return {
      id,
      name: site.site_name || site.site_id,
      url: site.url || null,
      error: site.error || null,
      overallTone,
      local,
      hub: hubLayer,
      sql,
      offsite,
      raw: site,
    };
  });
}

export function fleetCounts(models) {
  const c = { ok: 0, warn: 0, critical: 0, muted: 0 };
  for (const m of models) c[m.overallTone] = (c[m.overallTone] || 0) + 1;
  return c;
}

// Sort helpers for the fleet table. Default: worst-first so problems float up.
const SORT_RANK = { critical: 0, warn: 1, muted: 2, ok: 3 };
export function sortModels(models, { key = "health", dir = "asc" } = {}) {
  const sorted = [...models].sort((a, b) => {
    let cmp;
    if (key === "name") cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
    else cmp = SORT_RANK[a.overallTone] - SORT_RANK[b.overallTone] || a.name.localeCompare(b.name);
    return cmp;
  });
  return dir === "desc" ? sorted.reverse() : sorted;
}
