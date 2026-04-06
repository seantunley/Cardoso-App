import express from 'express';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import db from '../db/index.js';
import { buildStatements } from '../db/statements.js';
import { expandDataRecord } from '../helpers.js';

const execFileAsync = promisify(execFile);

const SITE_ID = process.env.SITE_ID || 'local';
const SITE_SLUG = process.env.SITE_SLUG || 'local';
const SITE_NAME = process.env.SITE_NAME || 'Local';
const CUSTOMER_BALANCES_MIN_AMOUNT = 3;

function parseAmount(value) {
  const num = parseFloat(String(value ?? '').replace(/,/g, '').replace(/\s/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function isInvoiceBalanceMatch(record) {
  const balance = parseAmount(record?.outstanding_balance);
  const invoice = parseAmount(record?.last_unpaid_invoice_1_amount);
  return Math.abs(balance - invoice) <= 0.1;
}

function parseBalanceDate(value) {
  if (!value) return null;
  const input = String(value).trim();
  if (!input) return null;

  if (/^\d{8}$/.test(input)) {
    return new Date(`${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}`);
  }

  const dmy = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    return new Date(`${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`);
  }

  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getBalanceAgeDays(record) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const ages = [1, 2, 3, 4, 5]
    .filter((index) => {
      const amt = record?.[`last_unpaid_invoice_${index}_amount`];
      return amt !== undefined && amt !== null && amt !== '' && amt !== '0' && parseAmount(amt) > 0;
    })
    .map((index) => parseBalanceDate(record?.[`last_unpaid_invoice_${index}_date`]))
    .filter(Boolean)
    .map((date) => Math.floor((today - date) / 86400000))
    .filter((days) => Number.isFinite(days) && days >= 0);

  return ages.length > 0 ? Math.max(...ages) : null;
}

function matchesAgeBucket(record, ageBucket) {
  if (!ageBucket || ageBucket === 'all') return true;

  const ageDays = getBalanceAgeDays(record);
  if (ageDays === null) return false;

  if (ageBucket === '7-13') return ageDays > 7 && ageDays < 14;
  if (ageBucket === '14-20') return ageDays >= 14 && ageDays < 21;
  if (ageBucket === '21+') return ageDays >= 21;

  return true;
}

function requireReportingToken(req, res, next) {
  const token = process.env.REPORTING_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Reporting API not configured' });
  }
  if (req.headers['x-reporting-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function createMachineHealthUnavailableResponse(message, extra = {}) {
  return {
    ok: false,
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    site_name: SITE_NAME,
    app_version: APP_VERSION,
    platform: process.platform,
    checked_at: new Date().toISOString(),
    message,
    machine: {
      hostname: os.hostname(),
      os_version: null,
      uptime_seconds: null,
      last_boot_at: null,
      local_ips: [],
    },
    cpu: {
      usage_percent: null,
      sample_seconds: 3,
      sampled: false,
    },
    memory: {
      total_bytes: null,
      used_bytes: null,
      free_bytes: null,
      used_percent: null,
    },
    disks: [],
    cardoso_service: {
      name: 'CardosoCigarettes',
      present: null,
      status: null,
      display_name: null,
      start_type: null,
    },
    ...extra,
  };
}

async function getWindowsMachineHealth() {
  const powerShellScript = String.raw`
$ErrorActionPreference = 'Stop'

$osInfo = Get-CimInstance Win32_OperatingSystem | Select-Object CSName, Caption, Version, LastBootUpTime, TotalVisibleMemorySize, FreePhysicalMemory
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 3" |
  Select-Object DeviceID, VolumeName, Size, FreeSpace
$cpuSamples = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 3).CounterSamples |
  Select-Object -ExpandProperty CookedValue
$cpuAverage = if ($cpuSamples) { [Math]::Round((($cpuSamples | Measure-Object -Average).Average), 1) } else { $null }

$ipRows = @()
if (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) {
  $ipRows = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -and
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress -Unique
}
if (-not $ipRows -or $ipRows.Count -eq 0) {
  $ipRows = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled = True" |
    ForEach-Object { $_.IPAddress } |
    Where-Object {
      $_ -and $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notlike '127.*' -and $_ -notlike '169.254.*'
    } |
    Select-Object -Unique
}

$service = Get-Service -Name 'CardosoCigarettes' -ErrorAction SilentlyContinue
$serviceInfo = $null
if ($service) {
  $serviceCim = Get-CimInstance Win32_Service -Filter "Name='CardosoCigarettes'" -ErrorAction SilentlyContinue
  $serviceInfo = [PSCustomObject]@{
    name = $service.Name
    present = $true
    status = [string]$service.Status
    display_name = $service.DisplayName
    start_type = if ($serviceCim) { [string]$serviceCim.StartMode } else { $null }
  }
} else {
  $serviceInfo = [PSCustomObject]@{
    name = 'CardosoCigarettes'
    present = $false
    status = 'NotInstalled'
    display_name = 'CardosoCigarettes'
    start_type = $null
  }
}

$result = [PSCustomObject]@{
  ok = $true
  site_id = $env:SITE_ID
  site_slug = $env:SITE_SLUG
  site_name = $env:SITE_NAME
  platform = 'win32'
  checked_at = (Get-Date).ToUniversalTime().ToString('o')
  machine = [PSCustomObject]@{
    hostname = $osInfo.CSName
    os_version = ((@($osInfo.Caption, $osInfo.Version) | Where-Object { $_ }) -join ' ')
    uptime_seconds = [int][Math]::Max(0, ((Get-Date) - $osInfo.LastBootUpTime).TotalSeconds)
    last_boot_at = if ($osInfo.LastBootUpTime) { $osInfo.LastBootUpTime.ToUniversalTime().ToString('o') } else { $null }
    local_ips = @($ipRows)
  }
  cpu = [PSCustomObject]@{
    usage_percent = $cpuAverage
    sample_seconds = 3
    sampled = $true
  }
  memory = [PSCustomObject]@{
    total_bytes = if ($osInfo.TotalVisibleMemorySize) { [int64]$osInfo.TotalVisibleMemorySize * 1024 } else { $null }
    free_bytes = if ($osInfo.FreePhysicalMemory) { [int64]$osInfo.FreePhysicalMemory * 1024 } else { $null }
  }
  disks = @($disks | ForEach-Object {
    $size = if ($_.Size -ne $null) { [int64]$_.Size } else { $null }
    $free = if ($_.FreeSpace -ne $null) { [int64]$_.FreeSpace } else { $null }
    [PSCustomObject]@{
      drive = [string]$_.DeviceID
      volume_name = if ($_.VolumeName) { [string]$_.VolumeName } else { $null }
      total_bytes = $size
      free_bytes = $free
    }
  })
  cardoso_service = $serviceInfo
}

if ($result.memory.total_bytes -ne $null -and $result.memory.free_bytes -ne $null) {
  $result.memory | Add-Member -NotePropertyName used_bytes -NotePropertyValue ([int64]($result.memory.total_bytes - $result.memory.free_bytes))
  $result.memory | Add-Member -NotePropertyName used_percent -NotePropertyValue ([Math]::Round((($result.memory.total_bytes - $result.memory.free_bytes) / $result.memory.total_bytes) * 100, 1))
} else {
  $result.memory | Add-Member -NotePropertyName used_bytes -NotePropertyValue $null
  $result.memory | Add-Member -NotePropertyName used_percent -NotePropertyValue $null
}

$result.disks = @($result.disks | ForEach-Object {
  $used = if ($_.total_bytes -ne $null -and $_.free_bytes -ne $null) { [int64]($_.total_bytes - $_.free_bytes) } else { $null }
  $freePct = if ($_.total_bytes -gt 0 -and $_.free_bytes -ne $null) { [Math]::Round(($_.free_bytes / $_.total_bytes) * 100, 1) } else { $null }
  $usedPct = if ($_.total_bytes -gt 0 -and $used -ne $null) { [Math]::Round(($used / $_.total_bytes) * 100, 1) } else { $null }
  [PSCustomObject]@{
    drive = $_.drive
    volume_name = $_.volume_name
    total_bytes = $_.total_bytes
    free_bytes = $_.free_bytes
    used_bytes = $used
    free_percent = $freePct
    used_percent = $usedPct
  }
})

$result | ConvertTo-Json -Depth 6 -Compress
`;

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    powerShellScript,
  ], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

  const parsed = JSON.parse(stdout.trim());
  parsed.site_id ||= SITE_ID;
  parsed.site_slug ||= SITE_SLUG;
  parsed.site_name ||= SITE_NAME;
  parsed.app_version = APP_VERSION;
  parsed.machine ||= {};
  parsed.machine.hostname ||= os.hostname();
  parsed.machine.local_ips = Array.isArray(parsed.machine.local_ips) ? parsed.machine.local_ips : [];
  parsed.disks = Array.isArray(parsed.disks) ? parsed.disks : [];
  return parsed;
}

export function createReportingRouter({ requireAuth }) {
  const stmts = buildStatements(db);
  const router = express.Router();

  // GET /api/kpis
  router.get('/api/kpis', requireAuth, (req, res) => {
    try {
      const total = stmts.kpiTotalRecords.get();
      const byFlag = stmts.kpiFlagCounts.all();
      const lastSync = stmts.kpiLastSync.get();
      const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
      for (const row of byFlag) {
        if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
      }
      res.json({
        total_records: total.count,
        records_by_flag: flagCounts,
        last_sync_at: lastSync?.completed_at || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/top-balances?limit=30
  router.get('/api/top-balances', requireAuth, (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const isHub = process.env.HUB_MODE === 'true';
    const siteFilter = String(req.query.site || 'all').trim();
    const ageBucket = String(req.query.ageBucket || 'all').trim();
    const hideInvoiceMatchesBalance = ['1', 'true', 'yes', 'on'].includes(String(req.query.hideInvoiceMatchesBalance || '').toLowerCase());

    const balanceWhere = `outstanding_balance IS NOT NULL
            AND outstanding_balance != ''
            AND outstanding_balance != '0'
            AND CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) > 0`;

    try {
      let rows;
      if (isHub) {
        const stmt = db.prepare(`
          SELECT
            r.customer_number,
            r.customer_name,
            r.outstanding_balance,
            r.unpaid_invoices,
            r.receipts,
            r.flag_color,
            r.flag_reason,
            r.auto_flagged,
            r.terms,
            COALESCE(s.name, r.site_id) AS site_name
          FROM hub_records r
          LEFT JOIN hub_sites s ON s.id = r.site_id
          WHERE r.${balanceWhere}
          ORDER BY CAST(REPLACE(REPLACE(r.outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
        `);
        rows = stmt.all().map(expandDataRecord);
      } else {
        const stmt = db.prepare(`
          SELECT
            customer_number,
            customer_name,
            outstanding_balance,
            unpaid_invoices,
            receipts,
            flag_color,
            flag_reason,
            auto_flagged,
            terms,
            ? AS site_name
          FROM datarecord
          WHERE ${balanceWhere}
          ORDER BY CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
        `);
        rows = stmt.all(SITE_NAME).map(expandDataRecord);
      }

      const sites = [...new Set(rows.map((row) => row.site_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));

      const filteredRows = rows.filter((row) => {
        const balance = parseAmount(row.outstanding_balance);
        if (balance <= CUSTOMER_BALANCES_MIN_AMOUNT) return false;
        if (siteFilter !== 'all' && row.site_name !== siteFilter) return false;
        if (!matchesAgeBucket(row, ageBucket)) return false;
        if (hideInvoiceMatchesBalance && isInvoiceBalanceMatch(row)) return false;
        return true;
      });

      const total = filteredRows.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(page, totalPages);
      const safeOffset = (safePage - 1) * limit;
      const records = filteredRows.slice(safeOffset, safeOffset + limit);
      const filteredTotalOutstanding = filteredRows.reduce((sum, row) => sum + parseAmount(row.outstanding_balance), 0);
      const pageTotalOutstanding = records.reduce((sum, row) => sum + parseAmount(row.outstanding_balance), 0);

      res.json({
        records,
        total,
        page: safePage,
        totalPages,
        filteredTotalOutstanding,
        pageTotalOutstanding,
        sites,
        ageBucket,
        minBalanceThreshold: CUSTOMER_BALANCES_MIN_AMOUNT,
      });
    } catch (err) {
      console.error('top-balances error', err);
      res.status(500).json({ error: 'Failed to fetch top balances' });
    }
  });

  // GET /api/inventory?search=&commodity=&limit=
  router.get('/api/inventory', requireAuth, (req, res) => {
    const search = (req.query.search || '').trim();
    const commodity = (req.query.commodity || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100000, 100000);
    const isHub = process.env.HUB_MODE === 'true';
    try {
      const conditions = [];
      const params = [];
      if (search) {
        conditions.push('(item_number LIKE ? OR item_description LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      if (commodity) {
        conditions.push('CAST(commodity AS TEXT) = ?');
        params.push(commodity);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      let rows;
      if (isHub) {
        const hubWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        rows = db.prepare(
          `SELECT i.id, i.site_id, COALESCE(s.name, i.site_id) AS site_name,
                  i.item_number, i.item_description, i.qty_on_hand, i.last_cost,
                  i.price_list, i.price, i.stocking_uom, i.commodity, i.inventory_value, i.terms, i.synced_at
           FROM hub_inventory i
           LEFT JOIN hub_sites s ON s.id = i.site_id
           ${hubWhere} ORDER BY i.item_number ASC LIMIT ?`
        ).all(...params);
      } else {
        rows = db.prepare(
          `SELECT * FROM inventoryrecord ${where} ORDER BY item_number ASC LIMIT ?`
        ).all(...params);
      }
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      console.error('inventory error', err);
      res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  });

  // ==================== MULTI-SITE REPORTING API ====================

  // GET /api/reporting/site-info
  router.get('/api/reporting/site-info', requireReportingToken, (req, res) => {
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      site_name: SITE_NAME,
      app_version: APP_VERSION,
      schema_version: 1,
      reporting_at: new Date().toISOString(),
    });
  });

  // GET /api/reporting/kpis
  router.get('/api/reporting/kpis', requireReportingToken, (req, res) => {
    const total = stmts.kpiTotalRecords.get();
    const byFlag = stmts.kpiFlagCounts.all();
    const lastSync = stmts.kpiLastSync.get();
    const activeConns = stmts.kpiActiveConns.get();

    const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
    for (const row of byFlag) {
      if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
    }

    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      total_records: total.count,
      records_by_flag: flagCounts,
      last_sync_at: lastSync?.completed_at || null,
      active_connections: activeConns.count,
      generated_at: new Date().toISOString(),
    });
  });

  // GET /api/reporting/records?since=ISO_DATE&offset=0&limit=1000
  router.get('/api/reporting/records', requireReportingToken, (req, res) => {
    const since = req.query.since;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
    const offset = parseInt(req.query.offset) || 0;
    let rows;
    if (since) {
      rows = db.prepare(
        `SELECT id, customer_number, customer_name, flag_color, flag_reason, flag_created_by,
                outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
                updated_date, synced_at, source_table, source_id
         FROM datarecord WHERE updated_date > ? ORDER BY updated_date ASC LIMIT ? OFFSET ?`
      ).all(since, limit, offset);
    } else {
      rows = db.prepare(
        `SELECT id, customer_number, customer_name, flag_color, flag_reason, flag_created_by,
                outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
                updated_date, synced_at, source_table, source_id
         FROM datarecord ORDER BY updated_date ASC LIMIT ? OFFSET ?`
      ).all(limit, offset);
    }
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      since: since || null,
      offset,
      limit,
      count: rows.length,
      has_more: rows.length === limit,
      records: rows,
    });
  });

  // GET /api/reporting/health
  router.get('/api/reporting/health', requireReportingToken, (req, res) => {
    const total = stmts.kpiTotalRecords.get();
    const lastRun = stmts.kpiLastRun.get();
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      status: 'ok',
      db_record_count: total.count,
      last_sync_status: lastRun?.status || null,
      last_sync_at: lastRun?.completed_at || null,
      uptime_seconds: Math.floor(process.uptime()),
      checked_at: new Date().toISOString(),
    });
  });

  // GET /api/reporting/machine-health
  router.get('/api/reporting/machine-health', requireReportingToken, async (req, res) => {
    if (process.platform !== 'win32') {
      return res.json(createMachineHealthUnavailableResponse(`Machine health extraction is only available on Windows site machines. Current platform: ${process.platform}`));
    }

    try {
      const health = await getWindowsMachineHealth();
      res.json(health);
    } catch (err) {
      console.error('[reporting/machine-health] error:', err.message);
      res.json(createMachineHealthUnavailableResponse(`Unable to collect Windows machine health: ${err.message}`));
    }
  });

  // POST /api/speedtest/run — trigger an on-demand speed test immediately
  router.post('/api/speedtest/run', requireReportingToken, async (req, res) => {
    // Dynamically import and run so we don't block startup
    import('../scheduler.js').then(({ runSpeedTestNow }) => {
      if (typeof runSpeedTestNow !== 'function') {
        return res.status(501).json({ error: 'runSpeedTestNow not exported' });
      }
      runSpeedTestNow()
        .then(() => res.json({ ok: true }))
        .catch(err => res.status(500).json({ error: err.message }));
    }).catch(err => res.status(500).json({ error: err.message }));
  });

  // GET /api/speedtest/results — last 30 speed test results
  router.get('/api/speedtest/results', requireReportingToken, (req, res) => {
    try {
      const results = db.prepare(
        `SELECT id, timestamp, download_mbps, upload_mbps, ping_ms, isp, server_name, server_location, created_at
         FROM site_speedtest ORDER BY timestamp DESC LIMIT 30`
      ).all();
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/reporting/inventory?offset=0&limit=1000
  router.get('/api/reporting/inventory', requireReportingToken, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const rows = db.prepare(
      `SELECT id, source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, terms, updated_date
       FROM inventoryrecord ORDER BY item_number ASC LIMIT ? OFFSET ?`
    ).all(limit, offset);
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      offset,
      limit,
      count: rows.length,
      has_more: rows.length === limit,
      records: rows,
    });
  });

  return router;
}
