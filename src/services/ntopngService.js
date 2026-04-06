/**
 * ntopngService.js
 *
 * Wraps the ntopng REST API (v2/v3 endpoints, community edition compatible).
 * ntopng must be running on the Hub machine. nProbe instances on sites export
 * NetFlow/IPFIX to ntopng, which aggregates all flows centrally.
 *
 * Authentication: HTTP Basic (user/password) or cookie-based.
 * We use Basic auth with every request to keep it stateless.
 */

import db from '../db/index.js';

const DEFAULT_NTOPNG_URL = 'http://localhost:3000';
const DEFAULT_NTOPNG_USER = 'admin';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Read ntopng connection settings from hub_settings table */
function getNtopngConfig() {
  try {
    const rows = db.prepare(
      `SELECT key, value FROM hub_settings WHERE key IN ('ntopng_url','ntopng_user','ntopng_password')`
    ).all();
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      url: (cfg.ntopng_url || DEFAULT_NTOPNG_URL).replace(/\/$/, ''),
      user: cfg.ntopng_user || DEFAULT_NTOPNG_USER,
      password: cfg.ntopng_password || '',
    };
  } catch {
    return { url: DEFAULT_NTOPNG_URL, user: DEFAULT_NTOPNG_USER, password: '' };
  }
}

/** Build Authorization header for Basic auth */
function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

