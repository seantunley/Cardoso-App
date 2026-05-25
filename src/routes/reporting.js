import express from 'express';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import db from '../db/index.js';
import { reportingRateLimiter } from '../middleware/rateLimit.js';
import { logError } from '../lib/errorLog.js';
import { isoYear, currentIsoWeek, weeksInIsoYear } from '../lib/isoWeek.js';
import { pagination } from '../lib/httpParams.js';
// Shared "last paid week" / "last BAT week" helpers — same source the
// site's own /api/bat/week-status endpoint uses, so the per-site tile
// the hub renders ALWAYS matches what the site shows on its own UI.
// See the helpers' docstrings in src/services/batReconciliation.js for
// the architectural rule (hub mirrors site; never inline a parallel
// SELECT here or the two views can drift again).
import { getLastPaidSageWeek, getLastBatReconciliationWeek } from '../services/batReconciliation.js';
import { buildStatements } from '../db/statements.js';
import { expandDataRecord, getFirstNonEmptyObjectValue, parseJsonSafely, SALES_REP_ALIASES, ACCOUNT_TYPE_ALIASES } from '../helpers.js';

const execFileAsync = promisify(execFile);

const SITE_ID = process.env.SITE_ID || 'local';
const SITE_SLUG = process.env.SITE_SLUG || 'local';
const SITE_NAME = process.env.SITE_NAME || 'Local';
const CUSTOMER_BALANCES_MIN_AMOUNT = 3;

