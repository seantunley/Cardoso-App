import express from 'express';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import db from '../db/index.js';
import { reportingRateLimiter } from '../middleware/rateLimit.js';
import { logError } from '../lib/errorLog.js';
import { buildStatements } from '../db/statements.js';
import { expandDataRecord, getFirstNonEmptyObjectValue, SALES_REP_ALIASES, ACCOUNT_TYPE_ALIASES } from '../helpers.js';

const execFileAsync = promisify(execFile);

const SITE_ID = process.env.SITE_ID || 'local';
const SITE_SLUG = process.env.SITE_SLUG || 'local';
const SITE_NAME = process.env.SITE_NAME || 'Local';
const CUSTOMER_BALANCES_MIN_AMOUNT = 3;

function parseAmount(value) {
  const num = parseFloat(String(value ?? '').replace(/,/g, '').replace(/\s/g, ''));
  return Number.isFinite(num) ? num : 0;
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
        sites = db.prepare(`
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
               COALESCE(s.name, r.site_id) AS site_name
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
          // Need a separate count for pagination metadata
          const countStmt = db.prepare(`SELECT COUNT(*) as count FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id WHERE r.outstanding_balance_num IS NOT NULL AND r.outstanding_balance_num > ? ${siteWhere}`);
          const countParams = siteFilter !== 'all' ? [balanceAmountGt, siteFilter] : [balanceAmountGt];
          total = (countStmt.get(...countParams) || { count: 0 }).count;
          // Sum for total outstanding across SQL-filtered set
          const sumStmt = db.prepare(`SELECT COALESCE(SUM(r.outstanding_balance_num), 0) as total FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id WHERE r.outstanding_balance_num IS NOT NULL AND r.outstanding_balance_num > ? ${siteWhere}`);
          filteredTotalOutstanding = parseFloat(sumStmt.get(...countParams).total || 0);
        }
        allRecords = db.prepare(fetchSql).all(...params).map(expandDataRecord);

      } else {
        sites = db.prepare(`
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
                    ? AS site_name
             FROM datarecord
             WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
               AND outstanding_balance != '0'
               AND outstanding_balance_num > ?
             ORDER BY outstanding_balance_num DESC
             LIMIT ? OFFSET ?`;
        const params = needsInMemoryFilter
          ? [SITE_NAME, balanceAmountGt]
          : [SITE_NAME, balanceAmountGt, limit, (page - 1) * limit];
        if (!needsInMemoryFilter) {
          const countStmt = db.prepare(`SELECT COUNT(*) as count FROM datarecord WHERE outstanding_balance_num IS NOT NULL AND outstanding_balance_num > ?`);
          total = (countStmt.get(balanceAmountGt) || { count: 0 }).count;
          const sumStmt = db.prepare(`SELECT COALESCE(SUM(outstanding_balance_num), 0) as total FROM datarecord WHERE outstanding_balance_num IS NOT NULL AND outstanding_balance_num > ?`);
          filteredTotalOutstanding = parseFloat(sumStmt.get(balanceAmountGt).total || 0);
        }
        allRecords = db.prepare(fetchSql).all(...params)
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
      let repSource;
      if (needsInMemoryFilter) {
        repSource = allRecords;
      } else {
        // Lightweight separate fetch — only needs the columns required to
        // hydrate sales_rep from JSON blobs.
        repSource = isHub
          ? db.prepare(
              `SELECT r.sales_rep FROM hub_records r WHERE r.outstanding_balance_num IS NOT NULL AND r.outstanding_balance_num > ?`
            ).all(balanceAmountGt)
          : db.prepare(
              `SELECT sales_rep, data, local_fields FROM datarecord WHERE outstanding_balance_num IS NOT NULL AND outstanding_balance_num > ?`
            ).all(balanceAmountGt).map(hydrateSalesRepAndAccountType);
      }
      const salesReps = Array.from(new Set(repSource.map(r => String(r.sales_rep || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

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
        sites = db.prepare(
          `SELECT DISTINCT COALESCE(s.name, r.site_id) AS site_name
           FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
           WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
             AND r.outstanding_balance != '0'
             AND r.outstanding_balance_num > ?
           ORDER BY site_name`
        ).all(minBalance).map(r => r.site_name).filter(Boolean);
        records = db.prepare(
          `SELECT r.customer_number, r.customer_name, r.sales_rep, r.account_type, r.terms,
                  r.outstanding_balance, r.unpaid_invoices, r.receipts,
                  r.flag_color, r.flag_reason, r.auto_flagged,
                  COALESCE(s.name, r.site_id) AS site_name
           FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
           WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
             AND r.outstanding_balance != '0'
             AND r.outstanding_balance_num > ?
             ${whereSite}
           ORDER BY r.outstanding_balance_num DESC`
        ).all(...dataParams).map(expandDataRecord);
      } else {
        sites = [SITE_NAME];
        records = db.prepare(
          `SELECT customer_number, customer_name, sales_rep, account_type, terms,
                  outstanding_balance, unpaid_invoices, receipts,
                  flag_color, flag_reason, auto_flagged,
                  data, local_fields,
                  ? AS site_name
           FROM datarecord
           WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
             AND outstanding_balance != '0'
             AND outstanding_balance_num > ?
           ORDER BY outstanding_balance_num DESC`
        ).all(SITE_NAME, minBalance).map(hydrateSalesRepAndAccountType).map(expandDataRecord);
      }

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

      const enriched = filtered.map(r => {
        const balance = parseAmount(r.outstanding_balance);
        const ageDays = getBalanceAgeDays(r);
        let bucket;
        if (ageDays === null) bucket = 'unknown';
        else if (ageDays < 7) bucket = 'current';
        else if (ageDays < 14) bucket = '7-13';
        else if (ageDays < 21) bucket = '14-20';
        else bucket = '21+';
        buckets[bucket] += balance;
        bucketCounts[bucket]++;
        totalOutstanding += balance;
        return { ...r, age_days: ageDays, bucket, parsed_balance: balance };
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
  router.get('/api/reports/rep-exposure', requireAuth, (req, res) => {
    const isHub = process.env.HUB_MODE === 'true';
    const minBalance = Math.max(0, parseFloat(req.query.min_balance) || CUSTOMER_BALANCES_MIN_AMOUNT);
    try {
      let records;
      if (isHub) {
        records = db.prepare(
          `SELECT r.customer_number, r.customer_name, r.sales_rep, r.account_type,
                  r.outstanding_balance, r.flag_color, r.unpaid_invoices,
                  COALESCE(s.name, r.site_id) AS site_name
           FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
           WHERE r.outstanding_balance IS NOT NULL AND r.outstanding_balance != ''
             AND r.outstanding_balance != '0'
             AND r.outstanding_balance_num > ?`
        ).all(minBalance).map(expandDataRecord);
      } else {
        records = db.prepare(
          `SELECT customer_number, customer_name, sales_rep, account_type,
                  outstanding_balance, flag_color, unpaid_invoices,
                  data, local_fields,
                  ? AS site_name
           FROM datarecord
           WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
             AND outstanding_balance != '0'
             AND outstanding_balance_num > ?`
        ).all(SITE_NAME, minBalance).map(hydrateSalesRepAndAccountType).map(expandDataRecord);
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
      const rows = db.prepare(
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

      const yearsRow = db.prepare('SELECT DISTINCT year FROM bat_reconciliations ORDER BY year DESC').all();
      res.json({ weeks, summary, year, available_years: yearsRow.map(r => r.year), generated_at: new Date().toISOString() });
    } catch (err) {
      console.error('[reporting] bat-weekly error:', err);
      res.status(500).json({ error: 'Failed to fetch BAT weekly report' });
    }
  });

  // GET /api/reports/bat-ytd?year=YYYY — YTD fee-type breakdown comparing
  // BAT's claimed totals to Sage's posted credit-note totals.
  router.get('/api/reports/bat-ytd', requireAuth, (req, res) => {
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    try {
      const supplierAgg = db.prepare(
        `SELECT
           COALESCE(SUM(supplier_discount), 0) AS discount,
           COALESCE(SUM(supplier_delivery), 0) AS delivery,
           COALESCE(SUM(supplier_pricing),  0) AS pricing,
           COALESCE(SUM(supplier_total),    0) AS total,
           COUNT(*) AS week_count
         FROM bat_reconciliations WHERE year = ?`
      ).get(year);
      const sageAgg = db.prepare(
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

      const yearsRow = db.prepare(`SELECT DISTINCT year FROM bat_reconciliations UNION SELECT DISTINCT year FROM bat_sage_week_cache ORDER BY year DESC`).all();
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
      const rows = db.prepare(
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

      const yearsRow = db.prepare(
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
      const sql = isHub
        ? `SELECT i.item_number, i.item_description, i.qty_on_hand, i.last_cost, i.price, i.commodity, i.inventory_value, COALESCE(s.name, i.site_id) AS site_name FROM hub_inventory i LEFT JOIN hub_sites s ON s.id = i.site_id`
        : `SELECT item_number, item_description, qty_on_hand, last_cost, price, commodity, inventory_value, ? AS site_name FROM inventoryrecord`;
      const rows = isHub ? db.prepare(sql).all() : db.prepare(sql).all(SITE_NAME);

      const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '').replace(/\s/g, '')); return Number.isFinite(n) ? n : 0; };
      const enriched = rows.map(r => ({
        item_number: r.item_number,
        item_description: r.item_description,
        qty_on_hand: num(r.qty_on_hand),
        last_cost: num(r.last_cost),
        price: num(r.price),
        commodity: (r.commodity || '— Uncategorised').toString().trim() || '— Uncategorised',
        inventory_value: num(r.inventory_value) || (num(r.qty_on_hand) * num(r.last_cost)),
        site_name: r.site_name,
      }));

      const commodityMap = new Map();
      let totalValue = 0;
      for (const it of enriched) {
        let c = commodityMap.get(it.commodity);
        if (!c) { c = { commodity: it.commodity, item_count: 0, total_value: 0, total_qty: 0 }; commodityMap.set(it.commodity, c); }
        c.item_count++; c.total_value += it.inventory_value; c.total_qty += it.qty_on_hand;
        totalValue += it.inventory_value;
      }
      const byCommodity = Array.from(commodityMap.values()).sort((a, b) => b.total_value - a.total_value);
      const topItems = enriched.slice().sort((a, b) => b.inventory_value - a.inventory_value).slice(0, topN);

      res.json({
        summary: {
          total_items: enriched.length,
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
      res.status(500).json({ error: 'Failed to fetch inventory report' });
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
  router.get('/api/reporting/records', reportingRateLimiter, requireReportingToken, (req, res) => {
    const since = req.query.since;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
    const offset = parseInt(req.query.offset) || 0;
    let rows;
    if (since) {
      rows = db.prepare(
        `SELECT id, customer_number, customer_name, flag_color, flag_reason, flag_created_by,
                outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
                updated_date, synced_at, source_table, source_id, sales_rep, account_type, data, local_fields
         FROM datarecord WHERE updated_date > ? ORDER BY updated_date ASC LIMIT ? OFFSET ?`
      ).all(since, limit, offset).map(hydrateSalesRepAndAccountType).map(({ data, ...row }) => row);
    } else {
      rows = db.prepare(
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
      const rows = db.prepare(
        `SELECT r.year, r.week_number,
                COALESCE(r.supplier_total, 0) AS supplier_total,
                COALESCE(c.total, r.sage_total, 0) AS sage_total,
                CASE WHEN c.year IS NOT NULL THEN 1 ELSE 0 END AS sage_present,
                r.created_at, r.upload_filename
         FROM bat_reconciliations r
         LEFT JOIN bat_sage_week_cache c ON c.year = r.year AND c.week_number = r.week_number`
      ).all();

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

      const exc = db.prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(order_amount), 0) AS a
         FROM bat_invoice_extractions WHERE is_exception = 1`
      ).get();

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
        total_exceptions: exc?.c || 0,
        total_exception_amount: exc?.a || 0,
        last_upload_at,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[reporting/bat-summary] error:', err);
      res.status(500).json({ error: 'Failed to build BAT summary' });
    }
  });

  router.get('/api/reporting/inventory', reportingRateLimiter, requireReportingToken, (req, res) => {
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
