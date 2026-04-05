import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import db from '../db/index.js';

const execFileAsync = promisify(execFile);

const SITE_ID = process.env.SITE_ID || 'local';
const SITE_SLUG = process.env.SITE_SLUG || 'local';
const SITE_NAME = process.env.SITE_NAME || 'Local';

const ACTIVE_STATES = new Set(['Reachable', 'Permanent', 'Probe', 'Delay']);
const RECENT_WINDOW_HOURS = 24;
const DEFAULT_SAMPLE_LOOKBACK_HOURS = 48;

function normalizeMac(mac) {
  const cleaned = String(mac || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  return cleaned.length === 12 ? cleaned : null;
}

function formatMac(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  return normalized.match(/.{1,2}/g).join(':');
}

function parseHostname(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  return value.split('.')[0] || value;
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function inferVendorAndCategory({ hostname }) {
  const value = String(hostname || '').toLowerCase();
  if (!value) {
    return {
      vendor: null,
      category: 'unknown',
      label: 'Unknown',
      confidence: 'low',
      rationale: 'No hostname or vendor hint available',
    };
  }

  const rules = [
    { match: /(iphone|ipad|airpods|homepod)/, vendor: 'Apple', category: 'phone', label: 'Apple phone / mobile device', confidence: 'high', rationale: 'Apple hostname pattern' },
    { match: /(macbook|imac|mac mini|macmini|macpro)/, vendor: 'Apple', category: 'machine', label: 'Apple computer', confidence: 'high', rationale: 'Apple computer hostname pattern' },
    { match: /(galaxy|samsung)/, vendor: 'Samsung', category: 'phone', label: 'Android phone', confidence: 'high', rationale: 'Samsung / Galaxy hostname pattern' },
    { match: /(android|pixel|redmi|xiaomi|poco|oppo|realme|vivo|huawei|honor)/, vendor: null, category: 'phone', label: 'Android phone', confidence: 'medium', rationale: 'Android/mobile hostname pattern' },
    { match: /(laserjet|officejet|deskjet|envy-print|pixma|epson|brother|mfc-|hl-|xerox|kyocera|ricoh|printer|print)/, vendor: null, category: 'printer', label: 'Printer', confidence: 'high', rationale: 'Printer hostname pattern' },
    { match: /(thinkpad|ideapad|latitude|optiplex|xps|inspiron|elitebook|probook|notebook|laptop|desktop|workstation|surface|pc-|ws-|nb-)/, vendor: null, category: 'machine', label: 'Machine / PC / laptop', confidence: 'medium', rationale: 'Computer hostname pattern' },
    { match: /(unifi|ubiquiti|mikrotik|tplink|tp-link|cisco|router|switch|gateway|firewall|ap-|accesspoint|forti|fortigate)/, vendor: null, category: 'network', label: 'Network gear', confidence: 'medium', rationale: 'Network device hostname pattern' },
  ];

  for (const rule of rules) {
    if (rule.match.test(value)) {
      return {
        vendor: rule.vendor,
        category: rule.category,
        label: rule.label,
        confidence: rule.confidence,
        rationale: rule.rationale,
      };
    }
  }

  return {
    vendor: null,
    category: 'other',
    label: 'Other / unknown device',
    confidence: 'low',
    rationale: 'Device was discovered on the LAN but no strong fingerprint was available',
  };
}

function choosePreferredDevice(current, candidate) {
  if (!current) return candidate;
  const score = (device) => {
    let total = 0;
    if (ACTIVE_STATES.has(device.neighbor_state)) total += 4;
    if (device.hostname) total += 3;
    if (device.ip_address) total += 2;
    if (device.interface_alias) total += 1;
    return total;
  };
  return score(candidate) >= score(current) ? candidate : current;
}

function estimateBandwidthKbps(totalKbps, state, activeDeviceCount) {
  if (!Number.isFinite(totalKbps) || totalKbps < 0) {
    return { estimated_kbps: null, confidence: 'unavailable' };
  }

  const peers = Math.max(1, activeDeviceCount || 1);
  const weight = ACTIVE_STATES.has(state) ? 1 : state === 'Stale' ? 0.45 : 0.25;
  const weightedTotal = peers > 1 ? (totalKbps * weight) / Math.max(1, peers - 1 + weight) : totalKbps;

  let confidence = 'low';
  if (peers <= 1) confidence = 'medium';
  else if (peers >= 5) confidence = 'very_low';

  return {
    estimated_kbps: Math.round(Math.max(0, weightedTotal) * 10) / 10,
    confidence,
  };
}

function buildWindowsDiscoveryScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'

function Get-HostNameFast($ip) {
  try {
    $entry = [System.Net.Dns]::GetHostEntry($ip)
    if ($entry -and $entry.HostName -and $entry.HostName -ne $ip) {
      return ($entry.HostName -split '\.')[0]
    }
  } catch {}
  return $null
}

$adapters = @()
try {
  $adapters = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' } |
    Select-Object Name, InterfaceDescription, InterfaceIndex
} catch {}

$statsBefore = @{}
foreach ($adapter in $adapters) {
  try {
    $stat = Get-NetAdapterStatistics -Name $adapter.Name -ErrorAction Stop
    $statsBefore[[string]$adapter.InterfaceIndex] = [PSCustomObject]@{
      sent = [double]$stat.SentBytes
      recv = [double]$stat.ReceivedBytes
    }
  } catch {}
}

Start-Sleep -Seconds 2

$statsAfter = @{}
foreach ($adapter in $adapters) {
  try {
    $stat = Get-NetAdapterStatistics -Name $adapter.Name -ErrorAction Stop
    $statsAfter[[string]$adapter.InterfaceIndex] = [PSCustomObject]@{
      sent = [double]$stat.SentBytes
      recv = [double]$stat.ReceivedBytes
    }
  } catch {}
}

$interfaceRates = @()
foreach ($adapter in $adapters) {
  $key = [string]$adapter.InterfaceIndex
  if ($statsBefore.ContainsKey($key) -and $statsAfter.ContainsKey($key)) {
    $delta = (($statsAfter[$key].sent + $statsAfter[$key].recv) - ($statsBefore[$key].sent + $statsBefore[$key].recv))
    $kbps = if ($delta -ge 0) { [Math]::Round(($delta * 8 / 1000) / 2, 1) } else { $null }
  } else {
    $kbps = $null
  }
  $interfaceRates += [PSCustomObject]@{
    interface_index = $adapter.InterfaceIndex
    interface_alias = $adapter.Name
    interface_description = $adapter.InterfaceDescription
    total_kbps = $kbps
  }
}

$neighbors = @()
if (Get-Command Get-NetNeighbor -ErrorAction SilentlyContinue) {
  try {
    $neighbors = Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -match '^\d+\.\d+\.\d+\.\d+$' -and
        $_.LinkLayerAddress -and
        $_.LinkLayerAddress -notmatch '^00-00-00-00-00-00$' -and
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*'
      } |
      Select-Object IPAddress, LinkLayerAddress, State, InterfaceIndex
  } catch {}
}

if (-not $neighbors -or $neighbors.Count -eq 0) {
  try {
    $arpOutput = arp -a
    foreach ($line in $arpOutput) {
      if ($line -match '^\s*(\d+\.\d+\.\d+\.\d+)\s+([a-f0-9\-]{17})\s+(dynamic|static)\s*$') {
        $neighbors += [PSCustomObject]@{
          IPAddress = $matches[1]
          LinkLayerAddress = $matches[2]
          State = 'Unknown'
          InterfaceIndex = $null
        }
      }
    }
  } catch {}
}

$results = @()
foreach ($neighbor in $neighbors) {
  $hostname = Get-HostNameFast $neighbor.IPAddress
  $adapter = $null
  if ($neighbor.InterfaceIndex -ne $null) {
    $adapter = $adapters | Where-Object { $_.InterfaceIndex -eq $neighbor.InterfaceIndex } | Select-Object -First 1
  }
  $rate = $null
  if ($neighbor.InterfaceIndex -ne $null) {
    $rate = $interfaceRates | Where-Object { $_.interface_index -eq $neighbor.InterfaceIndex } | Select-Object -First 1
  }

  $results += [PSCustomObject]@{
    ip_address = $neighbor.IPAddress
    mac_address = $neighbor.LinkLayerAddress
    hostname = $hostname
    neighbor_state = [string]$neighbor.State
    interface_index = $neighbor.InterfaceIndex
    interface_alias = if ($adapter) { $adapter.Name } else { $null }
    interface_description = if ($adapter) { $adapter.InterfaceDescription } else { $null }
    interface_total_kbps = if ($rate) { $rate.total_kbps } else { $null }
  }
}

[PSCustomObject]@{
  ok = $true
  platform = 'win32'
  site_id = $env:SITE_ID
  site_slug = $env:SITE_SLUG
  site_name = $env:SITE_NAME
  scanned_at = (Get-Date).ToUniversalTime().ToString('o')
  machine_hostname = $env:COMPUTERNAME
  devices = @($results)
} | ConvertTo-Json -Depth 6 -Compress
`;
}

function createUnavailableScan(reason) {
  return {
    ok: false,
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    site_name: SITE_NAME,
    scanned_at: new Date().toISOString(),
    reason,
    devices: [],
  };
}

function ensureNetworkDeviceTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT,
      site_slug TEXT,
      site_name TEXT,
      mac_address TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      hostname TEXT,
      vendor TEXT,
      device_category TEXT,
      classification_label TEXT,
      classification_confidence TEXT,
      classification_rationale TEXT,
      discovery_source TEXT,
      interface_alias TEXT,
      interface_description TEXT,
      neighbor_state TEXT,
      first_seen TEXT,
      last_seen TEXT,
      last_scan_at TEXT,
      active INTEGER DEFAULT 0,
      recently_seen INTEGER DEFAULT 0,
      last_bandwidth_estimate_kbps REAL,
      last_bandwidth_confidence TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_network_devices_last_seen ON network_devices(last_seen);
    CREATE INDEX IF NOT EXISTS idx_network_devices_active ON network_devices(active);
    CREATE INDEX IF NOT EXISTS idx_network_devices_category ON network_devices(device_category);

    CREATE TABLE IF NOT EXISTS network_device_bandwidth_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac_address TEXT NOT NULL,
      sampled_at TEXT NOT NULL,
      estimated_kbps REAL,
      confidence TEXT,
      active INTEGER DEFAULT 0,
      interface_total_kbps REAL,
      active_device_count INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(mac_address, sampled_at)
    );
    CREATE INDEX IF NOT EXISTS idx_network_device_bandwidth_samples_mac_time ON network_device_bandwidth_samples(mac_address, sampled_at DESC);

    CREATE TABLE IF NOT EXISTS network_device_scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT,
      trigger_reason TEXT,
      device_count INTEGER DEFAULT 0,
      active_count INTEGER DEFAULT 0,
      message TEXT
    );
  `);
}

function ensureHubNetworkDeviceTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_network_devices (
      site_id TEXT NOT NULL,
      site_slug TEXT,
      site_name TEXT,
      mac_address TEXT NOT NULL,
      ip_address TEXT,
      hostname TEXT,
      vendor TEXT,
      device_category TEXT,
      classification_label TEXT,
      classification_confidence TEXT,
      classification_rationale TEXT,
      interface_alias TEXT,
      interface_description TEXT,
      neighbor_state TEXT,
      first_seen TEXT,
      last_seen TEXT,
      last_scan_at TEXT,
      active INTEGER DEFAULT 0,
      recently_seen INTEGER DEFAULT 0,
      last_bandwidth_estimate_kbps REAL,
      last_bandwidth_confidence TEXT,
      details_json TEXT,
      pulled_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (site_id, mac_address)
    );
    CREATE INDEX IF NOT EXISTS idx_hub_network_devices_site ON hub_network_devices(site_id, active);

    CREATE TABLE IF NOT EXISTS hub_network_device_bandwidth_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      site_slug TEXT,
      mac_address TEXT NOT NULL,
      sampled_at TEXT NOT NULL,
      estimated_kbps REAL,
      confidence TEXT,
      active INTEGER DEFAULT 0,
      interface_total_kbps REAL,
      active_device_count INTEGER,
      pulled_at TEXT DEFAULT (datetime('now')),
      UNIQUE(site_id, mac_address, sampled_at)
    );
    CREATE INDEX IF NOT EXISTS idx_hub_network_device_bandwidth_site_mac_time ON hub_network_device_bandwidth_samples(site_id, mac_address, sampled_at DESC);
  `);
}

export async function scanNetworkDevicesNow({ triggerReason = 'manual' } = {}) {
  ensureNetworkDeviceTables();

  const startedAt = new Date().toISOString();
  const scanRun = db.prepare(`
    INSERT INTO network_device_scan_runs (started_at, status, trigger_reason)
    VALUES (?, 'running', ?)
  `).run(startedAt, triggerReason || 'manual');

  if (process.platform !== 'win32') {
    const unavailable = createUnavailableScan(`Network discovery is only available on Windows site machines. Current platform: ${process.platform}`);
    db.prepare(`
      UPDATE network_device_scan_runs
      SET completed_at = ?, status = 'unavailable', message = ?
      WHERE id = ?
    `).run(new Date().toISOString(), unavailable.reason, scanRun.lastInsertRowid);
    return unavailable;
  }

  try {
    const script = buildWindowsDiscoveryScript();
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
        env: {
          ...process.env,
          SITE_ID,
          SITE_SLUG,
          SITE_NAME,
        },
      }
    );

    const parsed = safeJsonParse(stdout.trim(), null);
    if (!parsed?.ok || !Array.isArray(parsed.devices)) {
      throw new Error('Invalid PowerShell response while scanning the network');
    }

    const scannedAt = parsed.scanned_at || new Date().toISOString();
    const groupedByInterface = new Map();
    const deduped = new Map();

    for (const raw of parsed.devices) {
      const mac = formatMac(raw.mac_address);
      if (!mac) continue;
      const hostname = parseHostname(raw.hostname);
      const baseInference = inferVendorAndCategory({ hostname });
      const device = {
        site_id: SITE_ID,
        site_slug: SITE_SLUG,
        site_name: SITE_NAME,
        mac_address: mac,
        ip_address: raw.ip_address || null,
        hostname,
        vendor: baseInference.vendor,
        device_category: baseInference.category,
        classification_label: baseInference.label,
        classification_confidence: baseInference.confidence,
        classification_rationale: baseInference.rationale,
        discovery_source: 'powershell-neighbor-scan',
        interface_alias: raw.interface_alias || null,
        interface_description: raw.interface_description || null,
        neighbor_state: raw.neighbor_state || 'Unknown',
        scanned_at: scannedAt,
        interface_total_kbps: Number.isFinite(Number(raw.interface_total_kbps)) ? Number(raw.interface_total_kbps) : null,
      };

      const existing = deduped.get(mac);
      deduped.set(mac, choosePreferredDevice(existing, device));
    }

    const finalDevices = Array.from(deduped.values());
    for (const device of finalDevices) {
      const key = device.interface_alias || '__unknown__';
      if (!groupedByInterface.has(key)) groupedByInterface.set(key, []);
      groupedByInterface.get(key).push(device);
    }

    for (const devices of groupedByInterface.values()) {
      const activeDevices = devices.filter((device) => ACTIVE_STATES.has(device.neighbor_state));
      const activeCount = activeDevices.length || devices.length || 1;
      for (const device of devices) {
        const estimate = estimateBandwidthKbps(device.interface_total_kbps, device.neighbor_state, activeCount);
        device.last_bandwidth_estimate_kbps = estimate.estimated_kbps;
        device.last_bandwidth_confidence = estimate.confidence;
        device.active = ACTIVE_STATES.has(device.neighbor_state) ? 1 : 0;
        device.recently_seen = 1;
        device.details_json = JSON.stringify({
          machine_hostname: parsed.machine_hostname || os.hostname(),
          interface_total_kbps: device.interface_total_kbps,
          active_device_count_on_interface: activeCount,
          bandwidth_note: 'Estimated share of observed adapter throughput. Windows site installs do not have gateway-level per-device counters, so this is a best-effort approximation only.',
        });
      }
    }

    const existingRows = db.prepare(`SELECT mac_address, first_seen FROM network_devices`).all();
    const firstSeenByMac = new Map(existingRows.map((row) => [row.mac_address, row.first_seen]));

    const upsertDevice = db.prepare(`
      INSERT INTO network_devices (
        site_id, site_slug, site_name, mac_address, ip_address, hostname, vendor,
        device_category, classification_label, classification_confidence, classification_rationale,
        discovery_source, interface_alias, interface_description, neighbor_state,
        first_seen, last_seen, last_scan_at, active, recently_seen,
        last_bandwidth_estimate_kbps, last_bandwidth_confidence, details_json, updated_at
      ) VALUES (
        @site_id, @site_slug, @site_name, @mac_address, @ip_address, @hostname, @vendor,
        @device_category, @classification_label, @classification_confidence, @classification_rationale,
        @discovery_source, @interface_alias, @interface_description, @neighbor_state,
        @first_seen, @last_seen, @last_scan_at, @active, @recently_seen,
        @last_bandwidth_estimate_kbps, @last_bandwidth_confidence, @details_json, @updated_at
      )
      ON CONFLICT(mac_address) DO UPDATE SET
        site_id = excluded.site_id,
        site_slug = excluded.site_slug,
        site_name = excluded.site_name,
        ip_address = excluded.ip_address,
        hostname = COALESCE(excluded.hostname, network_devices.hostname),
        vendor = COALESCE(excluded.vendor, network_devices.vendor),
        device_category = excluded.device_category,
        classification_label = excluded.classification_label,
        classification_confidence = excluded.classification_confidence,
        classification_rationale = excluded.classification_rationale,
        discovery_source = excluded.discovery_source,
        interface_alias = excluded.interface_alias,
        interface_description = excluded.interface_description,
        neighbor_state = excluded.neighbor_state,
        last_seen = excluded.last_seen,
        last_scan_at = excluded.last_scan_at,
        active = excluded.active,
        recently_seen = excluded.recently_seen,
        last_bandwidth_estimate_kbps = excluded.last_bandwidth_estimate_kbps,
        last_bandwidth_confidence = excluded.last_bandwidth_confidence,
        details_json = excluded.details_json,
        updated_at = excluded.updated_at
    `);

    const insertBandwidthSample = db.prepare(`
      INSERT OR REPLACE INTO network_device_bandwidth_samples (
        mac_address, sampled_at, estimated_kbps, confidence, active, interface_total_kbps, active_device_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const applyScan = db.transaction(() => {
      for (const device of finalDevices) {
        upsertDevice.run({
          ...device,
          first_seen: firstSeenByMac.get(device.mac_address) || scannedAt,
          last_seen: scannedAt,
          last_scan_at: scannedAt,
          updated_at: scannedAt,
        });

        insertBandwidthSample.run(
          device.mac_address,
          scannedAt,
          device.last_bandwidth_estimate_kbps,
          device.last_bandwidth_confidence,
          device.active,
          device.interface_total_kbps,
          safeJsonParse(device.details_json, {}).active_device_count_on_interface || null,
        );
      }

      if (finalDevices.length > 0) {
        const placeholders = finalDevices.map(() => '?').join(',');
        db.prepare(`UPDATE network_devices SET active = 0 WHERE mac_address NOT IN (${placeholders})`).run(...finalDevices.map((device) => device.mac_address));
      } else {
        db.prepare(`UPDATE network_devices SET active = 0`).run();
      }

      db.prepare(`
        UPDATE network_devices
        SET recently_seen = CASE
          WHEN last_seen IS NOT NULL AND datetime(last_seen) >= datetime('now', '-${RECENT_WINDOW_HOURS} hours') THEN 1
          ELSE 0
        END
      `).run();

      db.prepare(`
        DELETE FROM network_device_bandwidth_samples
        WHERE sampled_at < datetime('now', '-${DEFAULT_SAMPLE_LOOKBACK_HOURS} hours')
      `).run();
    });

    applyScan();

    db.prepare(`
      UPDATE network_device_scan_runs
      SET completed_at = ?, status = 'ok', device_count = ?, active_count = ?, message = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      finalDevices.length,
      finalDevices.filter((device) => device.active).length,
      `Scanned ${finalDevices.length} device(s)`,
      scanRun.lastInsertRowid,
    );

    return {
      ok: true,
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      site_name: SITE_NAME,
      scanned_at: scannedAt,
      devices: finalDevices,
      note: 'Bandwidth is an estimated per-device share of observed Windows adapter throughput. Without gateway or firewall telemetry, it is indicative only.',
    };
  } catch (error) {
    db.prepare(`
      UPDATE network_device_scan_runs
      SET completed_at = ?, status = 'error', message = ?
      WHERE id = ?
    `).run(new Date().toISOString(), error.message, scanRun.lastInsertRowid);
    throw error;
  }
}

export function getNetworkDevicesSnapshot({ sampleHours = DEFAULT_SAMPLE_LOOKBACK_HOURS } = {}) {
  ensureNetworkDeviceTables();

  const devices = db.prepare(`
    SELECT *
    FROM network_devices
    ORDER BY active DESC, recently_seen DESC, datetime(last_seen) DESC, hostname ASC, mac_address ASC
  `).all().map((row) => ({
    ...row,
    active: !!row.active,
    recently_seen: !!row.recently_seen,
    details: safeJsonParse(row.details_json, {}),
  }));

  const samples = db.prepare(`
    SELECT mac_address, sampled_at, estimated_kbps, confidence, active, interface_total_kbps, active_device_count
    FROM network_device_bandwidth_samples
    WHERE sampled_at >= datetime('now', ?)
    ORDER BY sampled_at ASC, mac_address ASC
  `).all(`-${Math.max(1, Number(sampleHours) || DEFAULT_SAMPLE_LOOKBACK_HOURS)} hours`).map((row) => ({
    ...row,
    active: !!row.active,
  }));

  const latestScan = db.prepare(`
    SELECT started_at, completed_at, status, trigger_reason, device_count, active_count, message
    FROM network_device_scan_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() || null;

  return {
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    site_name: SITE_NAME,
    generated_at: new Date().toISOString(),
    latest_scan: latestScan,
    bandwidth_note: 'Best-effort estimate only. Windows site installs can observe local adapter throughput, but not authoritative per-device usage without gateway visibility.',
    devices,
    samples,
  };
}

export async function syncHubNetworkDevicesForSite(site) {
  if (!site?.url) {
    return { site_id: site?.id || null, ok: false, error: 'No site URL configured' };
  }

  ensureNetworkDeviceTables();

  const response = await fetch(`${site.url}/api/reporting/network-devices`, {
    headers: { 'x-reporting-token': site.token || '' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const samples = Array.isArray(payload.samples) ? payload.samples : [];

  ensureHubNetworkDeviceTables();

  const upsertHubDevice = db.prepare(`
    INSERT INTO hub_network_devices (
      site_id, site_slug, site_name, mac_address, ip_address, hostname, vendor,
      device_category, classification_label, classification_confidence, classification_rationale,
      interface_alias, interface_description, neighbor_state, first_seen, last_seen, last_scan_at,
      active, recently_seen, last_bandwidth_estimate_kbps, last_bandwidth_confidence, details_json, pulled_at
    ) VALUES (
      @site_id, @site_slug, @site_name, @mac_address, @ip_address, @hostname, @vendor,
      @device_category, @classification_label, @classification_confidence, @classification_rationale,
      @interface_alias, @interface_description, @neighbor_state, @first_seen, @last_seen, @last_scan_at,
      @active, @recently_seen, @last_bandwidth_estimate_kbps, @last_bandwidth_confidence, @details_json, @pulled_at
    )
    ON CONFLICT(site_id, mac_address) DO UPDATE SET
      site_slug = excluded.site_slug,
      site_name = excluded.site_name,
      ip_address = excluded.ip_address,
      hostname = excluded.hostname,
      vendor = excluded.vendor,
      device_category = excluded.device_category,
      classification_label = excluded.classification_label,
      classification_confidence = excluded.classification_confidence,
      classification_rationale = excluded.classification_rationale,
      interface_alias = excluded.interface_alias,
      interface_description = excluded.interface_description,
      neighbor_state = excluded.neighbor_state,
      first_seen = excluded.first_seen,
      last_seen = excluded.last_seen,
      last_scan_at = excluded.last_scan_at,
      active = excluded.active,
      recently_seen = excluded.recently_seen,
      last_bandwidth_estimate_kbps = excluded.last_bandwidth_estimate_kbps,
      last_bandwidth_confidence = excluded.last_bandwidth_confidence,
      details_json = excluded.details_json,
      pulled_at = excluded.pulled_at
  `);

  const insertSample = db.prepare(`
    INSERT OR REPLACE INTO hub_network_device_bandwidth_samples (
      site_id, site_slug, mac_address, sampled_at, estimated_kbps, confidence, active, interface_total_kbps, active_device_count, pulled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    for (const device of devices) {
      upsertHubDevice.run({
        site_id: site.id,
        site_slug: payload.site_slug || site.slug || site.id,
        site_name: payload.site_name || site.name || site.slug || site.id,
        mac_address: device.mac_address,
        ip_address: device.ip_address || null,
        hostname: device.hostname || null,
        vendor: device.vendor || null,
        device_category: device.device_category || null,
        classification_label: device.classification_label || null,
        classification_confidence: device.classification_confidence || null,
        classification_rationale: device.classification_rationale || null,
        interface_alias: device.interface_alias || null,
        interface_description: device.interface_description || null,
        neighbor_state: device.neighbor_state || null,
        first_seen: device.first_seen || null,
        last_seen: device.last_seen || null,
        last_scan_at: device.last_scan_at || payload.latest_scan?.completed_at || payload.generated_at || now,
        active: device.active ? 1 : 0,
        recently_seen: device.recently_seen ? 1 : 0,
        last_bandwidth_estimate_kbps: device.last_bandwidth_estimate_kbps ?? null,
        last_bandwidth_confidence: device.last_bandwidth_confidence || null,
        details_json: JSON.stringify(device.details || {}),
        pulled_at: now,
      });
    }

    for (const sample of samples) {
      insertSample.run(
        site.id,
        payload.site_slug || site.slug || site.id,
        sample.mac_address,
        sample.sampled_at,
        sample.estimated_kbps ?? null,
        sample.confidence || null,
        sample.active ? 1 : 0,
        sample.interface_total_kbps ?? null,
        sample.active_device_count ?? null,
        now,
      );
    }

    db.prepare(`DELETE FROM hub_network_devices WHERE site_id = ? AND mac_address NOT IN (${devices.map(() => '?').join(',') || "''"})`).run(site.id, ...devices.map((device) => device.mac_address));
    db.prepare(`DELETE FROM hub_network_device_bandwidth_samples WHERE pulled_at < datetime('now', '-${DEFAULT_SAMPLE_LOOKBACK_HOURS} hours')`).run();
  });

  apply();

  return {
    site_id: site.id,
    site_slug: payload.site_slug || site.slug || site.id,
    ok: true,
    device_count: devices.length,
    sample_count: samples.length,
  };
}

export async function syncHubNetworkDevicesForAllSites(sites = []) {
  const results = await Promise.allSettled((sites || []).map((site) => syncHubNetworkDevicesForSite(site)));
  return results.map((result, index) => ({
    site_id: sites[index]?.id || null,
    site_slug: sites[index]?.slug || null,
    ok: result.status === 'fulfilled',
    ...(result.status === 'fulfilled' ? result.value : { error: result.reason?.message || 'Unknown error' }),
  }));
}

export function getHubNetworkDevicesSnapshot({ siteId = null, sampleHours = DEFAULT_SAMPLE_LOOKBACK_HOURS } = {}) {
  ensureHubNetworkDeviceTables();
  const filters = [];
  const params = [];
  if (siteId) {
    filters.push('site_id = ?');
    params.push(siteId);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const devices = db.prepare(`
    SELECT *
    FROM hub_network_devices
    ${where}
    ORDER BY active DESC, recently_seen DESC, datetime(last_seen) DESC, site_name ASC, hostname ASC, mac_address ASC
  `).all(...params).map((row) => ({
    ...row,
    active: !!row.active,
    recently_seen: !!row.recently_seen,
    details: safeJsonParse(row.details_json, {}),
  }));

  const samples = db.prepare(`
    SELECT site_id, site_slug, mac_address, sampled_at, estimated_kbps, confidence, active, interface_total_kbps, active_device_count
    FROM hub_network_device_bandwidth_samples
    WHERE sampled_at >= datetime('now', ?)
      ${siteId ? 'AND site_id = ?' : ''}
    ORDER BY sampled_at ASC, site_id ASC, mac_address ASC
  `).all(`-${Math.max(1, Number(sampleHours) || DEFAULT_SAMPLE_LOOKBACK_HOURS)} hours`, ...(siteId ? [siteId] : [])).map((row) => ({
    ...row,
    active: !!row.active,
  }));

  const latestScan = db.prepare(`
    SELECT MAX(last_scan_at) AS completed_at, COUNT(*) AS device_count, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_count
    FROM hub_network_devices
    ${where}
  `).get(...params);

  return {
    generated_at: new Date().toISOString(),
    bandwidth_note: 'Best-effort estimate only. Hub values are pulled from site-side Windows scans and reflect estimated adapter-share usage, not authoritative gateway telemetry.',
    latest_scan: latestScan?.completed_at ? latestScan : null,
    devices,
    samples,
  };
}
