import db from "../db/index.js";
import {
  CREDIT_LOGIC_SCHEMA_VERSION,
  DEFAULT_CREDIT_LOGIC_CONFIG,
  normaliseCreditLogicConfig,
  validateCreditLogicConfig,
} from "../lib/creditLogic.js";
import { describeFetchError } from "../lib/errorDescribe.js";

// Resolve the hub URL the site uses for syncs.
//
// Order:
//   1. bat_settings.hub_sync_url      (operator-editable in Settings → TLS)
//   2. process.env.HUB_SYNC_URL       (legacy)
//   3. process.env.HUB_REDIRECT_URL   (set by SSO redirect plumbing)
//
// Storing in the DB lets an operator fix port/scheme drift without RDP'ing
// to the box and editing .env. The .env values stay as the seed config the
// installer writes; the DB row is the live override.
function getHubSyncUrlFromDb() {
  try {
    const row = db.prepare(`SELECT value FROM bat_settings WHERE key = 'hub_sync_url'`).get();
    return row?.value || null;
  } catch { return null; }
}

export function setHubSyncUrlInDb(url) {
  const cleaned = String(url || "").trim().replace(/\/$/, "");
  db.prepare(`INSERT INTO bat_settings (key, value, updated_at) VALUES ('hub_sync_url', ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(cleaned);
  return cleaned;
}

function getHubSyncBaseUrl() {
  const dbUrl = getHubSyncUrlFromDb();
  const envUrl = process.env.HUB_SYNC_URL || process.env.HUB_REDIRECT_URL || "";
  return (dbUrl || envUrl).replace(/\/$/, "");
}

// Probe the configured hub URL. Returns { ok, url, status, error } — never
// throws. Used by the boot self-test and the Settings → TLS UI to surface
// connectivity loud rather than silently waiting until the next sync tick.
export async function probeHubUrl() {
  const url = getHubSyncBaseUrl();
  if (!url) return { ok: false, url: null, error: "Hub URL not configured" };
  const probeUrl = `${url}/api/health`;
  try {
    const r = await fetch(probeUrl, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, url, status: r.status, error: `Hub returned ${r.status}` };
    return { ok: true, url, status: r.status };
  } catch (error) {
    return { ok: false, url, error: describeFetchError(error, probeUrl) };
  }
}

// describeFetchError is now in src/lib/errorDescribe.js (imported above).
// Other modules — hubEtl, syncEngine, the hub backup pull route — share
// the helper so the operator sees the same readable shape everywhere.

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getStateRow(scope = "local") {
  return db.prepare(`SELECT * FROM credit_logic_state WHERE scope = ?`).get(scope);
}

function upsertState({
  scope = "local",
  logicVersion,
  payload,
  schemaVersion = CREDIT_LOGIC_SCHEMA_VERSION,
  publishedAt = null,
  lastSyncedAt = null,
  syncStatus = "never_synced",
  lastError = null,
  source = "default",
}) {
  db.prepare(`
    INSERT INTO credit_logic_state (
      scope, logic_version, payload_json, schema_version, published_at,
      last_synced_at, sync_status, last_error, source, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(scope) DO UPDATE SET
      logic_version = excluded.logic_version,
      payload_json = excluded.payload_json,
      schema_version = excluded.schema_version,
      published_at = excluded.published_at,
      last_synced_at = excluded.last_synced_at,
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      source = excluded.source,
      updated_at = datetime('now')
  `).run(scope, logicVersion, JSON.stringify(payload), schemaVersion, publishedAt, lastSyncedAt, syncStatus, lastError, source);
}

function markVersionActive(version) {
  db.prepare(`UPDATE credit_logic_versions SET is_active = CASE WHEN version = ? THEN 1 ELSE 0 END`).run(version);
}

function readActiveCreditLogicVersionRow() {
  return db.prepare(`SELECT * FROM credit_logic_versions WHERE is_active = 1 ORDER BY version DESC LIMIT 1`).get();
}

function buildActiveCreditLogicVersion(row) {
  const config = normaliseCreditLogicConfig(parseJson(row?.config_json, DEFAULT_CREDIT_LOGIC_CONFIG) || DEFAULT_CREDIT_LOGIC_CONFIG);
  return {
    version: row?.version || 1,
    schemaVersion: row?.schema_version || CREDIT_LOGIC_SCHEMA_VERSION,
    config,
    notes: row?.notes || null,
    createdBy: row?.created_by || null,
    publishedAt: row?.published_at || row?.created_at || null,
    createdAt: row?.created_at || null,
  };
}

export function ensureCreditLogicBootstrap() {
  const active = db.prepare(`SELECT version FROM credit_logic_versions WHERE is_active = 1 ORDER BY version DESC LIMIT 1`).get();
  if (!active) {
    db.prepare(`
      INSERT INTO credit_logic_versions (
        version, schema_version, config_json, notes, created_by, is_active, published_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `).run(1, CREDIT_LOGIC_SCHEMA_VERSION, JSON.stringify(DEFAULT_CREDIT_LOGIC_CONFIG), "Initial default credit logic", "system");
  }

  const current = buildActiveCreditLogicVersion(readActiveCreditLogicVersionRow());
  const localState = getStateRow("local");
  if (!localState) {
    upsertState({
      scope: "local",
      logicVersion: current.version,
      payload: current.config,
      schemaVersion: current.schemaVersion,
      publishedAt: current.publishedAt,
      lastSyncedAt: process.env.HUB_MODE === "true" ? new Date().toISOString() : null,
      syncStatus: process.env.HUB_MODE === "true" ? "current" : "never_synced",
      source: process.env.HUB_MODE === "true" ? "hub" : "default",
    });
  }
}

export function getActiveCreditLogicVersion() {
  ensureCreditLogicBootstrap();
  return buildActiveCreditLogicVersion(readActiveCreditLogicVersionRow());
}

export function listCreditLogicVersions(limit = 12) {
  ensureCreditLogicBootstrap();
  return db.prepare(`
    SELECT version, schema_version, notes, created_by, is_active, published_at, created_at
    FROM credit_logic_versions
    ORDER BY version DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    version: row.version,
    schemaVersion: row.schema_version,
    notes: row.notes,
    createdBy: row.created_by,
    isActive: Boolean(row.is_active),
    publishedAt: row.published_at || row.created_at,
    createdAt: row.created_at,
  }));
}

