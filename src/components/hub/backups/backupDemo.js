// Demo dataset for the Hub Backups page, activated with ?demo=1. Produces the
// SAME payload shapes the three live endpoints return, so it flows through the
// real normalizeSites() — the view can't tell demo data from real data. Lets
// the redesign be reviewed with every state on screen at once (healthy,
// overdue, stale, offline, off-site none/stale, hub-corrupt) without standing
// up live sites or a Kopia repo.
//
// Frontend-only and gated behind an explicit query param — nothing here ships
// into a real hub's data path.

const now = Date.now();
const ago = (h) => new Date(now - h * 3600_000).toISOString();

function sqlDbs(ok) {
  return [
    { name: "CARDOSO_LIVE", isSuccess: ok, backupAt: ago(ok ? 6 : 40), objectStatus: ok ? "Full backup" : "Last full failed" },
    { name: "CARDOSO_ARCHIVE", isSuccess: true, backupAt: ago(6), objectStatus: "Full backup" },
  ];
}

// Each entry defines one site across all four layers.
const SITES = [
  {
    id: "site-ermelo", name: "Ermelo", url: "http://10.20.0.11:3001",
    status: "ok", lastH: 2, size: 4_410_000, count: 14, dbSize: 4_500_000,
    hub: { count: 12, lastH: 2, size: 4_410_000, integrity: "ok" },
    sql: { ok: true, health: "ok", dbs: sqlDbs(true) },
    kopia: { status: "ok", reason: "ok", lastH: 3, count: 9, bytes: 4_300_000 },
  },
  {
    id: "site-jhb", name: "Johannesburg", url: "http://10.20.1.11:3001",
    status: "ok", lastH: 3, size: 5_120_000, count: 21, dbSize: 5_200_000,
    hub: { count: 18, lastH: 3, size: 5_120_000, integrity: "ok" },
    sql: { ok: true, health: "ok", dbs: sqlDbs(true) },
    // Healthy locally + on hub, but nothing ever reached the off-site repo.
    kopia: { status: "critical", reason: "never", lastH: null, count: 0, bytes: null },
  },
  {
    id: "site-pretoria", name: "Pretoria", url: "http://10.20.2.11:3001",
    status: "warning", lastH: 27, size: 3_980_000, count: 9, dbSize: 4_050_000,
    hub: { count: 8, lastH: 27, size: 3_980_000, integrity: "ok" },
    sql: { ok: true, health: "ok", dbs: sqlDbs(true) },
    kopia: { status: "ok", reason: "ok", lastH: 5, count: 7, bytes: 3_900_000 },
  },
  {
    id: "site-klerksdorp", name: "Klerksdorp", url: "http://10.20.3.11:3001",
    status: "stale", lastH: 62, size: 2_100_000, count: 3, dbSize: 4_100_000,
    hub: { count: 5, lastH: 30, size: 2_100_000, integrity: "ok" },
    sql: { ok: false, health: "failed", dbs: sqlDbs(false) },
    kopia: { status: "critical", reason: "stale", lastH: 58, count: 4, bytes: 2_050_000 },
  },
  {
    id: "site-welkom", name: "Welkom", url: "http://10.20.4.11:3001",
    error: "Timeout", status: "unreachable", lastH: null, size: null, count: null, dbSize: null,
    hub: { count: 6, lastH: 20, size: 4_000_000, integrity: "ok" },
    sql: { ok: false, health: "unavailable", dbs: [] },
    kopia: { status: "ok", reason: "ok", lastH: 4, count: 6, bytes: 3_800_000 },
  },
  {
    id: "site-polokwane", name: "Polokwane", url: "http://10.20.5.11:3001",
    status: "ok", lastH: 1, size: 6_030_000, count: 30, dbSize: 6_100_000,
    // Hub has a copy but the latest integrity check flagged it corrupt.
    hub: { count: 22, lastH: 1, size: 6_030_000, integrity: "corrupt" },
    sql: { ok: true, health: "ok", dbs: sqlDbs(true) },
    kopia: { status: "ok", reason: "ok", lastH: 2, count: 11, bytes: 5_900_000 },
  },
  {
    id: "site-nelspruit", name: "Nelspruit", url: "http://10.20.6.11:3001",
    status: "never", lastH: null, size: null, count: 0, dbSize: 4_200_000,
    hub: { count: 0, lastH: null, size: null, integrity: null },
    sql: { ok: false, health: "unavailable", dbs: [] },
    kopia: { status: "critical", reason: "never", lastH: null, count: 0, bytes: null },
  },
];