/** Low-level fetch wrapper with timeout and Basic auth */
async function ntopngFetch(path, config) {
  const { url, user, password } = config;
  const fullUrl = `${url}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(fullUrl, {
      headers: {
        Authorization: basicAuth(user, password),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ntopng HTTP ${res.status} on ${path}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test ntopng connectivity. Returns { ok, version, message }.
 */
export async function testNtopngConnection() {
  const config = getNtopngConfig();
  if (!config.password) {
    return { ok: false, message: 'ntopng password not configured' };
  }
  try {
    const data = await ntopngFetch('/lua/rest/v2/get/ntopng/info.lua', config);
    return {
      ok: true,
      version: data?.rsp?.version || data?.version || 'unknown',
      message: 'Connected',
    };
  } catch (err) {
    return { ok: false, message: err.message || 'Connection failed' };
  }
}

/**
 * List all interfaces known to ntopng.
 * Returns array of { id, name, type, family, ... }
 */
export async function getInterfaces() {
  const config = getNtopngConfig();
  const data = await ntopngFetch('/lua/rest/v2/get/ntopng/interfaces.lua', config);
  const rsp = data?.rsp;
  if (!Array.isArray(rsp)) return [];
  return rsp.map((iface) => ({
    id: iface.ifid ?? iface.id,
    name: iface.name || iface.ifname || `Interface ${iface.ifid}`,
    type: iface.type || 'unknown',
    family: iface.family || 'unknown',
    speed: iface.speed || null,
  }));
}

/**
 * Get all active hosts on a given interface.
 * ifid: ntopng interface ID (numeric).
 * Returns array of host objects.
 */
export async function getHosts(ifid) {
  const config = getNtopngConfig();
  const data = await ntopngFetch(
    `/lua/rest/v2/get/host/active.lua?ifid=${encodeURIComponent(ifid)}`,
    config
  );
  const rsp = data?.rsp;
  if (!Array.isArray(rsp)) return [];
  return rsp.map((h) => ({
    ip: h.ip || h['ip.name'] || h.key || null,
    mac: h.mac || h['mac_address'] || null,
    name: h.name || h['hostname'] || h['dns.name'] || null,
    bytes_sent: h.bytes_sent ?? h['bytes.sent'] ?? 0,
    bytes_rcvd: h.bytes_rcvd ?? h['bytes.rcvd'] ?? 0,
    first_seen: h.first_seen ?? null,
    last_seen: h.last_seen ?? null,
    vlan: h.vlan_id ?? null,
    os: h.os ?? null,
    country: h.country ?? null,
  }));
}

/**
 * Get top N bandwidth-consuming hosts on a given interface.
 * Returns sorted array (highest bytes_total first).
 */
export async function getTopTalkers(ifid, limit = 10) {
  const hosts = await getHosts(ifid);
  return hosts
    .map((h) => ({ ...h, bytes_total: (h.bytes_sent || 0) + (h.bytes_rcvd || 0) }))
    .sort((a, b) => b.bytes_total - a.bytes_total)
    .slice(0, limit);
}

/**
 * Get per-interface traffic summary (bytes in/out, active flows, hosts).
 * Returns array of { ifid, name, bytes_sent, bytes_rcvd, num_flows, num_hosts }
 */
export async function getInterfaceSummaries() {
  const config = getNtopngConfig();
  try {
    const data = await ntopngFetch('/lua/rest/v2/get/ntopng/interfaces.lua', config);
    const rsp = data?.rsp;
    if (!Array.isArray(rsp)) return [];
    return rsp.map((iface) => ({
      ifid: iface.ifid ?? iface.id,
      name: iface.name || iface.ifname || `Interface ${iface.ifid}`,
      bytes_sent: iface.stats?.bytes?.sent ?? 0,
      bytes_rcvd: iface.stats?.bytes?.rcvd ?? 0,
      num_flows: iface.stats?.num_flows ?? 0,
      num_hosts: iface.stats?.num_hosts ?? 0,
      type: iface.type || 'unknown',
    }));
  } catch {
    return [];
  }
}

/**
 * Map site slugs to ntopng interfaces using the nProbe source name convention.
 * nProbe uses interface naming like "nprobe-<site_slug>" when configured with
 * --interface-name. Falls back to any ZMQ/nProbe interface.
 *
 * Returns Map<siteSlug, { ifid, name }>
 */
export async function mapSitesToInterfaces(sites = []) {
  const interfaces = await getInterfaces();
  const slugMap = new Map();

  for (const site of sites) {
    const slug = site.slug || site.id;
    // Try exact name match (nprobe-<slug>), then partial match
    const exact = interfaces.find(
      (i) => i.name?.toLowerCase() === `nprobe-${slug}`.toLowerCase()
    );
    const partial = interfaces.find(
      (i) => i.name?.toLowerCase().includes(slug.toLowerCase())
    );
    const fallback = interfaces.find(
      (i) => i.type?.toLowerCase().includes('zmq') || i.type?.toLowerCase().includes('nprobe')
    );
    const matched = exact || partial || null;
    slugMap.set(slug, matched || null);
  }

  return slugMap;
}

/**
 * Get a flow summary for a specific nProbe source (site).
 * Tries to find the matching interface and returns summary stats.
 */
export async function getFlowSummary(siteSlug) {
  const interfaces = await getInterfaces();
  const iface = interfaces.find(
    (i) =>
      i.name?.toLowerCase() === `nprobe-${siteSlug}`.toLowerCase() ||
      i.name?.toLowerCase().includes(siteSlug.toLowerCase())
  );

  if (!iface) {
    return { connected: false, ifid: null, name: null };
  }

  const config = getNtopngConfig();
  try {
    const data = await ntopngFetch(
      `/lua/rest/v2/get/interface/data.lua?ifid=${encodeURIComponent(iface.id)}`,
      config
    );
    const rsp = data?.rsp || {};
    return {
      connected: true,
      ifid: iface.id,
      name: iface.name,
      bytes_sent: rsp.stats?.bytes?.sent ?? 0,
      bytes_rcvd: rsp.stats?.bytes?.rcvd ?? 0,
      num_flows: rsp.stats?.num_flows ?? 0,
      num_hosts: rsp.stats?.num_hosts ?? 0,
    };
  } catch {
    return { connected: false, ifid: iface.id, name: iface.name };
  }
}

export { getNtopngConfig };