export function getLocalCreditLogicState() {
  ensureCreditLogicBootstrap();
  const row = getStateRow("local");
  const active = getActiveCreditLogicVersion();
  const payload = normaliseCreditLogicConfig(parseJson(row?.payload_json, active.config) || active.config);
  return {
    logicVersion: row?.logic_version ?? active.version,
    schemaVersion: row?.schema_version ?? active.schemaVersion,
    config: payload,
    publishedAt: row?.published_at || active.publishedAt,
    lastSyncedAt: row?.last_synced_at || null,
    syncStatus: row?.sync_status || (process.env.HUB_MODE === "true" ? "current" : "never_synced"),
    lastError: row?.last_error || null,
    source: row?.source || (process.env.HUB_MODE === "true" ? "hub" : "default"),
  };
}

export function getCreditLogicForAnalysis() {
  const local = getLocalCreditLogicState();
  return { version: local.logicVersion, config: local.config };
}

export function publishCreditLogicVersion({ config, notes = null, createdBy = null }) {
  const validation = validateCreditLogicConfig(config);
  if (!validation.ok) {
    const error = new Error("Invalid credit logic config");
    error.statusCode = 400;
    error.details = validation.errors;
    throw error;
  }

  const latest = db.prepare(`SELECT MAX(version) AS version FROM credit_logic_versions`).get();
  const nextVersion = (latest?.version || 0) + 1;
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO credit_logic_versions (
        version, schema_version, config_json, notes, created_by, is_active, published_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(nextVersion, CREDIT_LOGIC_SCHEMA_VERSION, JSON.stringify(validation.config), notes || null, createdBy || null, now, now);
    markVersionActive(nextVersion);
    upsertState({
      scope: "local",
      logicVersion: nextVersion,
      payload: validation.config,
      schemaVersion: CREDIT_LOGIC_SCHEMA_VERSION,
      publishedAt: now,
      lastSyncedAt: now,
      syncStatus: process.env.HUB_MODE === "true" ? "current" : "updated_local",
      source: process.env.HUB_MODE === "true" ? "hub" : "local",
    });
  });

  run();
  return {
    version: nextVersion,
    schemaVersion: CREDIT_LOGIC_SCHEMA_VERSION,
    config: validation.config,
    publishedAt: now,
    notes: notes || null,
    createdBy: createdBy || null,
  };
}