export function buildDemoData() {
  const backupStatus = {
    sites: SITES.map((s) => ({
      site_id: s.id,
      site_name: s.name,
      url: s.url,
      error: s.error || undefined,
      status: s.status,
      db_size: s.dbSize,
      last_backup: s.lastH != null ? { mtime: ago(s.lastH), size: s.size, total_backups: s.count } : null,
      sql_backup: {
        ok: s.sql.ok,
        databases: s.sql.dbs,
        health: { status: s.sql.health, needs_attention: s.sql.health !== "ok", last_success_at: s.sql.ok ? ago(6) : null },
      },
    })),
  };

  const hubBackupMap = Object.fromEntries(SITES.map((s) => [s.id, {
    site_id: s.id,
    site_name: s.name,
    hub_backup_count: s.hub.count,
    hub_last_backup: s.hub.lastH != null ? ago(s.hub.lastH) : null,
    hub_last_size: s.hub.size,
    integrity: s.hub.integrity || "unchecked",
  }]));

  const kopiaMap = Object.fromEntries(SITES.map((s) => [s.id, {
    site_id: s.id,
    site: s.name.toLowerCase(),
    status: s.kopia.status,
    reason: s.kopia.reason,
    last_snapshot_at: s.kopia.lastH != null ? ago(s.kopia.lastH) : null,
    count: s.kopia.count,
    total_bytes: s.kopia.bytes,
  }]));

  return { backupStatus, hubBackupMap, kopiaMap, kopiaEnabled: true, ui_url: "https://kopia.hub.local:51515" };
}

// Snapshot history for the in-app "View snapshots" viewer (?demo=1). Shaped
// like listHostSnapshots() output so the viewer can't tell demo from real.
export function buildDemoKopiaSnapshots(name = "site") {
  const seed = String(name).length;
  const rows = [{ h: 2, files: 1204 }, { h: 26, files: 1201 }, { h: 50, files: 1198 }, { h: 74, files: 1195 }, { h: 98, files: 1189 }];
  return rows.map((r, i) => ({
    id: `k${(seed * 7 + i).toString(16)}f3a9c2b1e${i}`,
    rootID: `k${(seed + i).toString(16)}rootobj`,
    endTime: ago(r.h),
    startTime: ago(r.h + 0.05),
    totalSize: 4_400_000 - i * 90_000,
    fileCount: r.files,
    dirCount: 42,
    incomplete: false,
  }));
}

// Snapshot list for the restore dialog (both hub-pull and off-site tabs).
export function buildDemoSnapshots(source = "hub") {
  const base = source === "offsite"
    ? [{ h: 2 }, { h: 26 }, { h: 50 }]
    : [{ h: 1 }, { h: 25 }, { h: 49 }, { h: 73 }];
  return base.map((b, i) => ({
    filename: `cardoso-${source}-${new Date(now - b.h * 3600_000).toISOString().slice(0, 10)}-${i}.db`,
    mtime: ago(b.h),
    size_bytes: 4_400_000 - i * 120_000,
    previews_filename: i % 2 === 0 ? `previews-${i}.zip` : null,
    previews_size_bytes: i % 2 === 0 ? 820_000 : null,
    integrity: i === 0 ? "ok" : i === 2 ? "unchecked" : "ok",
    source,
  }));
}