function parseAmount(value) {
  const num = parseFloat(String(value ?? '').replace(/,/g, '').replace(/\s/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function normaliseIsoDate(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (
      dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() + 1 !== m ||
      dt.getUTCDate() !== d
    ) return null;
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getFirstNonEmptyValue(source, aliases) {
  const value = getFirstNonEmptyObjectValue(source, aliases);
  return value === '' ? null : String(value);
}

function hydrateSalesRepAndAccountType(row) {
  if (!row || typeof row !== 'object') return row;

  const hasSalesRep = row.sales_rep !== undefined && row.sales_rep !== null && String(row.sales_rep).trim() !== '';
  const hasAccountType = row.account_type !== undefined && row.account_type !== null && String(row.account_type).trim() !== '';
  if (hasSalesRep && hasAccountType) return row;

  let parsedData = null;
  let parsedLocalFields = null;
  try {
    parsedData = row.data ? JSON.parse(row.data) : null;
  } catch (e) {
    logError('reporting.parseRowData', e, { source_id: row.source_id });
    parsedData = null;
  }
  try {
    parsedLocalFields = row.local_fields ? JSON.parse(row.local_fields) : null;
  } catch (e) {
    logError('reporting.parseLocalFields', e, { source_id: row.source_id });
    parsedLocalFields = null;
  }

  return {
    ...row,
    sales_rep: hasSalesRep
      ? row.sales_rep
      : (
          getFirstNonEmptyValue(parsedData, SALES_REP_ALIASES)
          ?? getFirstNonEmptyValue(parsedLocalFields, SALES_REP_ALIASES)
          ?? row.sales_rep
          ?? null
        ),
    account_type: hasAccountType
      ? row.account_type
      : (
          getFirstNonEmptyValue(parsedData, ACCOUNT_TYPE_ALIASES)
          ?? getFirstNonEmptyValue(parsedLocalFields, ACCOUNT_TYPE_ALIASES)
          ?? row.account_type
          ?? null
        ),
  };
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

function getBalanceInvoiceAges(record) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return [1, 2, 3, 4, 5]
    .filter((index) => {
      const amt = record?.[`last_unpaid_invoice_${index}_amount`];
      return amt !== undefined && amt !== null && amt !== '' && amt !== '0' && parseAmount(amt) > 0;
    })
    .map((index) => parseBalanceDate(record?.[`last_unpaid_invoice_${index}_date`]))
    .filter(Boolean)
    .map((date) => Math.floor((today - date) / 86400000))
    .filter((days) => Number.isFinite(days) && days >= 0);
}

// Returns the OLDEST unpaid invoice age in days. Used by the aged-debtors
// report to bucket customers (each customer falls into one bucket = the bucket
// of their oldest invoice).
function getBalanceAgeDays(record) {
  const ages = getBalanceInvoiceAges(record);
  return ages.length > 0 ? Math.max(...ages) : null;
}

// Customer matches the bucket if ANY of their unpaid invoices falls in this age
// range. A customer with a yesterday invoice AND a 35-day invoice will appear in
// both Current and 14-20 (overlapping is fine — buckets describe the customer's
// active exposure rather than a single classification).
function matchesAgeBucket(record, ageBucket) {
  if (!ageBucket || ageBucket === 'all') return true;
  const ages = getBalanceInvoiceAges(record);
  if (ages.length === 0) return false;
  if (ageBucket === '7-13')  return ages.some((d) => d >  7 && d <  14);
  if (ageBucket === '14-20') return ages.some((d) => d >= 14 && d <  21);
  if (ageBucket === '21+')   return ages.some((d) => d >= 21);
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

  // Memoize prepared statements by SQL text. better-sqlite3 Statement objects
  // are reusable across calls; re-preparing the same string per request is
  // wasted CPU when the SQL is identical.
  const stmtCache = new Map();
  const prep = (sql) => {
    let s = stmtCache.get(sql);
    if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
    return s;
  };

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
      console.error('[reporting] error:', err.message); res.status(500).json({ error: 'Request failed' });
    }
  });

  // GET /api/top-balances?limit=30
  router.get('/api/top-balances', requireAuth, (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const isHub = process.env.HUB_MODE === 'true';
    const siteFilter = String(req.query.site || 'all').trim();
    const ageBucket = String(req.query.ageBucket || 'all').trim();
    const salesRepFilter = String(req.query.salesRep || 'all').trim();
    const hideInvoiceMatchesBalance = ['1', 'true', 'yes', 'on'].includes(String(req.query.hideInvoiceMatchesBalance || '').toLowerCase());

    const balanceAmountGt = CUSTOMER_BALANCES_MIN_AMOUNT;
    const siteWhere = (siteFilter !== 'all' && isHub) ? `AND COALESCE(s.name, r.site_id) = ?` : '';
    // sales_rep can come from JSON blobs (data / local_fields) so we always
    // filter it in JS after hydrateSalesRepAndAccountType has run.
    // Same goes for age bucket / invoice-match (need parsed invoices).
    const needsInMemoryFilter = ageBucket !== 'all' || hideInvoiceMatchesBalance || salesRepFilter !== 'all';

    try {
      let sites = [];
      let total = 0;
      let filteredTotalOutstanding = 0;
      let allRecords = [];

      if (isHub) {
        sites = prep(`
          SELECT DISTINCT COALESCE(s.name, r.site_id) AS site_name
          FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
          WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
            AND r.outstanding_balance != '0'
            AND r.outstanding_balance_num > ?
          ORDER BY site_name`
          ).all(balanceAmountGt)
          .map(r => r.site_name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));

        const fetchSql = needsInMemoryFilter
          ? `SELECT
               r.customer_number, r.customer_name, r.sales_rep, r.account_type,
               r.outstanding_balance, r.unpaid_invoices, r.receipts,
               r.flag_color, r.flag_reason, r.auto_flagged, r.terms,
               COALESCE(s.name, r.site_id) AS site_name
             FROM hub_records r
             LEFT JOIN hub_sites s ON s.id = r.site_id
             WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
               AND r.outstanding_balance != '0'
               AND r.outstanding_balance_num > ?
               ${siteWhere}
             ORDER BY r.outstanding_balance_num DESC`
          : `SELECT
               r.customer_number, r.customer_name, r.sales_rep, r.account_type,
               r.outstanding_balance, r.unpaid_invoices, r.receipts,
               r.flag_color, r.flag_reason, r.auto_flagged, r.terms,
               COALESCE(s.name, r.site_id) AS site_name,
               COUNT(*) OVER() AS _total_count,
               SUM(r.outstanding_balance_num) OVER() AS _total_sum
             FROM hub_records r
             LEFT JOIN hub_sites s ON s.id = r.site_id
             WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
               AND r.outstanding_balance != '0'
               AND r.outstanding_balance_num > ?
               ${siteWhere}
             ORDER BY r.outstanding_balance_num DESC
             LIMIT ? OFFSET ?`;
        const params = siteFilter !== 'all' ? [balanceAmountGt, siteFilter] : [balanceAmountGt];
        if (!needsInMemoryFilter) {
          params.push(limit, (page - 1) * limit);
        }
        const rawRows = prep(fetchSql).all(...params);
        if (!needsInMemoryFilter && rawRows.length > 0) {
          total = rawRows[0]._total_count || 0;
          filteredTotalOutstanding = parseFloat(rawRows[0]._total_sum || 0);
        }
        allRecords = rawRows.map(({ _total_count, _total_sum, ...row }) => expandDataRecord(row));

      } else {
        sites = prep(`
          SELECT DISTINCT ? AS site_name FROM datarecord
          WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
            AND outstanding_balance != '0'
            AND outstanding_balance_num > ?
          ORDER BY site_name`.trim()
        ).all(SITE_NAME, balanceAmountGt).map(r => r.site_name).filter(Boolean);

        const fetchSql = needsInMemoryFilter
          ? `SELECT customer_number, customer_name, sales_rep, account_type,
                    outstanding_balance, unpaid_invoices, receipts,
                    flag_color, flag_reason, auto_flagged, terms,
                    data, local_fields,
                    ? AS site_name
             FROM datarecord
             WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
               AND outstanding_balance != '0'
               AND outstanding_balance_num > ?
             ORDER BY outstanding_balance_num DESC`
          : `SELECT customer_number, customer_name, sales_rep, account_type,
                    outstanding_balance, unpaid_invoices, receipts,
                    flag_color, flag_reason, auto_flagged, terms,
                    data, local_fields,
                    ? AS site_name,
                    COUNT(*) OVER() AS _total_count,
                    SUM(outstanding_balance_num) OVER() AS _total_sum
             FROM datarecord
             WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
               AND outstanding_balance != '0'
               AND outstanding_balance_num > ?
             ORDER BY outstanding_balance_num DESC
             LIMIT ? OFFSET ?`;
        const params = needsInMemoryFilter
          ? [SITE_NAME, balanceAmountGt]
          : [SITE_NAME, balanceAmountGt, limit, (page - 1) * limit];
        const rawRows = prep(fetchSql).all(...params);
        if (!needsInMemoryFilter && rawRows.length > 0) {
          total = rawRows[0]._total_count || 0;
          filteredTotalOutstanding = parseFloat(rawRows[0]._total_sum || 0);
        }
        allRecords = rawRows
          .map(hydrateSalesRepAndAccountType)
          .map(expandDataRecord);
      }

      // ── In-memory pagination path (age bucket / invoice-match / sales rep active) ──
      let recordsForPage;
      let pageTotalOutstanding;
      if (needsInMemoryFilter) {
        const filtered = allRecords.filter((row) => {
          if (!matchesAgeBucket(row, ageBucket)) return false;
          if (hideInvoiceMatchesBalance && isInvoiceBalanceMatch(row)) return false;
          if (salesRepFilter !== 'all' && String(row.sales_rep || '').trim() !== salesRepFilter) return false;
          return true;
        });
        total = filtered.length;
        filteredTotalOutstanding = filtered.reduce((s, row) => s + parseAmount(row.outstanding_balance), 0);
        const start = (page - 1) * limit;
        recordsForPage = filtered.slice(start, start + limit);
        console.log(`[balances-perf] ageBucket=${ageBucket} salesRep=${salesRepFilter} hideMatch=${hideInvoiceMatchesBalance} fetched=${allRecords.length} matched=${filtered.length} pageSize=${recordsForPage.length}`);
      } else {
        recordsForPage = allRecords;
      }
      pageTotalOutstanding = recordsForPage.reduce((s, row) => s + parseAmount(row.outstanding_balance), 0);
      const totalPages = Math.max(1, Math.ceil(total / limit));

      // Build distinct sales-rep list for the filter dropdown. Always derive from
      // the full record set (not the paginated page) so every rep is selectable.
      //
      // When in-memory filters are active we already paid the cost of fetching +
      // hydrating `allRecords` — reuse it. Otherwise, use a lightweight
      // `SELECT DISTINCT sales_rep` against the column. The legacy
      // `SELECT sales_rep, data, local_fields` + per-row hydrate was scanning
      // up to 5000 rows + 5000 JSON.parse calls just to populate a dropdown.
      // A rep whose `sales_rep` column is blank but exists in `data` JSON
      // (legacy-sync edge case) won't appear in the dropdown — that's fine,
      // the row is still visible in the main table; the dropdown's role is to
      // narrow the view, not enumerate every variant.
      let salesReps;
      if (needsInMemoryFilter) {
        salesReps = Array.from(new Set(allRecords.map(r => String(r.sales_rep || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      } else {
        const distinctRows = isHub
          ? prep(
              `SELECT DISTINCT TRIM(r.sales_rep) AS sales_rep FROM hub_records r
               WHERE r.outstanding_balance_num IS NOT NULL AND r.outstanding_balance_num > ?
                 AND r.sales_rep IS NOT NULL AND TRIM(r.sales_rep) != ''`
            ).all(balanceAmountGt)
          : prep(
              `SELECT DISTINCT TRIM(sales_rep) AS sales_rep FROM datarecord
               WHERE outstanding_balance_num IS NOT NULL AND outstanding_balance_num > ?
                 AND sales_rep IS NOT NULL AND TRIM(sales_rep) != ''`
            ).all(balanceAmountGt);
        salesReps = distinctRows.map(r => r.sales_rep).filter(Boolean).sort((a, b) => a.localeCompare(b));
      }

      res.json({
        records: recordsForPage,
        total,
        page,
        totalPages,
        filteredTotalOutstanding,
        pageTotalOutstanding,
        sites,
        salesReps,
        ageBucket,
        salesRep: salesRepFilter,
        minBalanceThreshold: CUSTOMER_BALANCES_MIN_AMOUNT,
      });
    } catch (err) {
      console.error('top-balances error', err);
      res.status(500).json({ error: 'Failed to fetch top balances' });
    }
  });

  // GET /api/reports/aged-debtors — full (unpaginated) aged debtors report
  // with computed aging buckets and summary totals.
  //
  // The bucket calculation only needs `unpaid_invoices`; `receipts` used
  // to be SELECTed-and-piped-through-expandDataRecord on every row of
  // up to 5000 without ever being read. Dropped from the projection.
  // expandDataRecord stays in place — the UI relies on the flat
  // last_unpaid_invoice_N keys it synthesises from the JSON; with
  // `receipts` not selected, the helper's receipts-spread step
  // short-circuits on `undefined` and contributes no work.
  router.get('/api/reports/aged-debtors', requireAuth, (req, res) => {
    const isHub = process.env.HUB_MODE === 'true';
    const minBalance = Math.max(0, parseFloat(req.query.min_balance) || CUSTOMER_BALANCES_MIN_AMOUNT);
    const salesRepFilter = String(req.query.sales_rep || 'all').trim();
    const accountTypeFilter = String(req.query.account_type || 'all').trim();
    const siteFilter = String(req.query.site || 'all').trim();

    try {
      let records;
      let sites = [];
      if (isHub) {
        const dataParams = [minBalance];
        let whereSite = '';
        if (siteFilter !== 'all') { whereSite = 'AND COALESCE(s.name, r.site_id) = ?'; dataParams.push(siteFilter); }
        sites = prep(
          `SELECT DISTINCT COALESCE(s.name, r.site_id) AS site_name
           FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
           WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
             AND r.outstanding_balance != '0'
             AND r.outstanding_balance_num > ?
           ORDER BY site_name`
        ).all(minBalance).map(r => r.site_name).filter(Boolean);
        records = prep(
          `SELECT r.customer_number, r.customer_name, r.sales_rep, r.account_type, r.terms,
                  r.outstanding_balance, r.unpaid_invoices,
                  r.flag_color, r.flag_reason, r.auto_flagged,
                  COALESCE(s.name, r.site_id) AS site_name
           FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
           WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
             AND r.outstanding_balance != '0'
             AND r.outstanding_balance_num > ?
             ${whereSite}
           ORDER BY r.outstanding_balance_num DESC
           LIMIT 5000`
        ).all(...dataParams).map(expandDataRecord);
      } else {
        sites = [SITE_NAME];
        records = prep(
          `SELECT customer_number, customer_name, sales_rep, account_type, terms,
                  outstanding_balance, unpaid_invoices,
                  flag_color, flag_reason, auto_flagged,
                  data, local_fields,
                  ? AS site_name
           FROM datarecord
           WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
             AND outstanding_balance != '0'
             AND outstanding_balance_num > ?
           ORDER BY outstanding_balance_num DESC
           LIMIT 5000`
        ).all(SITE_NAME, minBalance).map(hydrateSalesRepAndAccountType).map(expandDataRecord);
      }
      const truncated = records.length === 5000;

      // Filter by sales rep / account type in JS (these can come from JSON blobs)
      const filtered = records.filter(r => {
        if (salesRepFilter !== 'all' && String(r.sales_rep || '').trim() !== salesRepFilter) return false;
        if (accountTypeFilter !== 'all' && String(r.account_type || '').trim().toUpperCase() !== accountTypeFilter.toUpperCase()) return false;
        return true;
      });

      const bucketKeys = ['current', '7-13', '14-20', '21+', 'unknown'];
      const buckets = Object.fromEntries(bucketKeys.map(k => [k, 0]));
      const bucketCounts = Object.fromEntries(bucketKeys.map(k => [k, 0]));
      let totalOutstanding = 0;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const ageToBucket = (days) => {
        if (days === null || days === undefined) return 'unknown';
        if (days < 7)  return 'current';
        if (days < 14) return '7-13';
        if (days < 21) return '14-20';
        return '21+';
      };

      // Aging by OLDEST unpaid invoice age. The whole customer balance lands
      // in one bucket (the bucket of their oldest dated unpaid invoice). This
      // is the industry-standard aged-debtors convention.
      //
      // The previous implementation tried to split the balance per-invoice
      // (each invoice amount → its own bucket). That was wrong against this
      // data shape because `unpaid_invoices[].amount` is the running customer
      // balance at the time of that invoice, NOT the per-invoice amount.
      // Summing them inflated the bucket totals 3-4x.
      const enriched = filtered.map(r => {
        const balance = parseAmount(r.outstanding_balance);
        totalOutstanding += balance;

        // Find the oldest dated invoice across all unpaid lines.
        let oldestAge = null;
        const invoices = Array.isArray(r.unpaid_invoices)
          ? r.unpaid_invoices
          : (typeof r.unpaid_invoices === 'string' ? parseJsonSafely(r.unpaid_invoices, []) : []);
        for (const inv of invoices) {
          const date = parseBalanceDate(inv?.date);
          if (!date) continue;
          const days = Math.floor((today - date) / 86400000);
          if (!Number.isFinite(days) || days < 0) continue;
          if (oldestAge === null || days > oldestAge) oldestAge = days;
        }
        // Fallback to the flat last_unpaid_invoice_*_date columns if the JSON
        // wasn't expanded (e.g. older code paths feeding the same query).
        if (oldestAge === null) {
          for (let i = 1; i <= 10; i++) {
            const date = parseBalanceDate(r[`last_unpaid_invoice_${i}_date`]);
            if (!date) continue;
            const days = Math.floor((today - date) / 86400000);
            if (!Number.isFinite(days) || days < 0) continue;
            if (oldestAge === null || days > oldestAge) oldestAge = days;
          }
        }

        const bucket = ageToBucket(oldestAge);
        buckets[bucket] += balance;
        bucketCounts[bucket]++;

        return {
          ...r,
          age_days: oldestAge,
          bucket,
          parsed_balance: balance,
          bucket_amounts: { [bucket]: balance },
        };
      });

      // Filter dropdowns built from the unfiltered set so the user can switch back
      const salesReps = Array.from(new Set(records.map(r => String(r.sales_rep || '').trim()).filter(Boolean))).sort();
      const accountTypes = Array.from(new Set(records.map(r => String(r.account_type || '').trim().toUpperCase()).filter(Boolean))).sort();

      res.json({
        records: enriched,
        summary: {
          total_customers: enriched.length,
          total_outstanding: totalOutstanding,
          buckets,
          bucket_counts: bucketCounts,
        },
        filters: { sites, sales_reps: salesReps, account_types: accountTypes },
        truncated,
        truncated_at: truncated ? 5000 : null,
        generated_at: new Date().toISOString(),
        site_name: SITE_NAME,
        hub_mode: isHub,
        min_balance: minBalance,
      });
    } catch (err) {
      console.error('[reporting] aged-debtors error:', err);
      res.status(500).json({ error: 'Failed to fetch aged debtors' });
    }
  });

  // GET /api/reports/rep-exposure — total outstanding & flag mix per sales rep,
  // with the top customers per rep for the printable detail rows.
  //
  // The body only reads: customer_number, customer_name, sales_rep,
  // account_type, outstanding_balance, flag_color. We don't SELECT
  // unpaid_invoices (used to be in the projection but never read), and we
  // skip expandDataRecord entirely — its job is to inflate JSON arrays
  // (unpaid_invoices / receipts) into flat per-index columns, none of
  // which this aggregation cares about. Site mode still pays for
  // hydrateSalesRepAndAccountType because some legacy rows have
  // sales_rep only inside `data`/`local_fields`; that helper early-
  // returns when both columns are populated, so the cost is "free for
  // healthy rows + one JSON.parse pair for the laggards".
  router.get('/api/reports/rep-exposure', requireAuth, (req, res) => {
    const isHub = process.env.HUB_MODE === 'true';
    const minBalance = Math.max(0, parseFloat(req.query.min_balance) || CUSTOMER_BALANCES_MIN_AMOUNT);
    try {
      let records;
      if (isHub) {
        records = prep(
          `SELECT r.customer_number, r.customer_name, r.sales_rep, r.account_type,
                  r.outstanding_balance, r.flag_color,
                  COALESCE(s.name, r.site_id) AS site_name
           FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
           WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
             AND r.outstanding_balance != '0'
             AND r.outstanding_balance_num > ?`
        ).all(minBalance);
      } else {
        records = prep(
          `SELECT customer_number, customer_name, sales_rep, account_type,
                  outstanding_balance, flag_color,
                  data, local_fields,
                  ? AS site_name
           FROM datarecord
           WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
             AND outstanding_balance != '0'
             AND outstanding_balance_num > ?`
        ).all(SITE_NAME, minBalance).map(hydrateSalesRepAndAccountType);
      }
      const repMap = new Map();
      for (const r of records) {
        const rep = String(r.sales_rep || '').trim() || '— Unassigned';
        let bucket = repMap.get(rep);
        if (!bucket) {
          bucket = { sales_rep: rep, customer_count: 0, total_outstanding: 0, flag_counts: { red: 0, orange: 0, green: 0, none: 0 }, top_customers: [] };
          repMap.set(rep, bucket);
        }
        const bal = parseAmount(r.outstanding_balance);
        bucket.customer_count++;
        bucket.total_outstanding += bal;
        const fc = String(r.flag_color || 'none').toLowerCase();
        if (fc in bucket.flag_counts) bucket.flag_counts[fc]++;
        else bucket.flag_counts.none++;
        bucket.top_customers.push({
          customer_number: r.customer_number || '',
          customer_name: r.customer_name || '',
          outstanding_balance: bal,
          flag_color: r.flag_color || 'none',
          account_type: r.account_type || '',
        });
      }
      const reps = Array.from(repMap.values()).map(b => {
        b.top_customers.sort((a, c) => c.outstanding_balance - a.outstanding_balance);
        b.top_customers = b.top_customers.slice(0, 10);
        return b;
      }).sort((a, b) => b.total_outstanding - a.total_outstanding);

      const summary = {
        total_reps: reps.length,
        total_customers: records.length,
        total_outstanding: reps.reduce((s, r) => s + r.total_outstanding, 0),
        total_red: reps.reduce((s, r) => s + r.flag_counts.red, 0),
        total_orange: reps.reduce((s, r) => s + r.flag_counts.orange, 0),
      };

      res.json({ reps, summary, generated_at: new Date().toISOString(), site_name: SITE_NAME, min_balance: minBalance });
    } catch (err) {
      console.error('[reporting] rep-exposure error:', err);
      res.status(500).json({ error: 'Failed to fetch rep exposure' });
    }
  });

  // GET /api/reports/bat-weekly?year=YYYY — per-week BAT vs Sage credit-note
  // totals + variance + extraction stats, suitable for printing as a one-pager.
  router.get('/api/reports/bat-weekly', requireAuth, (req, res) => {
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    try {
      const yearWhere = year ? 'WHERE r.year = ?' : '';
      const params = year ? [year] : [];
      const rows = prep(
        `SELECT r.year, r.week_number,
                r.supplier_total, r.supplier_discount, r.supplier_delivery, r.supplier_pricing,
                COALESCE(c.total, r.sage_total) AS sage_total,
                COALESCE(c.discount, r.sage_discount) AS sage_discount,
                COALESCE(c.delivery, r.sage_delivery) AS sage_delivery,
                COALESCE(c.pricing,  r.sage_pricing)  AS sage_pricing,
                CASE WHEN c.year IS NOT NULL THEN 1 ELSE 0 END AS sage_present,
                ext_stats.pod_count, ext_stats.found_count,
                exc_stats.exc_count, exc_stats.exc_amount,
                r.status
         FROM bat_reconciliations r
         LEFT JOIN bat_sage_week_cache c ON c.year = r.year AND c.week_number = r.week_number
         LEFT JOIN (
           SELECT reconciliation_id, COUNT(*) AS pod_count,
                  SUM(CASE WHEN extraction_status = 'found' THEN 1 ELSE 0 END) AS found_count
           FROM bat_invoice_extractions GROUP BY reconciliation_id
         ) ext_stats ON ext_stats.reconciliation_id = r.id
         LEFT JOIN (
           SELECT reconciliation_id, COUNT(*) AS exc_count,
                  COALESCE(SUM(order_amount), 0) AS exc_amount
           FROM bat_invoice_extractions WHERE is_exception = 1 GROUP BY reconciliation_id
         ) exc_stats ON exc_stats.reconciliation_id = r.id
         ${yearWhere}
         ORDER BY r.year DESC, r.week_number DESC`
      ).all(...params);

      const weeks = rows.map(r => {
        const supplier = r.supplier_total || 0;
        const sage = r.sage_total || 0;
        const variance = supplier - sage;
        const ocrPct = r.pod_count > 0 ? (r.found_count / r.pod_count) * 100 : 0;
        return {
          year: r.year,
          week_number: r.week_number,
          supplier_total: supplier,
          sage_total: sage,
          sage_present: !!r.sage_present,
          variance,
          variance_abs: Math.abs(variance),
          matched: r.sage_present && Math.abs(variance) < 0.01,
          discount_supplier: r.supplier_discount || 0,
          delivery_supplier: r.supplier_delivery || 0,
          pricing_supplier:  r.supplier_pricing  || 0,
          discount_sage:     r.sage_discount || 0,
          delivery_sage:     r.sage_delivery || 0,
          pricing_sage:      r.sage_pricing  || 0,
          pod_count: r.pod_count || 0,
          found_count: r.found_count || 0,
          ocr_pct: ocrPct,
          exc_count: r.exc_count || 0,
          exc_amount: r.exc_amount || 0,
          status: r.status,
        };
      });

      const summary = {
        weeks_count: weeks.length,
        total_supplier: weeks.reduce((s, w) => s + w.supplier_total, 0),
        total_sage:     weeks.reduce((s, w) => s + w.sage_total, 0),
        total_variance: weeks.reduce((s, w) => s + w.variance, 0),
        matched_count:  weeks.filter(w => w.matched).length,
        mismatch_count: weeks.filter(w => w.sage_present && !w.matched).length,
        awaiting_count: weeks.filter(w => !w.sage_present).length,
        total_exceptions:        weeks.reduce((s, w) => s + w.exc_count, 0),
        total_exception_amount:  weeks.reduce((s, w) => s + w.exc_amount, 0),
      };

      const yearsRow = prep('SELECT DISTINCT year FROM bat_reconciliations ORDER BY year DESC').all();
      res.json({ weeks, summary, year, available_years: yearsRow.map(r => r.year), generated_at: new Date().toISOString() });
    } catch (err) {
      console.error('[reporting] bat-weekly error:', err);
      res.status(500).json({ error: 'Failed to fetch BAT weekly report' });
    }
  });

  // GET /api/reports/bat-ytd?year=YYYY — YTD fee-type breakdown comparing
  // BAT's claimed totals to Sage's posted credit-note totals.
  router.get('/api/reports/bat-ytd', requireAuth, (req, res) => {
    // ISO year fallback so a late-Dec call without ?year= matches the
    // ISO year that bat_reconciliations is keyed on.
    const year = req.query.year ? parseInt(req.query.year, 10) : isoYear(new Date());
    try {
      const supplierAgg = prep(
        `SELECT
           COALESCE(SUM(supplier_discount), 0) AS discount,
           COALESCE(SUM(supplier_delivery), 0) AS delivery,
           COALESCE(SUM(supplier_pricing),  0) AS pricing,
           COALESCE(SUM(supplier_total),    0) AS total,
           COUNT(*) AS week_count
         FROM bat_reconciliations WHERE year = ?`
      ).get(year);
      const sageAgg = prep(
        `SELECT
           COALESCE(SUM(discount), 0) AS discount,
           COALESCE(SUM(delivery), 0) AS delivery,
           COALESCE(SUM(pricing),  0) AS pricing,
           COALESCE(SUM(total),    0) AS total
         FROM bat_sage_week_cache WHERE year = ?`
      ).get(year);

      const fees = [
        { fee_type: 'Discount', supplier: supplierAgg.discount, sage: sageAgg.discount },
        { fee_type: 'Delivery', supplier: supplierAgg.delivery, sage: sageAgg.delivery },
        { fee_type: 'Pricing',  supplier: supplierAgg.pricing,  sage: sageAgg.pricing },
      ].map(f => {
        const variance = f.supplier - f.sage;
        const variancePct = f.supplier > 0 ? (variance / f.supplier) * 100 : 0;
        return { ...f, variance, variance_pct: variancePct };
      });

      const yearsRow = prep(`SELECT DISTINCT year FROM bat_reconciliations UNION SELECT DISTINCT year FROM bat_sage_week_cache ORDER BY year DESC`).all();
      res.json({
        year,
        fees,
        summary: {
          total_supplier: supplierAgg.total,
          total_sage: sageAgg.total,
          total_variance: supplierAgg.total - sageAgg.total,
          weeks_uploaded: supplierAgg.week_count,
        },
        available_years: yearsRow.map(r => r.year).filter(Boolean),
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[reporting] bat-ytd error:', err);
      res.status(500).json({ error: 'Failed to fetch BAT YTD report' });
    }
  });

  // GET /api/reports/bat-exceptions?year=YYYY — total exception value, count,
  // breakdown by reason (normalized) and by store.
  router.get('/api/reports/bat-exceptions', requireAuth, (req, res) => {
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    try {
      const yearJoin = year ? 'AND r.year = ?' : '';
      const params = year ? [year] : [];
      const rows = prep(
        `SELECT e.exception_reason, e.store_name, e.order_amount,
                r.year, r.week_number
         FROM bat_invoice_extractions e
         LEFT JOIN bat_reconciliations r ON r.id = e.reconciliation_id
         WHERE e.is_exception = 1 ${yearJoin}`
      ).all(...params);

      const normalize = (s) => {
        const lower = (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!lower) return '';
        const seen = new Set(); const out = [];
        for (const w of lower.split(' ')) { if (!seen.has(w)) { seen.add(w); out.push(w); } }
        return out.join(' ');
      };
      const reasonMap = new Map();
      const storeMap = new Map();
      let totalCount = 0, totalAmount = 0;
      for (const r of rows) {
        const amount = Number(r.order_amount) || 0;
        const rawReason = (r.exception_reason || '').trim() || 'Unspecified';
        const key = normalize(rawReason) || 'unspecified';
        let g = reasonMap.get(key);
        if (!g) { g = { reason: rawReason, count: 0, amount: 0 }; reasonMap.set(key, g); }
        g.count++; g.amount += amount;
        if (rawReason.length < g.reason.length) g.reason = rawReason;

        const store = (r.store_name || '— Unknown').trim();
        let s = storeMap.get(store);
        if (!s) { s = { store_name: store, count: 0, amount: 0 }; storeMap.set(store, s); }
        s.count++; s.amount += amount;

        totalCount++; totalAmount += amount;
      }
      const byReason = Array.from(reasonMap.values()).sort((a, b) => b.amount - a.amount);
      const byStore  = Array.from(storeMap.values()).sort((a, b) => b.amount - a.amount).slice(0, 25);

      const yearsRow = prep(
        `SELECT DISTINCT r.year FROM bat_invoice_extractions e LEFT JOIN bat_reconciliations r ON r.id = e.reconciliation_id WHERE e.is_exception = 1 AND r.year IS NOT NULL ORDER BY r.year DESC`
      ).all();

      res.json({
        year,
        summary: { total_count: totalCount, total_amount: totalAmount, distinct_reasons: byReason.length, distinct_stores: storeMap.size },
        by_reason: byReason,
        by_store: byStore,
        available_years: yearsRow.map(r => r.year).filter(Boolean),
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[reporting] bat-exceptions error:', err);
      res.status(500).json({ error: 'Failed to fetch BAT exceptions report' });
    }
  });

  // GET /api/reports/inventory-value — total value, by-commodity breakdown,
  // top-N items by value, slow-mover alerts.
  router.get('/api/reports/inventory-value', requireAuth, (req, res) => {
    const isHub = process.env.HUB_MODE === 'true';
    const topN = Math.min(Math.max(parseInt(req.query.top, 10) || 25, 5), 200);
    try {
      // Two cheap aggregate queries instead of pulling every SKU into JS:
      //   1. by-commodity rollup (one row per commodity)
      //   2. top-N highest-value items (LIMIT N)
      // The previous implementation loaded every row + ran an O(n log n) JS
      // sort on potentially 10K+ SKUs.
      const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '').replace(/\s/g, '')); return Number.isFinite(n) ? n : 0; };
      const valueExpr = `COALESCE(NULLIF(CAST(REPLACE(REPLACE(COALESCE(inventory_value, ''), ',', ''), ' ', '') AS REAL), 0),
                                  CAST(REPLACE(REPLACE(COALESCE(qty_on_hand, '0'), ',', ''), ' ', '') AS REAL)
                                  * CAST(REPLACE(REPLACE(COALESCE(last_cost, '0'), ',', ''), ' ', '') AS REAL))`;
      const qtyExpr = `CAST(REPLACE(REPLACE(COALESCE(qty_on_hand, '0'), ',', ''), ' ', '') AS REAL)`;
      const commoditySql = isHub
        ? `SELECT
             COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised') AS commodity,
             COUNT(*)         AS item_count,
             SUM(${valueExpr}) AS total_value,
             SUM(${qtyExpr})   AS total_qty
           FROM hub_inventory
           GROUP BY COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised')
           ORDER BY total_value DESC`
        : `SELECT
             COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised') AS commodity,
             COUNT(*)         AS item_count,
             SUM(${valueExpr}) AS total_value,
             SUM(${qtyExpr})   AS total_qty
           FROM inventoryrecord
           GROUP BY COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised')
           ORDER BY total_value DESC`;
      const byCommodity = prep(commoditySql).all().map(r => ({
        commodity: r.commodity,
        item_count: r.item_count,
        total_value: num(r.total_value),
        total_qty: num(r.total_qty),
      }));

      const topItemsSql = isHub
        ? `SELECT i.item_number, i.item_description, i.qty_on_hand, i.last_cost, i.price,
                  COALESCE(NULLIF(TRIM(i.commodity), ''), '— Uncategorised') AS commodity,
                  ${valueExpr.replace(/\binventory_value\b/g, 'i.inventory_value').replace(/\bqty_on_hand\b/g, 'i.qty_on_hand').replace(/\blast_cost\b/g, 'i.last_cost')} AS inventory_value,
                  COALESCE(s.name, i.site_id) AS site_name
           FROM hub_inventory i LEFT JOIN hub_sites s ON s.id = i.site_id
           ORDER BY inventory_value DESC
           LIMIT ?`
        : `SELECT item_number, item_description, qty_on_hand, last_cost, price,
                  COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised') AS commodity,
                  ${valueExpr} AS inventory_value,
                  ? AS site_name
           FROM inventoryrecord
           ORDER BY inventory_value DESC
           LIMIT ?`;
      const topItems = (isHub ? prep(topItemsSql).all(topN) : prep(topItemsSql).all(SITE_NAME, topN)).map(r => ({
        item_number: r.item_number,
        item_description: r.item_description,
        qty_on_hand: num(r.qty_on_hand),
        last_cost: num(r.last_cost),
        price: num(r.price),
        commodity: r.commodity,
        inventory_value: num(r.inventory_value),
        site_name: r.site_name,
      }));

      const totalValue = byCommodity.reduce((s, c) => s + c.total_value, 0);
      const totalItems = byCommodity.reduce((s, c) => s + c.item_count, 0);

      res.json({
        summary: {
          total_items: totalItems,
          total_value: totalValue,
          distinct_commodities: byCommodity.length,
        },
        by_commodity: byCommodity,
        top_items: topItems,
        top_n: topN,
        generated_at: new Date().toISOString(),
        site_name: SITE_NAME,
      });
    } catch (err) {
      console.error('[reporting] inventory-value error:', err);
      res.status(500).json({ error: `Failed to fetch inventory report: ${err.message || 'unknown'}` });
    }
  });

  // GET /api/inventory?search=&commodity=&limit=
  router.get('/api/inventory', requireAuth, (req, res) => {
    const search = (req.query.search || '').trim();
    const commodity = (req.query.commodity || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
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
        rows = prep(
          `SELECT i.id, i.site_id, COALESCE(s.name, i.site_id) AS site_name,
                  i.item_number, i.item_description, i.qty_on_hand, i.last_cost,
                  i.price_list, i.price, i.stocking_uom, i.commodity, i.inventory_value, i.terms, i.synced_at
           FROM hub_inventory i
           LEFT JOIN hub_sites s ON s.id = i.site_id
           ${hubWhere} ORDER BY i.item_number ASC LIMIT ?`
        ).all(...params);
      } else {
        rows = prep(
          `SELECT * FROM inventoryrecord ${where} ORDER BY item_number ASC LIMIT ?`
        ).all(...params);
      }
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      console.error('inventory error', err);
      res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  });

  // Stock receipts (Sage import target) + per-line expiry capture.
  router.get('/api/stock-receipts', requireAuth, (req, res) => {
    const search = String(req.query.search || '').trim();
    const missingOnly = String(req.query.missing_expiry || '').toLowerCase() === 'true';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const params = [];
    const where = [];
    if (search) {
      where.push(`(sr.receipt_number LIKE ? OR srl.item_number LIKE ? OR srl.item_description LIKE ?)`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (missingOnly) where.push(`COALESCE(e.expiry_rows, 0) = 0`);
    params.push(limit);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    try {
      const rows = db.prepare(`
        SELECT
          sr.id AS receipt_id, sr.source_table, sr.receipt_number, sr.receipt_date,
          srl.id AS receipt_line_id, srl.line_no, srl.item_number, srl.item_description, srl.qty_received, srl.batch_or_lot,
          COALESCE(e.expiry_rows, 0) AS expiry_rows
        FROM stock_receipt_line srl
        JOIN stock_receipt sr ON sr.id = srl.receipt_id
        LEFT JOIN (
          SELECT receipt_line_id, COUNT(*) AS expiry_rows
          FROM stock_receipt_line_expiry
          GROUP BY receipt_line_id
        ) e ON e.receipt_line_id = srl.id
        ${whereSql}
        ORDER BY sr.receipt_date DESC, sr.id DESC, srl.line_no ASC, srl.id ASC
        LIMIT ?
      `).all(...params);
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      console.error('[stock-receipts] list failed:', err);
      res.status(500).json({ error: 'Failed to load stock receipts' });
    }
  });

  router.get('/api/stock-receipts/:receiptLineId/expiry', requireAuth, (req, res) => {
    const receiptLineId = parseInt(req.params.receiptLineId, 10);
    if (!Number.isFinite(receiptLineId) || receiptLineId <= 0) return res.status(400).json({ error: 'Invalid receiptLineId' });
    try {
      const line = db.prepare(`
        SELECT srl.*, sr.receipt_number, sr.receipt_date, sr.source_table
        FROM stock_receipt_line srl
        JOIN stock_receipt sr ON sr.id = srl.receipt_id
        WHERE srl.id = ?
      `).get(receiptLineId);
      if (!line) return res.status(404).json({ error: 'Receipt line not found' });
      const expiries = db.prepare(`
        SELECT id, receipt_line_id, expiry_date, qty_at_expiry, entered_by, entry_source, notes, created_date, updated_date
        FROM stock_receipt_line_expiry
        WHERE receipt_line_id = ?
        ORDER BY expiry_date ASC, id ASC
      `).all(receiptLineId);
      res.json({ line, expiries });
    } catch (err) {
      console.error('[stock-receipts] expiry detail failed:', err);
      res.status(500).json({ error: 'Failed to load expiry entries' });
    }
  });

  router.post('/api/stock-receipts/:receiptLineId/expiry', requireAuth, express.json(), (req, res) => {
    const receiptLineId = parseInt(req.params.receiptLineId, 10);
    if (!Number.isFinite(receiptLineId) || receiptLineId <= 0) return res.status(400).json({ error: 'Invalid receiptLineId' });
    const expiryDate = normaliseIsoDate(req.body?.expiry_date);
    const qtyAtExpiry = String(req.body?.qty_at_expiry ?? '').trim();
    const notes = String(req.body?.notes ?? '').trim().slice(0, 1000);
    const enteredBy = String(req.user?.username || req.user?.email || req.user?.id || 'unknown');
    if (!expiryDate) return res.status(400).json({ error: 'expiry_date must be a valid date' });
    try {
      const line = db.prepare(`SELECT id FROM stock_receipt_line WHERE id = ?`).get(receiptLineId);
      if (!line) return res.status(404).json({ error: 'Receipt line not found' });
      const result = db.prepare(`
        INSERT INTO stock_receipt_line_expiry (
          receipt_line_id, expiry_date, qty_at_expiry, entered_by, entry_source, notes, updated_date
        ) VALUES (?, ?, ?, ?, 'manual', ?, CURRENT_TIMESTAMP)
      `).run(receiptLineId, expiryDate, qtyAtExpiry, enteredBy, notes);
      const created = db.prepare(`SELECT * FROM stock_receipt_line_expiry WHERE id = ?`).get(result.lastInsertRowid);
      res.status(201).json({ ok: true, record: created });
    } catch (err) {
      console.error('[stock-receipts] add expiry failed:', err);
      res.status(500).json({ error: 'Failed to add expiry entry' });
    }
  });

  // ==================== MULTI-SITE REPORTING API ====================

  // GET /api/reporting/site-info
  router.get('/api/reporting/site-info', reportingRateLimiter, requireReportingToken, (req, res) => {
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
  router.get('/api/reporting/kpis', reportingRateLimiter, requireReportingToken, (req, res) => {
    const total = stmts.kpiTotalRecords.get();
    const byFlag = stmts.kpiFlagCounts.all();
    const lastSync = stmts.kpiLastSync.get();
    const activeConns = stmts.kpiActiveConns.get();

    const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
    for (const row of byFlag) {
      if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
    }

    // Site→Accpac freshness + status. The hub reads these so it can show
    // "your data is 2 days stale" or "Accpac sync failing: ELOGIN" on the
    // customer-management tile, instead of just the hub→site sync time
    // which can be misleadingly recent. We aggregate across active
    // non-BAT-only connections (BAT-only feeds the BAT module's own
    // pool, not datarecord — including it would muddy the freshness
    // signal that customer data depends on).
    //
    // Aggregation:
    //   - synced_at = MAX(last_sync)        — most recent successful run
    //   - status    = error  if ANY active non-BAT-only conn is 'error'
    //                 ok     if at least one has last_sync != null
    //                 never_synced  otherwise
    //   - error     = the most recent non-null last_error (or syncrun
    //                 message if databaseconnection didn't capture one)
    let accpacSyncedAt = null;
    let accpacStatus = 'never_synced';
    let accpacError = null;
    try {
      const conns = db.prepare(`
        SELECT name, status, last_sync, last_error, updated_date
        FROM databaseconnection
        WHERE status IN ('active', 'error') AND COALESCE(is_bat_only, 0) = 0
      `).all();

      let mostRecentSyncMs = 0;
      let anyError = null;
      let anyOk = false;
      for (const c of conns) {
        if (c.last_sync) {
          anyOk = true;
          const t = Date.parse(c.last_sync);
          if (Number.isFinite(t) && t > mostRecentSyncMs) {
            mostRecentSyncMs = t;
            accpacSyncedAt = c.last_sync;
          }
        }
        if (c.status === 'error') {
          accpacStatus = 'error';
          // Prefer the connection with the freshest updated_date for
          // the error message — that's the most recent failure.
          if (!anyError || (c.updated_date && c.updated_date > anyError._when)) {
            anyError = { msg: c.last_error || 'Unknown error', _when: c.updated_date };
          }
        }
      }
      if (accpacStatus !== 'error' && anyOk) accpacStatus = 'ok';
      if (anyError) accpacError = String(anyError.msg).slice(0, 500);
    } catch (err) {
      // Don't fail the kpis response if the accpac aggregation throws —
      // surface it as an error in the response so the operator sees
      // "something's odd with sync state" without the whole tile failing.
      accpacStatus = 'error';
      accpacError = `Failed to read connection state: ${err.message}`;
    }

    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      total_records: total.count,
      records_by_flag: flagCounts,
      last_sync_at: lastSync?.completed_at || null,
      active_connections: activeConns.count,
      // Site→Accpac freshness — distinct from hub→site (last_sync_at
      // above is the most recent syncrun completion, which conflates
      // both directions historically). Hub UI uses these three:
      site_accpac_last_synced_at: accpacSyncedAt,
      site_accpac_status: accpacStatus,
      site_accpac_error: accpacError,
      generated_at: new Date().toISOString(),
    });
  });

  // GET /api/reporting/records?since=ISO_DATE&offset=0&limit=1000
  router.get('/api/reporting/records', reportingRateLimiter, requireReportingToken, (req, res) => {
    const since = req.query.since;
    const { limit, offset } = pagination(req, { defaultLimit: 1000, maxLimit: 1000 });
    let rows;
    if (since) {
      rows = prep(
        `SELECT id, customer_number, customer_name, flag_color, flag_reason, flag_created_by,
                outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
                updated_date, synced_at, source_table, source_id, sales_rep, account_type, data, local_fields
         FROM datarecord WHERE updated_date > ? ORDER BY updated_date ASC LIMIT ? OFFSET ?`
      ).all(since, limit, offset).map(hydrateSalesRepAndAccountType).map(({ data, ...row }) => row);
    } else {
      rows = prep(
        `SELECT id, customer_number, customer_name, flag_color, flag_reason, flag_created_by,
                outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
                updated_date, synced_at, source_table, source_id, sales_rep, account_type, data, local_fields
         FROM datarecord ORDER BY updated_date ASC LIMIT ? OFFSET ?`
      ).all(limit, offset).map(hydrateSalesRepAndAccountType).map(({ data, ...row }) => row);
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
  router.get('/api/reporting/health', reportingRateLimiter, requireReportingToken, (req, res) => {
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

  // GET /api/reporting/inventory?offset=0&limit=1000
  // GET /api/reporting/bat-summary — single-row YTD BAT reconciliation snapshot,
  // pulled by the hub once a day. Aggregates straight off bat_reconciliations,
  // bat_sage_week_cache and bat_invoice_extractions; no joins to Cardoso/extractions
  // beyond a count of flagged exceptions.
  router.get('/api/reporting/bat-summary', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      // Per-week base rows (year, week) joined with sage cache so totals are always live.
      // Scope totals + per-week lists to the CURRENT ISO YEAR. The hub's
      // per-site card shows year-scoped totals (matching the site's own
      // dashboard which is filtered by year selector). All-time totals
      // would mix 2025 and 2026 once we cross the year boundary, which
      // isn't useful for the operator.
      //
      // ISO year (not calendar year) so weeks straddling Jan 1 are
      // attributed to the right year. Routed through the canonical helper
      // — same algorithm as the previous inline implementation, just
      // sharing the unit-tested code.
      const summary_year = currentIsoWeek().year;

      const rows = prep(
        `SELECT r.year, r.week_number,
                COALESCE(r.supplier_total, 0) AS supplier_total,
                COALESCE(c.total, r.sage_total, 0) AS sage_total,
                CASE WHEN c.year IS NOT NULL THEN 1 ELSE 0 END AS sage_present,
                r.created_at, r.upload_filename
         FROM bat_reconciliations r
         LEFT JOIN bat_sage_week_cache c ON c.year = r.year AND c.week_number = r.week_number
         WHERE r.year = ?`
      ).all(summary_year);

      let weeks_count = rows.length;
      let total_supplier = 0, total_sage = 0;
      let matched_count = 0, mismatch_count = 0, awaiting_count = 0;
      let last_upload_at = null;
      for (const r of rows) {
        total_supplier += r.supplier_total;
        total_sage += r.sage_total;
        const variance = r.supplier_total - r.sage_total;
        if (!r.sage_present) awaiting_count++;
        else if (Math.abs(variance) < 0.01) matched_count++;
        else mismatch_count++;
        if (r.created_at && (!last_upload_at || r.created_at > last_upload_at)) last_upload_at = r.created_at;
      }

      const exc = prep(
        `SELECT COUNT(*) AS c, COALESCE(SUM(order_amount), 0) AS a
         FROM bat_invoice_extractions WHERE is_exception = 1`
      ).get();

      // SHARED helpers — the SAME functions /api/bat/week-status uses on
      // the site's own UI. This is the single source of truth: if the
      // site says "Last paid: W19/2026" on its own page, the hub MUST
      // see the same value here. Inlining a SELECT was the previous
      // pattern and it diverged from the site (W44/2026 on hub, W10/2027
      // on site, both wrong) because the two paths drifted in scoping.
      // Don't reintroduce a local SELECT here; extend the helpers
      // instead.
      const lastPaid = getLastPaidSageWeek();
      const last_paid_week = lastPaid?.week_number ?? null;
      const last_paid_year = lastPaid?.year ?? null;

      // Current-year-scoped lookup — drives last_bat_week / last_bat_year
      // in the response (a year-scoped "Last upload this year: W##/YYYY"
      // label on the tile).
      const lastBat = getLastBatReconciliationWeek();
      const last_bat_week = lastBat?.week_number ?? null;
      const last_bat_year = lastBat?.year ?? null;

      // Missing weeks = number of ISO weeks between the last BAT recon
      // uploaded ANYWHERE (across all years) and the current ISO week.
      // Operator-facing meaning is "how many weeks behind on uploads is
      // this site". Example: if last recon is W13/2026 and we're in
      // W20/2026, that's 7 missing.
      //
      // Uses the allYears variant of the helper because a site whose
      // most recent upload was in a PREVIOUS ISO year would otherwise
      // get null from the current-year-scoped lookup, and the cross-
      // year branch below would never fire. Codex review catch on
      // PR #273.
      //
      // Cross-year case: if the last BAT was in a previous ISO year, sum
      // (weeks remaining in that year) + (full intermediate years) +
      // (weeks elapsed in current year). weeksInIsoYear() handles 52 vs
      // 53 week years correctly.
      //
      // Previous definition was "weeks where Sage has posted credit
      // notes but no matching BAT recon" — that hid sites which were
      // far behind on uploads as long as Sage hadn't started posting
      // credit notes for those weeks yet. The new definition surfaces
      // the upload backlog directly, which is what the operator needs
      // to see at a glance from the hub tile.
      const lastBatAllYears = getLastBatReconciliationWeek({ allYears: true });
      const cur = currentIsoWeek();
      let missing_weeks_count = 0;
      if (lastBatAllYears) {
        if (lastBatAllYears.year === cur.year) {
          missing_weeks_count = Math.max(0, cur.week - lastBatAllYears.week_number);
        } else if (lastBatAllYears.year < cur.year) {
          let gap = weeksInIsoYear(lastBatAllYears.year) - lastBatAllYears.week_number;
          for (let y = lastBatAllYears.year + 1; y < cur.year; y++) {
            gap += weeksInIsoYear(y);
          }
          gap += cur.week;
          missing_weeks_count = gap;
        }
        // lastBatAllYears.year > cur.year shouldn't happen (the helper
        // guards future weeks within the current year) but if it does we
        // leave count at 0 rather than reporting a negative gap.
      }

      // Missing credit notes: every week of summary_year (capped at the
      // last fully-elapsed week, currentWeek - 1, when summary_year is
      // the current year) where Sage hasn't posted credit notes —
      // regardless of whether a BAT spreadsheet has been uploaded for
      // that week. This is the SAME definition the site's own
      // /api/bat/week-status uses for its "Missing Credit Notes" tile,
      // so the per-site hub tile and the site UI are guaranteed to
      // surface the same list. (See feedback_hub_mirrors_site.md.)
      //
      // Previous formulation joined bat_reconciliations LEFT JOIN
      // bat_sage_week_cache, which restricted the list to weeks where
      // BAT was uploaded — hiding gaps in weeks the operator hadn't
      // uploaded yet. That hid the very thing the tile is meant to
      // surface (credit-note gaps).
      let missingCutoffYear;
      if (summary_year < cur.year) {
        missingCutoffYear = weeksInIsoYear(summary_year);
      } else if (summary_year === cur.year) {
        missingCutoffYear = Math.max(0, cur.week - 1);
      } else {
        missingCutoffYear = 0;
      }
      const sageWeeksInYear = new Set(
        prep(`SELECT week_number FROM bat_sage_week_cache WHERE year = ?`)
          .all(summary_year)
          .map(r => r.week_number)
      );
      // Exclude weeks the operator has explicitly marked as zero — there
      // genuinely aren't credit notes for a zero week, so leaving them
      // in the missing-list defeats the purpose of mark-zero. Mirrors
      // the same union the site-side /api/bat/week-status applies in
      // its own missingWeeks calculation. Without this the hub's
      // per-site tile shows W## as missing forever even after the
      // operator marked it zero on the site.
      const markedZeroWeeksInYear = new Set(
        prep(
          `SELECT week_number FROM bat_reconciliations WHERE year = ? AND marked_zero = 1`
        ).all(summary_year).map(r => r.week_number)
      );
      const missingCreditNotesList = [];
      for (let w = 1; w <= missingCutoffYear; w++) {
        if (!sageWeeksInYear.has(w) && !markedZeroWeeksInYear.has(w)) {
          missingCreditNotesList.push(w);
        }
      }

      // Mismatch weeks (current-year scope): weeks where both BAT and Sage
      // exist but the variance exceeds R0.01.
      const mismatchList = prep(
        `SELECT r.week_number,
                ABS(COALESCE(r.supplier_total, 0) - COALESCE(c.total, 0)) AS abs_diff
         FROM bat_reconciliations r
         INNER JOIN bat_sage_week_cache c
           ON c.year = r.year AND c.week_number = r.week_number
         WHERE r.year = ? AND ABS(COALESCE(r.supplier_total, 0) - COALESCE(c.total, 0)) >= 0.01
         ORDER BY r.week_number ASC`
      ).all(summary_year).map(x => x.week_number);

      res.json({
        site_id: SITE_ID,
        site_slug: SITE_SLUG,
        site_name: SITE_NAME,
        total_supplier,
        total_sage,
        total_variance: total_supplier - total_sage,
        weeks_count,
        matched_count,
        mismatch_count,
        awaiting_count,
        missing_weeks_count,
        total_exceptions: exc?.c || 0,
        total_exception_amount: exc?.a || 0,
        last_upload_at,
        // Per-week detail for the hub's per-site card.
        summary_year,
        last_paid_week,
        last_paid_year,
        last_bat_week,
        last_bat_year,
        missing_credit_notes_weeks: missingCreditNotesList,
        mismatch_weeks: mismatchList,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[reporting/bat-summary] error:', err);
      res.status(500).json({ error: 'Failed to build BAT summary' });
    }
  });

  router.get('/api/reporting/inventory', reportingRateLimiter, requireReportingToken, (req, res) => {
    const { limit, offset } = pagination(req, { defaultLimit: 1000, maxLimit: 1000 });
    const rows = prep(
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

  // ---- JTI archive intake (server-to-server, hub→site pull-fallback) ----
  //
  // The user-facing /api/jti/archive endpoints are gated by login +
  // can_access_jti. The hub doesn't have a logged-in user — it auths
  // via the same x-reporting-token middleware as the rest of this
  // file. Mounted as /api/reporting/jti/archives so the auth model is
  // unambiguous (anything under /api/reporting/* is server-to-server).
  router.get('/api/reporting/jti/archives', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      const limitRaw = Number(req.query?.limit);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 60;
      const archives = db.prepare(`
        SELECT * FROM jti_archive
        ORDER BY period_year DESC, period_month DESC, generated_at DESC
        LIMIT ?
      `).all(limit);
      res.json({ ok: true, site_id: SITE_ID, archives, limit });
    } catch (err) {
      console.error('[reporting/jti] list failed:', err.message);
      res.status(500).json({ error: 'Failed to list JTI archives' });
    }
  });

  router.get('/api/reporting/jti/archives/:id/download', reportingRateLimiter, requireReportingToken, (req, res) => {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid archive id' });
    }
    const row = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: `JTI archive #${id} not found` });
    if (!fs.existsSync(row.file_path)) {
      console.error(`[reporting/jti] archive #${id} (${row.filename}) missing on disk`);
      return res.status(410).json({ error: `JTI archive #${id} record exists but file missing on disk` });
    }
    const buffer = fs.readFileSync(row.file_path);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('X-JTI-Archive-Sha256', row.sha256);
    res.end(buffer);
  });

  return router;
}