export function applySyncedCreditLogic({ version, config, publishedAt = null, syncStatus = "current", source = "hub", lastError = null }) {
  const validation = validateCreditLogicConfig(config);
  if (!validation.ok) {
    const error = new Error("Invalid credit logic config");
    error.statusCode = 400;
    error.details = validation.errors;
    throw error;
  }

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO credit_logic_versions (
        version, schema_version, config_json, notes, created_by, is_active, published_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(version) DO UPDATE SET
        schema_version = excluded.schema_version,
        config_json = excluded.config_json,
        published_at = excluded.published_at,
        is_active = 1
    `).run(version, CREDIT_LOGIC_SCHEMA_VERSION, JSON.stringify(validation.config), source === "hub" ? "Synced from hub" : "Applied locally", source, publishedAt || now, now);
    markVersionActive(version);
    upsertState({
      scope: "local",
      logicVersion: version,
      payload: validation.config,
      schemaVersion: CREDIT_LOGIC_SCHEMA_VERSION,
      publishedAt: publishedAt || now,
      lastSyncedAt: now,
      syncStatus,
      lastError,
      source,
    });
  });

  run();
  return getLocalCreditLogicState();
}

export function setLocalCreditLogicSyncError(message, status = "error") {
  const local = getLocalCreditLogicState();
  upsertState({
    scope: "local",
    logicVersion: local.logicVersion,
    payload: local.config,
    schemaVersion: local.schemaVersion,
    publishedAt: local.publishedAt,
    lastSyncedAt: local.lastSyncedAt,
    syncStatus: status,
    lastError: message || null,
    source: local.source,
  });
}

function getHubSiteToken(siteId) {
  const row = db.prepare(`SELECT token FROM hub_sites WHERE id = ?`).get(siteId);
  return row?.token || null;
}

export function authenticateSiteAgainstHub(req) {
  const siteId = req.headers["x-site-id"] || req.headers["x-cardoso-site-id"];
  const siteToken = req.headers["x-site-token"] || req.headers["x-cardoso-site-token"];
  if (!siteId || !siteToken) return null;
  const expected = getHubSiteToken(siteId);
  if (!expected || expected !== siteToken) return null;
  return String(siteId);
}

export function updateHubSiteCreditLogicStatus({ siteId, logicVersion = null, syncStatus = "never_synced", lastError = null, lastSyncedAt = null }) {
  db.prepare(`
    UPDATE hub_sites
    SET logic_version = ?,
        logic_sync_status = ?,
        logic_last_error = ?,
        logic_last_synced_at = ?,
        logic_status_updated_at = datetime('now')
    WHERE id = ?
  `).run(logicVersion, syncStatus, lastError || null, lastSyncedAt || null, siteId);
}

export function getHubCreditLogicSiteStatuses() {
  const latest = getActiveCreditLogicVersion();
  return db.prepare(`
    SELECT id, slug, name, url, status, logic_version, logic_sync_status, logic_last_error, logic_last_synced_at, logic_status_updated_at
    FROM hub_sites
    ORDER BY name ASC, slug ASC, id ASC
  `).all().map((row) => {
    let driftStatus = "never_synced";
    if (row.logic_sync_status === "error" || row.logic_sync_status === "unreachable") driftStatus = row.logic_sync_status;
    else if (!row.logic_last_synced_at || row.logic_version == null) driftStatus = "never_synced";
    else if (Number(row.logic_version) < Number(latest.version)) driftStatus = "outdated";
    else driftStatus = "current";

    return {
      siteId: row.id,
      siteSlug: row.slug,
      siteName: row.name,
      url: row.url,
      siteStatus: row.status,
      logicVersion: row.logic_version,
      latestVersion: latest.version,
      syncStatus: row.logic_sync_status || "never_synced",
      driftStatus,
      lastError: row.logic_last_error || null,
      lastSyncedAt: row.logic_last_synced_at || null,
      reportedAt: row.logic_status_updated_at || null,
    };
  });
}

export function getHubCreditLogicPayloadForSite(siteId) {
  const site = db.prepare(`SELECT id, slug, name FROM hub_sites WHERE id = ?`).get(siteId);
  if (!site) {
    const error = new Error("Unknown site");
    error.statusCode = 404;
    throw error;
  }
  const latest = getActiveCreditLogicVersion();
  return {
    siteId: site.id,
    siteSlug: site.slug,
    siteName: site.name,
    version: latest.version,
    schemaVersion: latest.schemaVersion,
    publishedAt: latest.publishedAt,
    config: latest.config,
  };
}

async function notifyHubOfLocalStatus(localState, statusOverride = null) {
  if (process.env.HUB_MODE === "true") return { ok: true, skipped: true };
  const hubSyncBaseUrl = getHubSyncBaseUrl();
  if (!hubSyncBaseUrl || !process.env.SITE_ID || !process.env.REPORTING_TOKEN) {
    return { ok: false, skipped: true, error: "Hub sync URL or site identity is not configured" };
  }

  const response = await fetch(`${hubSyncBaseUrl}/api/hub/credit-logic/site-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-site-id": process.env.SITE_ID,
      "x-site-token": process.env.REPORTING_TOKEN,
    },
    body: JSON.stringify({
      logic_version: localState.logicVersion,
      sync_status: statusOverride || localState.syncStatus,
      last_error: localState.lastError,
      last_synced_at: localState.lastSyncedAt,
      source: localState.source,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Hub status update failed (${response.status})`);
  }

  return response.json().catch(() => ({ ok: true }));
}

export async function syncCreditLogicFromHub({ triggeredBy = "scheduler" } = {}) {
  ensureCreditLogicBootstrap();
  const hubSyncBaseUrl = getHubSyncBaseUrl();
  if (process.env.HUB_MODE === "true") return { skipped: true, reason: "hub_mode" };
  if (!hubSyncBaseUrl || !process.env.SITE_ID || !process.env.REPORTING_TOKEN) return { skipped: true, reason: "not_configured" };

  const url = `${hubSyncBaseUrl}/api/hub/credit-logic/published`;
  try {
    const response = await fetch(url, {
      headers: {
        "x-site-id": process.env.SITE_ID,
        "x-site-token": process.env.REPORTING_TOKEN,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) throw new Error(`Hub returned ${response.status}`);

    const payload = await response.json();
    const state = applySyncedCreditLogic({
      version: payload.version,
      config: payload.config,
      publishedAt: payload.publishedAt,
      syncStatus: "current",
      source: "hub",
    });
    await notifyHubOfLocalStatus(state, "current");
    return { ok: true, triggeredBy, logicVersion: state.logicVersion, lastSyncedAt: state.lastSyncedAt };
  } catch (error) {
    const status = error.name === "TimeoutError" || error.name === "AbortError" ? "unreachable" : "error";
    const description = describeFetchError(error, url);
    setLocalCreditLogicSyncError(description, status);
    const fallbackState = getLocalCreditLogicState();
    try {
      await notifyHubOfLocalStatus({ ...fallbackState, lastError: description }, status);
    } catch {
      // non-fatal, last-known-good stays local
    }
    return { ok: false, triggeredBy, logicVersion: fallbackState.logicVersion, lastSyncedAt: fallbackState.lastSyncedAt, error: description, status };
  }
}

export async function pushCreditLogicToSites({ siteIds = null } = {}) {
  ensureCreditLogicBootstrap();
  const latest = getActiveCreditLogicVersion();
  const rows = Array.isArray(siteIds) && siteIds.length > 0
    ? db.prepare(`SELECT id, slug, name, url, token FROM hub_sites WHERE id IN (${siteIds.map(() => "?").join(",")})`).all(...siteIds)
    : db.prepare(`SELECT id, slug, name, url, token FROM hub_sites ORDER BY name ASC, slug ASC`).all();

  const results = await Promise.all(rows.map(async (site) => {
    const url = `${site.url}/api/hub/receive-credit-logic`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-reporting-token": site.token || "",
        },
        body: JSON.stringify({ version: latest.version, schemaVersion: latest.schemaVersion, publishedAt: latest.publishedAt, config: latest.config }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      const body = await response.json().catch(() => ({}));
      updateHubSiteCreditLogicStatus({ siteId: site.id, logicVersion: body.logicVersion ?? latest.version, syncStatus: body.syncStatus || "current", lastSyncedAt: body.lastSyncedAt || new Date().toISOString() });
      return { siteId: site.id, siteSlug: site.slug, siteName: site.name, ok: true, logicVersion: body.logicVersion ?? latest.version, syncStatus: body.syncStatus || "current", driftStatus: "current", lastSyncedAt: body.lastSyncedAt || new Date().toISOString(), error: null };
    } catch (error) {
      const description = describeFetchError(error, url);
      const syncStatus = /timeout|abort/i.test(error.message) ? "unreachable" : "error";
      updateHubSiteCreditLogicStatus({ siteId: site.id, syncStatus, lastError: description, lastSyncedAt: null });
      return { siteId: site.id, siteSlug: site.slug, siteName: site.name, ok: false, logicVersion: null, syncStatus, driftStatus: syncStatus, lastSyncedAt: null, error: description };
    }
  }));

  return { version: latest.version, pushed: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results };
}
