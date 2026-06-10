import express from 'express';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import db from '../db/index.js';
import { rebuildInventorySalesRollups } from '../services/inventoryMovement.js';
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
import { getLastPaidSageWeek, getLastBatReconciliationWeek, getSagePool } from '../services/batReconciliation.js';
import { buildStatements } from '../db/statements.js';
import { expandDataRecord, getFirstNonEmptyObjectValue, parseJsonSafely, SALES_REP_ALIASES, ACCOUNT_TYPE_ALIASES } from '../helpers.js';
import { analyseInvoiceCredit } from '../lib/creditAnalysis.js';
import { getCreditLogicForAnalysis } from '../services/creditLogic.js';
import { ageOpenItems, BUCKET_KEYS, AP_SCHEME } from '../services/aging.js';

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

// Legacy hub fallback: customer matches a Sage period if ANY of their invoices
// (from the unpaid_invoices snapshot, aged by document date) falls in that
// period. Used only in hub mode until PR3's ETL populates hub_debtor_ar_invoice;
// site mode uses the open-item ledger via the engine. Period keys match the
// engine's (1-7 / 8-14 / 15-21 / over-21).
function matchesAgeBucket(record, ageBucket) {
  if (!ageBucket || ageBucket === 'all') return true;
  const ages = getBalanceInvoiceAges(record);
  if (ages.length === 0) return false;
  if (ageBucket === '1-7')     return ages.some((d) => d >= 1  && d <= 7);
  if (ageBucket === '8-14')    return ages.some((d) => d >= 8  && d <= 14);
  if (ageBucket === '15-21')   return ages.some((d) => d >= 15 && d <= 21);
  if (ageBucket === 'over-21') return ages.some((d) => d >= 22);
  if (ageBucket === 'current') return ages.some((d) => d <= 0);
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

/**
 * Build the hub Aged Debtors source rows with a PER-SITE ledger/snapshot
 * decision (SYNC-5). Each site whose AR open-item sync has COMPLETED (tracked in
 * hub_debtor_ar_sync) is aged from its open-item ledger — even if that ledger is
 * empty because the site is fully paid up; a site whose AR ETL hasn't run yet
 * falls back to its hub_records snapshot (one pseudo-document per customer aged
 * by the oldest dated unpaid invoice). The earlier GLOBAL ledger-ready check used
 * the ledger for ALL sites the moment ONE site synced, dropping every
 * not-yet-synced site's debtors; using row presence as the per-site marker would
 * conversely show stale snapshot balances for a synced-but-fully-paid site.
 *
 * Exported for unit testing. `prep` is the caching db.prepare wrapper from the
 * router; `siteFilter` is the resolved site name or 'all'.
 *
 * @returns {{ rows: object[], sites: string[], ledgerReady: boolean }}
 */
export function acquireHubAgedDebtorRows(prep, siteFilter) {
  // Sites whose AR open-item sync has COMPLETED, tracked in hub_debtor_ar_sync —
  // NOT inferred from the presence of ledger rows. A synced site that is fully
  // paid up has zero hub_debtor_ar_invoice rows but must still be aged from the
  // (empty) ledger, not fall back to its possibly-stale hub_records snapshot
  // (SYNC-5). The snapshot query EXCLUDES these sites to avoid double-counting.
  const ledgerSiteIds = prep(
    'SELECT site_id FROM hub_debtor_ar_sync'
  ).all().map((r) => r.site_id);

  // Readiness for the requested scope, from the sync markers — NOT row count, so
  // a synced-but-fully-paid site reads as "ready, nothing outstanding" rather
  // than "no data yet". all-sites: any site has synced; a specific site: that
  // site has synced. The caller uses this for the ledger_empty / "no data" flag.
  const ledgerReady = siteFilter === 'all'
    ? ledgerSiteIds.length > 0
    : !!prep(
        `SELECT 1 FROM hub_debtor_ar_sync ds LEFT JOIN hub_sites s ON s.id = ds.site_id
         WHERE COALESCE(s.name, ds.site_id) = ? LIMIT 1`
      ).get(siteFilter);

  // Placeholder list of synced site ids, reused by the ledger queries below.
  const inLedger = ledgerSiteIds.map(() => '?').join(',');

  // --- Ledger rows: ONLY synced sites. A synced site that is fully paid up has
  //     no rows here and correctly contributes nothing — it is NOT snapshotted. ---
  let ledgerRows = [];
  if (ledgerSiteIds.length) {
    const ledgerParams = [...ledgerSiteIds];
    let ledgerWhereSite = '';
    if (siteFilter !== 'all') { ledgerWhereSite = 'AND COALESCE(s.name, i.site_id) = ?'; ledgerParams.push(siteFilter); }
    ledgerRows = prep(
      `SELECT i.site_id, i.customer_code, i.reporting_account, i.document_number, i.document_type, i.document_date, i.due_date,
              i.outstanding_amount, i.reference,
              d.customer_name, d.sales_rep, d.account_type, d.terms,
              COALESCE(s.name, i.site_id) AS site_name
       FROM hub_debtor_ar_invoice i
       LEFT JOIN hub_records d ON d.site_id = i.site_id AND TRIM(d.customer_number) = TRIM(i.reporting_account)
       LEFT JOIN hub_sites s ON s.id = i.site_id
       WHERE i.outstanding_amount <> 0 AND i.site_id IN (${inLedger}) ${ledgerWhereSite}`
    ).all(...ledgerParams);
  }

  // --- Snapshot rows: ONLY sites that have NOT synced AR open-items (no double
  //     count — synced sites are sourced from the ledger above, even when empty). ---
  const notLedger = ledgerSiteIds.length ? `AND r.site_id NOT IN (${inLedger})` : '';
  const snapParams = [];
  let snapWhereSite = '';
  if (siteFilter !== 'all') { snapWhereSite = 'AND COALESCE(s.name, r.site_id) = ?'; snapParams.push(siteFilter); }
  const snapshotRows = prep(
    `SELECT r.site_id, TRIM(r.customer_number) AS customer_code,
            r.customer_name, r.sales_rep, r.account_type, r.terms,
            r.outstanding_balance_num, r.unpaid_invoices,
            COALESCE(s.name, r.site_id) AS site_name
     FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
     WHERE r.outstanding_balance_num <> 0 ${snapWhereSite} ${notLedger}`
  ).all(...snapParams, ...ledgerSiteIds).map((r) => {
    const inv = parseJsonSafely(r.unpaid_invoices, []);
    // Oldest dated unpaid line — the snapshot array isn't guaranteed oldest-first;
    // null when absent → the aging engine's "unknown" bucket (balance still counted).
    let oldestDate = null, oldestT = Infinity;
    if (Array.isArray(inv)) {
      for (const it of inv) {
        const raw = it?.date;
        if (!raw) continue;
        const t = Date.parse(raw);
        if (!Number.isNaN(t) && t < oldestT) { oldestT = t; oldestDate = raw; }
      }
    }
    return {
      ...r,
      document_number: r.customer_code,
      document_type: '',
      document_date: oldestDate,
      due_date: oldestDate,
      outstanding_amount: r.outstanding_balance_num,
      reference: '',
    };
  });

  // Site dropdown = synced sites that have ledger rows + not-yet-synced sites
  // with a snapshot balance, so the filter lists every site that has data to
  // show. (A synced-but-fully-paid site has no rows under either source and so
  // correctly does not appear — there is nothing to filter to.)
  const siteSet = new Set();
  if (ledgerSiteIds.length) {
    prep(
      `SELECT DISTINCT COALESCE(s.name, i.site_id) AS site_name
       FROM hub_debtor_ar_invoice i LEFT JOIN hub_sites s ON s.id = i.site_id
       WHERE i.outstanding_amount <> 0 AND i.site_id IN (${inLedger})`
    ).all(...ledgerSiteIds).forEach((r) => { if (r.site_name) siteSet.add(r.site_name); });
  }
  prep(
    `SELECT DISTINCT COALESCE(s.name, r.site_id) AS site_name
     FROM hub_records r LEFT JOIN hub_sites s ON s.id = r.site_id
     WHERE r.outstanding_balance_num > 0 ${notLedger}`
  ).all(...ledgerSiteIds).forEach((r) => { if (r.site_name) siteSet.add(r.site_name); });

  return { rows: [...ledgerRows, ...snapshotRows], sites: [...siteSet].sort(), ledgerReady };
}

export function createReportingRouter({ requireAuth, requirePermission }) {
  // Report data (trends, exports, insights) is gated by can_access_reports so
  // a bare authenticated account can't read revenue / dead-stock / debtor data
  // it isn't entitled to. Fallback to requireAuth-only if requirePermission
  // wasn't supplied (defensive; server.js always passes it).
  const reportsGuard = requirePermission ? [requireAuth, requirePermission('can_access_reports')] : [requireAuth];
  // Aged Creditors is reachable from BOTH the Reports page (Reports users) and
  // the Creditors module (Creditor users), so it accepts EITHER permission
  // (requirePermission is OR over its keys). Keeps the API in step with both
  // entry points instead of locking out whichever group lacks the other grant.
  const creditorsGuard = requirePermission ? [requireAuth, requirePermission('can_access_reports', 'can_access_creditors')] : [requireAuth];
  // Monthly Sales Figures lives in the "Monthly Reports" sidebar group, gated by
  // its own permission rather than the general reports permission.
  const monthlyReportsGuard = requirePermission ? [requireAuth, requirePermission('can_access_monthly_reports')] : [requireAuth];
  const stmts = buildStatements(db);
  const router = express.Router();

  // ── AR Document Summary (Invoices / Credit Notes / Debit Notes by month) ──
  const arMkAmt = (excl, vat, incl) => ({ excl: Number(excl) || 0, vat: Number(vat) || 0, incl: Number(incl) || 0 });
  const arSumTotals = (months) => {
    const blank = () => ({ excl: 0, vat: 0, incl: 0 });
    const t = { invoices: blank(), credit_notes: blank(), debit_notes: blank(), net_incl: 0 };
    for (const m of months) {
      for (const k of ['invoices', 'credit_notes', 'debit_notes']) { t[k].excl += m[k].excl; t[k].vat += m[k].vat; t[k].incl += m[k].incl; }
      t.net_incl += m.net_incl;
    }
    return t;
  };
  // Live Sage query for one site (also used by the hub-pull endpoint). Posted
  // A/R documents (ARIBH/ARIBC), excluding ERROR batches + zero-VAT docs
  // (AMTTAX1 > 0), mirroring the operator's Crystal "Sales Figures" report.
  // TEXTTRX 1/2/3 = invoice/debit note/credit note. BASETAX1 ex-VAT, AMTTAX1
  // VAT, AMTNETTOT incl.
  async function queryArDocSummary(from, to) {
    const pool = await getSagePool();
    const rs = await pool.request().input('from', from).input('to', to).query(`
      SELECT LEFT(CAST(h.DATEINVC AS varchar(8)), 6) AS ym,
        SUM(CASE WHEN h.TEXTTRX = 1 THEN h.BASETAX1  ELSE 0 END) AS inv_excl,
        SUM(CASE WHEN h.TEXTTRX = 1 THEN h.AMTTAX1   ELSE 0 END) AS inv_vat,
        SUM(CASE WHEN h.TEXTTRX = 1 THEN h.AMTNETTOT ELSE 0 END) AS inv_incl,
        SUM(CASE WHEN h.TEXTTRX = 2 THEN h.BASETAX1  ELSE 0 END) AS dn_excl,
        SUM(CASE WHEN h.TEXTTRX = 2 THEN h.AMTTAX1   ELSE 0 END) AS dn_vat,
        SUM(CASE WHEN h.TEXTTRX = 2 THEN h.AMTNETTOT ELSE 0 END) AS dn_incl,
        SUM(CASE WHEN h.TEXTTRX = 3 THEN h.BASETAX1  ELSE 0 END) AS cn_excl,
        SUM(CASE WHEN h.TEXTTRX = 3 THEN h.AMTTAX1   ELSE 0 END) AS cn_vat,
        SUM(CASE WHEN h.TEXTTRX = 3 THEN h.AMTNETTOT ELSE 0 END) AS cn_incl
      FROM ARIBC c INNER JOIN ARIBH h ON c.CNTBTCH = h.CNTBTCH
      WHERE c.BTCHDESC NOT LIKE 'ERROR%' AND h.AMTTAX1 > 0 AND h.DATEINVC BETWEEN @from AND @to
      GROUP BY LEFT(CAST(h.DATEINVC AS varchar(8)), 6)
      ORDER BY ym`);
    const months = rs.recordset.map((r) => {
      const invoices = arMkAmt(r.inv_excl, r.inv_vat, r.inv_incl);
      const debit_notes = arMkAmt(r.dn_excl, r.dn_vat, r.dn_incl);
      const credit_notes = arMkAmt(r.cn_excl, r.cn_vat, r.cn_incl);
      const ym = String(r.ym);
      return { month: `${ym.slice(0, 4)}-${ym.slice(4, 6)}`, invoices, credit_notes, debit_notes, net_incl: invoices.incl + debit_notes.incl - credit_notes.incl };
    });
    return { months, totals: arSumTotals(months) };
  }
  const arYmdInt = (s, dflt) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Number(`${m[1]}${m[2]}${m[3]}`) : dflt; };
  const arIntToYm = (n) => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}`;

  // GET /api/reports/ar-document-summary?from=&to= — site mode runs the live
  // Sage query; HUB mode reads the per-branch totals synced down into
  // hub_ar_document_summary (hubEtl pulls each branch's /api/reporting variant).
  router.get('/api/reports/ar-document-summary', ...monthlyReportsGuard, async (req, res) => {
    try {
      const now = new Date();
      const from = arYmdInt(req.query.from, Number(`${now.getFullYear()}0101`));
      const to = arYmdInt(req.query.to, Number(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`));

      if (process.env.HUB_MODE === 'true') {
        // Optional single-branch filter (matched on the branch's display name);
        // 'all' keeps the consolidated table + per-branch sections.
        const siteFilter = String(req.query.site || 'all').trim();
        const siteWhere = siteFilter !== 'all' ? 'AND COALESCE(hs.name, s.site_id) = ?' : '';
        const siteParams = siteFilter !== 'all' ? [siteFilter] : [];
        const sites = prep(`
          SELECT DISTINCT COALESCE(hs.name, s.site_id) AS site_name
          FROM hub_ar_document_summary s LEFT JOIN hub_sites hs ON hs.id = s.site_id
          ORDER BY site_name`).all().map(r => r.site_name).filter(Boolean);
        const rows = prep(`
          SELECT s.site_id, COALESCE(hs.name, s.site_id) AS site_name, s.ym,
                 s.inv_excl, s.inv_vat, s.inv_incl, s.cn_excl, s.cn_vat, s.cn_incl, s.dn_excl, s.dn_vat, s.dn_incl
          FROM hub_ar_document_summary s LEFT JOIN hub_sites hs ON hs.id = s.site_id
          WHERE s.ym >= ? AND s.ym <= ? ${siteWhere} ORDER BY site_name, s.ym`).all(arIntToYm(from), arIntToYm(to), ...siteParams);
        const toMonth = (r) => ({
          month: r.ym,
          invoices: arMkAmt(r.inv_excl, r.inv_vat, r.inv_incl),
          credit_notes: arMkAmt(r.cn_excl, r.cn_vat, r.cn_incl),
          debit_notes: arMkAmt(r.dn_excl, r.dn_vat, r.dn_incl),
          net_incl: (Number(r.inv_incl) || 0) + (Number(r.dn_incl) || 0) - (Number(r.cn_incl) || 0),
        });
        const bySite = new Map();
        for (const r of rows) {
          if (!bySite.has(r.site_id)) bySite.set(r.site_id, { site_id: r.site_id, site_name: r.site_name, months: [] });
          bySite.get(r.site_id).months.push(toMonth(r));
        }
        const branches = [...bySite.values()].map((b) => ({ ...b, totals: arSumTotals(b.months) }));
        const consMap = new Map();
        for (const b of branches) for (const m of b.months) {
          if (!consMap.has(m.month)) consMap.set(m.month, { month: m.month, invoices: arMkAmt(0, 0, 0), credit_notes: arMkAmt(0, 0, 0), debit_notes: arMkAmt(0, 0, 0), net_incl: 0 });
          const c = consMap.get(m.month);
          for (const k of ['invoices', 'credit_notes', 'debit_notes']) { c[k].excl += m[k].excl; c[k].vat += m[k].vat; c[k].incl += m[k].incl; }
          c.net_incl += m.net_incl;
        }
        const consolidatedMonths = [...consMap.values()].sort((a, b) => a.month.localeCompare(b.month));
        return res.json({ hub_mode: true, site_name: siteFilter !== 'all' ? siteFilter : 'All branches', from, to, branches, consolidated: { months: consolidatedMonths, totals: arSumTotals(consolidatedMonths) }, filters: { sites } });
      }

      const { months, totals } = await queryArDocSummary(from, to);
      // Depot name from Settings → Depot Details (depot_profile.name), falling
      // back to SITE_NAME if it hasn't been filled in.
      const depotRow = prep('SELECT name FROM depot_profile WHERE id = 1').get();
      const depotName = (depotRow?.name || '').trim() || SITE_NAME;
      res.json({ from, to, months, totals, site_name: depotName });
    } catch (err) {
      console.error('[ar-document-summary] failed', err.message);
      res.status(503).json({ error: 'Could not load the document summary. Check the Sage connection and try again.' });
    }
  });

  // Same ARIBH/ARIBC query as the monthly summary, but grouped by full day
  // (YYYYMMDD) instead of month — used by the Daily Sales Figures report for the
  // current month. Filters/joins identical so the daily rows reconcile to the
  // month total.
  async function queryArDailySummary(from, to) {
    const pool = await getSagePool();
    const rs = await pool.request().input('from', from).input('to', to).query(`
      SELECT CAST(h.DATEINVC AS varchar(8)) AS ymd,
        SUM(CASE WHEN h.TEXTTRX = 1 THEN h.BASETAX1  ELSE 0 END) AS inv_excl,
        SUM(CASE WHEN h.TEXTTRX = 1 THEN h.AMTTAX1   ELSE 0 END) AS inv_vat,
        SUM(CASE WHEN h.TEXTTRX = 1 THEN h.AMTNETTOT ELSE 0 END) AS inv_incl,
        SUM(CASE WHEN h.TEXTTRX = 2 THEN h.BASETAX1  ELSE 0 END) AS dn_excl,
        SUM(CASE WHEN h.TEXTTRX = 2 THEN h.AMTTAX1   ELSE 0 END) AS dn_vat,
        SUM(CASE WHEN h.TEXTTRX = 2 THEN h.AMTNETTOT ELSE 0 END) AS dn_incl,
        SUM(CASE WHEN h.TEXTTRX = 3 THEN h.BASETAX1  ELSE 0 END) AS cn_excl,
        SUM(CASE WHEN h.TEXTTRX = 3 THEN h.AMTTAX1   ELSE 0 END) AS cn_vat,
        SUM(CASE WHEN h.TEXTTRX = 3 THEN h.AMTNETTOT ELSE 0 END) AS cn_incl
      FROM ARIBC c INNER JOIN ARIBH h ON c.CNTBTCH = h.CNTBTCH
      WHERE c.BTCHDESC NOT LIKE 'ERROR%' AND h.AMTTAX1 > 0 AND h.DATEINVC BETWEEN @from AND @to
      GROUP BY CAST(h.DATEINVC AS varchar(8))
      ORDER BY ymd`);
    const days = rs.recordset.map((r) => {
      const invoices = arMkAmt(r.inv_excl, r.inv_vat, r.inv_incl);
      const debit_notes = arMkAmt(r.dn_excl, r.dn_vat, r.dn_incl);
      const credit_notes = arMkAmt(r.cn_excl, r.cn_vat, r.cn_incl);
      const ymd = String(r.ymd);
      return { day: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`, invoices, credit_notes, debit_notes, net_incl: invoices.incl + debit_notes.incl - credit_notes.incl };
    });
    return { days, totals: arSumTotals(days) };
  }

  // GET /api/reports/daily-sales-figures — current month's posted A/R documents
  // broken down by day (same VAT split + Net as the monthly Sales Figures).
  // Site-only: the hub stores monthly totals, not daily, so HUB_MODE returns an
  // explicit "unavailable" flag the UI surfaces as a note.
  // Gated by monthlyReportsGuard (same as ar-document-summary above): it exposes
  // the same posted-document figures, so Reports-only users must not reach it.
  router.get('/api/reports/daily-sales-figures', ...monthlyReportsGuard, async (req, res) => {
    try {
      const now = new Date();
      const y = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, '0');
      const from = Number(`${y}${mo}01`);
      const to = Number(`${y}${mo}${String(now.getDate()).padStart(2, '0')}`);
      const month = `${y}-${mo}`;

      if (process.env.HUB_MODE === 'true') {
        return res.json({ hub_mode: true, unavailable: true, month, from, to, days: [], totals: null });
      }

      const { days, totals } = await queryArDailySummary(from, to);
      const depotRow = prep('SELECT name FROM depot_profile WHERE id = 1').get();
      const depotName = (depotRow?.name || '').trim() || SITE_NAME;
      res.json({ month, from, to, days, totals, site_name: depotName });
    } catch (err) {
      console.error('[daily-sales-figures] failed', err.message);
      res.status(503).json({ error: 'Could not load the daily sales figures. Check the Sage connection and try again.' });
    }
  });

  // GET /api/reports/debtor-balance-summary — headline debtor exposure for the
  // dashboard tile. Positive open balances only (excludes net-credit customers),
  // so it matches the Customer Balances page total to the cent, plus the AR
  // aging buckets. Site reads datarecord; hub reads hub_records (which carries
  // no per-bucket data, so buckets are null there).
  router.get('/api/reports/debtor-balance-summary', ...reportsGuard, (req, res) => {
    try {
      const positiveWhere = "outstanding_balance IS NOT NULL AND outstanding_balance != '' AND outstanding_balance != '0' AND outstanding_balance_num > 0";
      if (process.env.HUB_MODE === 'true') {
        const r = prep(`SELECT COUNT(*) n, COALESCE(SUM(outstanding_balance_num), 0) total FROM hub_records WHERE ${positiveWhere}`).get();
        return res.json({ total_outstanding: r.total, total_customers: r.n, buckets: null });
      }
      const r = prep(`
        SELECT COUNT(*) n, COALESCE(SUM(outstanding_balance_num), 0) total,
          COALESCE(SUM(CAST(json_extract(data, '$.age_current')  AS REAL)), 0) b_current,
          COALESCE(SUM(CAST(json_extract(data, '$.age_1_7')      AS REAL)), 0) b_1_7,
          COALESCE(SUM(CAST(json_extract(data, '$.age_8_14')     AS REAL)), 0) b_8_14,
          COALESCE(SUM(CAST(json_extract(data, '$.age_15_21')    AS REAL)), 0) b_15_21,
          COALESCE(SUM(CAST(json_extract(data, '$.age_over_21')  AS REAL)), 0) b_over_21
        FROM datarecord WHERE ${positiveWhere}`).get();
      res.json({
        total_outstanding: r.total,
        total_customers: r.n,
        buckets: { current: r.b_current, '1-7': r.b_1_7, '8-14': r.b_8_14, '15-21': r.b_15_21, 'over-21': r.b_over_21 },
      });
    } catch (err) {
      console.error('[debtor-balance-summary] failed', err.message);
      res.status(500).json({ error: 'Could not load the debtor balance summary.' });
    }
  });

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
      const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
      // Hub: KPIs come from the consolidated hub_records (all branches), with an
      // optional ?site= branch filter and the full branch list for the selector.
      // (Site-mode datarecord is empty on a hub install, so the prior path read 0.)
      if (process.env.HUB_MODE === 'true') {
        const siteFilter = String(req.query.site || 'all').trim();
        const where = siteFilter !== 'all' ? 'WHERE COALESCE(hs.name, r.site_id) = ?' : '';
        const params = siteFilter !== 'all' ? [siteFilter] : [];
        const total = prep(`SELECT COUNT(*) AS count FROM hub_records r LEFT JOIN hub_sites hs ON hs.id = r.site_id ${where}`).get(...params);
        const byFlag = prep(`SELECT r.flag_color, COUNT(*) AS count FROM hub_records r LEFT JOIN hub_sites hs ON hs.id = r.site_id ${where} GROUP BY r.flag_color`).all(...params);
        for (const row of byFlag) if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
        const sites = prep(`SELECT DISTINCT COALESCE(hs.name, r.site_id) AS site_name FROM hub_records r LEFT JOIN hub_sites hs ON hs.id = r.site_id ORDER BY site_name`).all().map(x => x.site_name).filter(Boolean);
        return res.json({ total_records: total.count, records_by_flag: flagCounts, last_sync_at: null, hub_mode: true, filters: { sites } });
      }
      const total = stmts.kpiTotalRecords.get();
      const byFlag = stmts.kpiFlagCounts.all();
      const lastSync = stmts.kpiLastSync.get();
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
    // Cap raised from 200 → 10000 so the Customer Balances page can
    // request its full dataset in one fetch (no client-side pagination
    // — it scrolls in place like the Inventory list).
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 10000);
    const isHub = process.env.HUB_MODE === 'true';
    const siteFilter = String(req.query.site || 'all').trim();
    const ageBucket = String(req.query.ageBucket || 'all').trim();
    const salesRepFilter = String(req.query.salesRep || 'all').trim();
    const hideInvoiceMatchesBalance = ['1', 'true', 'yes', 'on'].includes(String(req.query.hideInvoiceMatchesBalance || '').toLowerCase());
    const lastPurchaseDays = Math.max(parseInt(req.query.lastPurchaseDays, 10) || 0, 0);
    const dormantOnly = ['1', 'true', 'yes', 'on'].includes(String(req.query.dormantOnly || '').toLowerCase());
    // National-account filter: 'all' | 'national' | 'standard'.
    const accountTypeFilter = String(req.query.accountType || 'all').trim().toLowerCase();

    const balanceAmountGt = CUSTOMER_BALANCES_MIN_AMOUNT;
    const siteWhere = (siteFilter !== 'all' && isHub) ? `AND COALESCE(s.name, r.site_id) = ?` : '';
    // sales_rep can come from JSON blobs (data / local_fields) so we always
    // filter it in JS after hydrateSalesRepAndAccountType has run.
    // Same goes for age bucket / invoice-match / last-purchase / dormant
    // (need parsed invoices and computed credit verdicts).
    const needsInMemoryFilter =
      ageBucket !== 'all' ||
      hideInvoiceMatchesBalance ||
      salesRepFilter !== 'all' ||
      lastPurchaseDays > 0 ||
      dormantOnly ||
      accountTypeFilter !== 'all';

    try {
      let sites = [];
      let total = 0;
      let filteredTotalOutstanding = 0;
      let allRecords = [];

      // Active credit-logic config (the hub-synced 'local' config where a site
      // has one) — loaded once per request and memoised. The server-computed
      // credit badge MUST use it; passing null falls back to the default and
      // silently ignores configured thresholds, which the client-side badge
      // then trusts over its own fetched config.
      let _creditConfig;
      const creditConfig = () => (_creditConfig ??= getCreditLogicForAnalysis().config);

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
          ? `SELECT id, customer_number, customer_name, sales_rep, account_type,
                    outstanding_balance, unpaid_invoices, receipts,
                    flag_color, flag_reason, auto_flagged,
                    json_extract(data, '$.terms') AS terms,
                    json_extract(data, '$.location') AS location,
                    json_extract(data, '$.age_current') AS age_current,
                    json_extract(data, '$.age_1_7') AS age_1_7,
                    json_extract(data, '$.age_8_14') AS age_8_14,
                    json_extract(data, '$.age_15_21') AS age_15_21,
                    json_extract(data, '$.age_over_21') AS age_over_21,
                    local_fields,
                    ? AS site_name
             FROM datarecord
             WHERE outstanding_balance IS NOT NULL AND outstanding_balance != ''
               AND outstanding_balance != '0'
               AND outstanding_balance_num > ?
             ORDER BY outstanding_balance_num DESC`
          : `SELECT id, customer_number, customer_name, sales_rep, account_type,
                    outstanding_balance, unpaid_invoices, receipts,
                    flag_color, flag_reason, auto_flagged,
                    json_extract(data, '$.terms') AS terms,
                    json_extract(data, '$.location') AS location,
                    json_extract(data, '$.age_current') AS age_current,
                    json_extract(data, '$.age_1_7') AS age_1_7,
                    json_extract(data, '$.age_8_14') AS age_8_14,
                    json_extract(data, '$.age_15_21') AS age_15_21,
                    json_extract(data, '$.age_over_21') AS age_over_21,
                    local_fields,
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
          .map(expandDataRecord)
          .map((row) => {
            // Compute credit verdict once on the server so the client can
            // skip the per-row useMemo on every parent re-render.
            try {
              const { verdict, score } = analyseInvoiceCredit([row], [], creditConfig());
              row.credit_verdict = verdict;
              row.credit_score = score;
            } catch (err) {
              console.error('[balances.credit_verdict] compute failed for', {
                id: row?.id,
                customer_number: row?.customer_number,
              }, err.message);
            }
            return row;
          });
      }

      // ── In-memory pagination path (age bucket / invoice-match / sales rep active) ──
      let recordsForPage;
      let pageTotalOutstanding;

      // Aging summary for the on-screen tiles. The buckets are computed in the
      // customer sync query (so each record's buckets sum to its balance), so
      // summing them over the SAME set as the list total makes the tiles
      // reconcile to the displayed total by construction.
      let aging = null;
      const AGE_COLS = [['current', 'age_current'], ['1-7', 'age_1_7'], ['8-14', 'age_8_14'], ['15-21', 'age_15_21'], ['over-21', 'age_over_21']];
      const sumBuckets = (rs) => {
        const buckets = { current: 0, '1-7': 0, '8-14': 0, '15-21': 0, 'over-21': 0 };
        const bucket_counts = { current: 0, '1-7': 0, '8-14': 0, '15-21': 0, 'over-21': 0 };
        let total = 0;
        for (const r of rs) for (const [k, col] of AGE_COLS) { const v = Number(r[col]) || 0; buckets[k] += v; if (v !== 0) bucket_counts[k] += 1; total += v; }
        return { buckets, bucket_counts, total_outstanding: total };
      };

      if (needsInMemoryFilter) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const filtered = allRecords.filter((row) => {
          if (ageBucket !== 'all') {
            // Buckets come straight off the record (computed in the customer
            // sync query, so they reconcile to the balance). 'over-21' -> age_over_21.
            if (!isHub) {
              const key = 'age_' + ageBucket.replace(/-/g, '_');
              if ((Number(row[key]) || 0) === 0) return false;
            } else if (!matchesAgeBucket(row, ageBucket)) {
              return false; // hub fallback (legacy snapshot aging) until PR3 ETL
            }
          }
          if (accountTypeFilter !== 'all') {
            const at = String(row.account_type || '').trim().toUpperCase();
            const isNational = at.includes('NATIONAL');
            if (accountTypeFilter === 'national' && !isNational) return false;
            if (accountTypeFilter === 'standard' && isNational) return false;
          }
          if (hideInvoiceMatchesBalance && isInvoiceBalanceMatch(row)) return false;
          if (salesRepFilter !== 'all' && String(row.sales_rep || '').trim() !== salesRepFilter) return false;
          // "Haven't bought in N+ days" — uses the last invoice date.
          // Customers with no date on record fail the filter, since we
          // can't prove they've bought recently.
          if (lastPurchaseDays > 0) {
            const dt = parseBalanceDate(row.LastInvoiceDate ?? row.last_invoice_date ?? row.last_unpaid_invoice_1_date);
            if (!dt) return false;
            const days = Math.floor((today - dt) / 86400000);
            if (days < lastPurchaseDays) return false;
          }
          // Dormant — derived from analyseInvoiceCredit using the active
          // credit-logic config (same as the badge), so the filter matches
          // the verdict the row actually shows.
          if (dormantOnly) {
            try {
              const v = analyseInvoiceCredit([row], [], creditConfig()).verdict;
              if (v !== 'dormant') return false;
            } catch { return false; }
          }
          return true;
        });
        total = filtered.length;
        filteredTotalOutstanding = filtered.reduce((s, row) => s + parseAmount(row.outstanding_balance), 0);
        if (!isHub) aging = sumBuckets(filtered);
        const start = (page - 1) * limit;
        recordsForPage = filtered.slice(start, start + limit);
        console.log(`[balances-perf] ageBucket=${ageBucket} salesRep=${salesRepFilter} hideMatch=${hideInvoiceMatchesBalance} fetched=${allRecords.length} matched=${filtered.length} pageSize=${recordsForPage.length}`);
      } else {
        recordsForPage = allRecords;
        if (!isHub) aging = sumBuckets(allRecords);
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
        accountType: accountTypeFilter,
        aging,
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
  // GET /api/reports/trends/customer — site-mode mirror of /api/hub/trends.
  // Bucket per-week / per-month record count + flag rate over time. Same
  // shape as the hub endpoint so the React component can share its
  // chart/pivot logic across both installs.
  router.get('/api/reports/trends/customer', ...reportsGuard, (req, res) => {
    const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
    const sinceParam = req.query.since ? String(req.query.since) : null;
    if (sinceParam && !/^\d{4}-\d{2}-\d{2}$/.test(sinceParam)) {
      return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
    }
    const since = sinceParam || (() => {
      const d = new Date();
      if (period === 'monthly') d.setMonth(d.getMonth() - 6);
      else d.setDate(d.getDate() - 12 * 7);
      return d.toISOString().slice(0, 10);
    })();
    const bucketExpr = period === 'monthly'
      ? "strftime('%Y-%m', updated_date)"
      : "strftime('%Y-W%W', updated_date)";
    try {
      const rows = db.prepare(`
        SELECT
          ${bucketExpr} AS period,
          COUNT(*) AS total_records,
          SUM(CASE WHEN flag_color IS NOT NULL AND flag_color NOT IN ('', 'none') THEN 1 ELSE 0 END) AS flagged_records
        FROM datarecord
        WHERE updated_date >= ?
          AND ${bucketExpr} IS NOT NULL
        GROUP BY ${bucketExpr}
        ORDER BY ${bucketExpr} ASC
      `).all(since);

      res.json({
        period,
        since,
        site_name: SITE_NAME,
        data: rows.map((row) => ({
          period: row.period,
          site_name: SITE_NAME,
          total_records: row.total_records,
          flagged_records: row.flagged_records,
          flag_rate: row.total_records > 0
            ? Math.round((row.flagged_records / row.total_records) * 1000) / 10
            : 0,
        })),
      });
    } catch (err) {
      logError('reports.trends.customer', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/reports/trends/inventory — site-mode year-over-year inventory
  // trends from inventory_sales_cache (the site's own monthly rollup,
  // populated by inventoryMovement.syncInventorySales). One row per
  // (year, month). year_list is the distinct set of years present.
  router.get('/api/reports/trends/inventory', ...reportsGuard, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT
          CAST(substr(period, 1, 4) AS INTEGER) AS year,
          CAST(substr(period, 6, 2) AS INTEGER) AS month,
          SUM(qty_sold)    AS total_qty_sold,
          SUM(revenue)     AS total_revenue,
          SUM(order_count) AS total_orders,
          COUNT(DISTINCT item_number) AS distinct_items
        FROM inventory_sales_cache
        WHERE period IS NOT NULL
        GROUP BY substr(period, 1, 4), substr(period, 6, 2)
        ORDER BY year ASC, month ASC
      `).all();

      const yearList = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
      res.json({
        period: 'monthly',
        site_name: SITE_NAME,
        year_list: yearList,
        data: rows.map((row) => ({
          year: row.year,
          month: row.month,
          total_qty_sold: Number(row.total_qty_sold) || 0,
          total_revenue: Number(row.total_revenue) || 0,
          total_orders: Number(row.total_orders) || 0,
          distinct_items: Number(row.distinct_items) || 0,
        })),
      });
    } catch (err) {
      logError('reports.trends.inventory', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/reports/trends/inventory/seasonal — site-mode top-10 per SA season.
  router.get('/api/reports/trends/inventory/seasonal', ...reportsGuard, (_req, res) => {
    try {
      const seasonalCase = `
        CASE substr(sc.period, 6, 2)
          WHEN '12' THEN 'Summer' WHEN '01' THEN 'Summer' WHEN '02' THEN 'Summer'
          WHEN '03' THEN 'Autumn' WHEN '04' THEN 'Autumn' WHEN '05' THEN 'Autumn'
          WHEN '06' THEN 'Winter' WHEN '07' THEN 'Winter' WHEN '08' THEN 'Winter'
          WHEN '09' THEN 'Spring' WHEN '10' THEN 'Spring' WHEN '11' THEN 'Spring'
        END`;
      const rows = db.prepare(`
        WITH seasonal AS (
          SELECT ${seasonalCase} AS season,
                 sc.item_number,
                 SUM(sc.qty_sold)    AS qty_sold,
                 SUM(sc.revenue)     AS revenue,
                 SUM(sc.order_count) AS orders,
                 COUNT(DISTINCT sc.period) AS months_seen
          FROM inventory_sales_cache sc
          WHERE sc.period IS NOT NULL
          GROUP BY season, sc.item_number
        ),
        ranked AS (
          SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.season ORDER BY s.qty_sold DESC) AS rn
          FROM seasonal s WHERE s.season IS NOT NULL
        )
        SELECT r.season, r.rn AS rank, r.item_number,
               r.qty_sold, r.revenue, r.orders, r.months_seen,
               ir.item_description, ir.commodity
        FROM ranked r
        LEFT JOIN inventoryrecord ir ON TRIM(ir.item_number) = TRIM(r.item_number)
        WHERE r.rn <= 10
        ORDER BY CASE r.season WHEN 'Summer' THEN 1 WHEN 'Autumn' THEN 2 WHEN 'Winter' THEN 3 WHEN 'Spring' THEN 4 END, r.rn
      `).all();

      const buckets = { Summer: [], Autumn: [], Winter: [], Spring: [] };
      for (const row of rows) {
        if (!buckets[row.season]) continue;
        buckets[row.season].push({
          rank: row.rank,
          item_number: row.item_number,
          item_description: row.item_description || null,
          commodity: row.commodity || null,
          qty_sold: Number(row.qty_sold) || 0,
          revenue: Number(row.revenue) || 0,
          orders: Number(row.orders) || 0,
          months_seen: Number(row.months_seen) || 0,
        });
      }
      res.json({
        seasons: ['Summer', 'Autumn', 'Winter', 'Spring'],
        months: {
          Summer: ['Dec', 'Jan', 'Feb'],
          Autumn: ['Mar', 'Apr', 'May'],
          Winter: ['Jun', 'Jul', 'Aug'],
          Spring: ['Sep', 'Oct', 'Nov'],
        },
        site_name: SITE_NAME,
        data: buckets,
      });
    } catch (err) {
      logError('reports.trends.inventory.seasonal', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/reports/trends/inventory/revenue-by-commodity — site-mode
  // commodity revenue mix per period. Joins inventoryrecord to attach
  // a commodity to each item_number.
  router.get('/api/reports/trends/inventory/revenue-by-commodity', ...reportsGuard, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT sc.period AS period,
               COALESCE(NULLIF(TRIM(ir.commodity), ''), '(uncategorised)') AS commodity,
               SUM(sc.revenue)  AS revenue,
               SUM(sc.qty_sold) AS qty
        FROM inventory_sales_cache sc
        LEFT JOIN (
          SELECT item_number, commodity,
                 ROW_NUMBER() OVER (PARTITION BY item_number ORDER BY updated_date DESC) AS rn
          FROM inventoryrecord
        ) ir ON TRIM(ir.item_number) = TRIM(sc.item_number) AND ir.rn = 1
        WHERE sc.period IS NOT NULL
        GROUP BY sc.period, commodity
        ORDER BY sc.period ASC, commodity ASC
      `).all();
      const commodityList = [...new Set(rows.map(r => r.commodity))].sort();
      res.json({
        site_name: SITE_NAME,
        commodity_list: commodityList,
        data: rows.map(r => ({
          period: r.period,
          commodity: r.commodity,
          revenue: Number(r.revenue) || 0,
          qty: Number(r.qty) || 0,
        })),
      });
    } catch (err) {
      logError('reports.trends.inventory.revenue_by_commodity', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/reports/trends/inventory/dead-stock — site-mode trailing-24-month
  // dead-stock trend. Same shape as hub: per month, count of SKUs in
  // inventoryrecord whose most-recent sale is older than the month minus 3.
  // Restricted to SKUs with current inventory_value > 0 so the count and
  // value lines move together (see hub variant for rationale).
  router.get('/api/reports/trends/inventory/dead-stock', ...reportsGuard, (_req, res) => {
    try {
      const itemRows = db.prepare(`
        WITH last_sale AS (
          SELECT TRIM(item_number) AS item_number, MAX(period) AS last_period
          FROM inventory_sales_cache
          WHERE period IS NOT NULL
          GROUP BY TRIM(item_number)
        )
        SELECT TRIM(ir.item_number) AS item_number,
               COALESCE(CAST(REPLACE(REPLACE(ir.inventory_value, ',', ''), ' ', '') AS REAL), 0) AS inv_value,
               ls.last_period
        FROM inventoryrecord ir
        LEFT JOIN last_sale ls ON ls.item_number = TRIM(ir.item_number)
        WHERE COALESCE(CAST(REPLACE(REPLACE(ir.inventory_value, ',', ''), ' ', '') AS REAL), 0) > 0
      `).all();

      const months = [];
      const now = new Date();
      for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }

      const data = months.map(m => {
        const [yy, mm] = m.split('-').map(Number);
        const t = new Date(yy, mm - 1 - 3, 1);
        const threshold = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
        let count = 0;
        let value = 0;
        for (const r of itemRows) {
          if (!r.last_period || r.last_period < threshold) {
            count++;
            value += r.inv_value || 0;
          }
        }
        return { month: m, dead_count: count, dead_value: value };
      });

      res.json({
        site_name: SITE_NAME,
        total_skus: itemRows.length,
        threshold_months: 3,
        data,
      });
    } catch (err) {
      logError('reports.trends.inventory.dead_stock', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Reporting Dashboard mini-tiles (compact top-10 lists) ─────────────────
  // Smaller versions of the Trends inventory graphs for the dashboard. Site-mode
  // (the inventory sales cache + transactions live on sites); HUB_MODE returns
  // an empty, site_only payload the tiles surface as a note.
  const dashMonth = (n = 0) => { const d = new Date(); const t = new Date(d.getFullYear(), d.getMonth() - n, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
  // Inter-branch stock transfers aren't real customer sales — exclude them from
  // every dashboard sales figure (matched on customer name, separator-agnostic).
  // Hard-coded fragment (no user input) referencing the unqualified customer_name.
  const EXCL_INTER_BRANCH = "(LOWER(COALESCE(customer_name,'')) LIKE '%inter branch%' OR LOWER(COALESCE(customer_name,'')) LIKE '%inter-branch%' OR LOWER(COALESCE(customer_name,'')) LIKE '%interbranch%')";

  // Top 10 items sold this month (by units), from the monthly sales cache.
  router.get('/api/reports/dashboard/top-items-mtd', ...reportsGuard, (req, res) => {
    try {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      if (process.env.HUB_MODE === 'true') {
        const siteFilter = String(req.query.site || 'all').trim();
        const where = siteFilter !== 'all' ? 'AND COALESCE(hs.name, t.site_id) = ?' : '';
        const params = siteFilter !== 'all' ? [siteFilter] : [];
        const sites = db.prepare(`SELECT DISTINCT COALESCE(hs.name, t.site_id) AS site_name FROM hub_inventory_item_sales t LEFT JOIN hub_sites hs ON hs.id = t.site_id ORDER BY site_name`).all().map((r) => r.site_name).filter(Boolean);
        const rows = db.prepare(`
          SELECT TRIM(t.item_number) AS item_number, SUM(t.qty_sold) AS qty, SUM(t.revenue) AS revenue, MAX(t.item_description) AS item_description
          FROM hub_inventory_item_sales t LEFT JOIN hub_sites hs ON hs.id = t.site_id
          WHERE t.period = ? ${where}
          GROUP BY TRIM(t.item_number)
          ORDER BY qty DESC
          LIMIT 10
        `).all(month, ...params).map((r) => ({
          item_number: r.item_number,
          item_description: r.item_description || null,
          qty: Number(r.qty) || 0,
          revenue: Number(r.revenue) || 0,
        }));
        return res.json({ month, rows, hub_mode: true, filters: { sites } });
      }
      const from = `${month}-01`;
      const to = `${month}-${String(now.getDate()).padStart(2, '0')}`;
      const rows = db.prepare(`
        SELECT TRIM(t.item_number) AS item_number, SUM(t.qty_sold) AS qty, SUM(t.line_amount) AS revenue,
               COALESCE(MAX(ic.item_description), MAX(ir.item_description)) AS item_description
        FROM inventory_sales_transactions t
        LEFT JOIN (
          SELECT TRIM(item_number) AS item_number, MAX(item_description) AS item_description
          FROM inventory_sales_cache
          WHERE item_description IS NOT NULL AND TRIM(item_description) <> ''
          GROUP BY TRIM(item_number)
        ) ic ON ic.item_number = TRIM(t.item_number)
        LEFT JOIN (
          SELECT item_number, item_description, ROW_NUMBER() OVER (PARTITION BY item_number ORDER BY updated_date DESC) AS rn
          FROM inventoryrecord
        ) ir ON TRIM(ir.item_number) = TRIM(t.item_number) AND ir.rn = 1
        WHERE t.transaction_date >= ? AND t.transaction_date <= ?
          AND NOT ${EXCL_INTER_BRANCH}
        GROUP BY TRIM(t.item_number)
        ORDER BY qty DESC
        LIMIT 10
      `).all(from, to).map((r) => ({
        item_number: r.item_number,
        item_description: r.item_description || null,
        qty: Number(r.qty) || 0,
        revenue: Number(r.revenue) || 0,
      }));
      res.json({ month, rows });
    } catch (err) {
      logError('reports.dashboard.top_items_mtd', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Top 10 dead-stock items (held value, no sale in 3+ months) by held value.
  router.get('/api/reports/dashboard/dead-stock-items', ...reportsGuard, (req, res) => {
    try {
      const threshold = dashMonth(3);
      if (process.env.HUB_MODE === 'true') {
        const siteFilter = String(req.query.site || 'all').trim();
        const where = siteFilter !== 'all' ? 'AND COALESCE(hs.name, i.site_id) = ?' : '';
        const params = siteFilter !== 'all' ? [siteFilter] : [];
        const sites = db.prepare(`SELECT DISTINCT COALESCE(hs.name, i.site_id) AS site_name FROM hub_inventory i LEFT JOIN hub_sites hs ON hs.id = i.site_id ORDER BY site_name`).all().map((r) => r.site_name).filter(Boolean);
        const rows = db.prepare(`
          WITH last_sale AS (
            SELECT site_id, TRIM(item_number) AS item_number, MAX(period) AS last_period
            FROM hub_inventory_item_sales GROUP BY site_id, TRIM(item_number)
          )
          SELECT TRIM(i.item_number) AS item_number, i.item_description,
                 COALESCE(CAST(REPLACE(REPLACE(i.inventory_value, ',', ''), ' ', '') AS REAL), 0) AS inv_value,
                 ls.last_period,
                 COALESCE(hs.name, i.site_id) AS site_name
          FROM hub_inventory i
          LEFT JOIN hub_sites hs ON hs.id = i.site_id
          LEFT JOIN last_sale ls ON ls.site_id = i.site_id AND ls.item_number = TRIM(i.item_number)
          WHERE COALESCE(CAST(REPLACE(REPLACE(i.inventory_value, ',', ''), ' ', '') AS REAL), 0) > 0
            AND (ls.last_period IS NULL OR ls.last_period < ?) ${where}
          ORDER BY inv_value DESC
          LIMIT 10
        `).all(threshold, ...params).map((r) => ({
          item_number: r.item_number,
          item_description: r.item_description || null,
          inv_value: Number(r.inv_value) || 0,
          last_period: r.last_period || null,
          site_name: r.site_name || null,
        }));
        return res.json({ threshold_months: 3, rows, hub_mode: true, filters: { sites } });
      }
      const rows = db.prepare(`
        WITH last_sale AS (
          SELECT TRIM(item_number) AS item_number, MAX(SUBSTR(transaction_date, 1, 7)) AS last_period
          FROM inventory_sales_transactions
          WHERE transaction_date IS NOT NULL AND NOT ${EXCL_INTER_BRANCH}
          GROUP BY TRIM(item_number)
        )
        SELECT TRIM(ir.item_number) AS item_number, ir.item_description,
               COALESCE(CAST(REPLACE(REPLACE(ir.inventory_value, ',', ''), ' ', '') AS REAL), 0) AS inv_value,
               ls.last_period
        FROM inventoryrecord ir
        LEFT JOIN last_sale ls ON ls.item_number = TRIM(ir.item_number)
        WHERE COALESCE(CAST(REPLACE(REPLACE(ir.inventory_value, ',', ''), ' ', '') AS REAL), 0) > 0
          AND (ls.last_period IS NULL OR ls.last_period < ?)
        ORDER BY inv_value DESC
        LIMIT 10
      `).all(threshold).map((r) => ({
        item_number: r.item_number,
        item_description: r.item_description || null,
        inv_value: Number(r.inv_value) || 0,
        last_period: r.last_period || null,
      }));
      res.json({ threshold_months: 3, rows });
    } catch (err) {
      logError('reports.dashboard.dead_stock_items', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Top 10 customers by sales value, from the per-transaction sales table.
  router.get('/api/reports/dashboard/top-customers', ...reportsGuard, (req, res) => {
    try {
      const months = Math.max(0, parseInt(req.query.months, 10) || 12); // default last 12 months; 0 = all time
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 10));
      if (process.env.HUB_MODE === 'true') {
        const siteFilter = String(req.query.site || 'all').trim();
        const siteWhere = siteFilter !== 'all' ? 'AND COALESCE(hs.name, c.site_id) = ?' : '';
        const hubConds = ["c.customer_code IS NOT NULL AND TRIM(c.customer_code) <> ''"];
        const hubParams = [];
        if (months > 0) {
          const d = new Date(); const ft = new Date(d.getFullYear(), d.getMonth() - (months - 1), 1);
          hubConds.push('c.period >= ?'); hubParams.push(`${ft.getFullYear()}-${String(ft.getMonth() + 1).padStart(2, '0')}`);
        }
        const sites = db.prepare(`SELECT DISTINCT COALESCE(hs.name, c.site_id) AS site_name FROM hub_inventory_customer_sales c LEFT JOIN hub_sites hs ON hs.id = c.site_id ORDER BY site_name`).all().map((r) => r.site_name).filter(Boolean);
        const rows = db.prepare(`
          SELECT TRIM(c.customer_code) AS customer_code, MAX(c.customer_name) AS customer_name,
                 SUM(c.revenue) AS revenue, SUM(c.qty) AS qty
          FROM hub_inventory_customer_sales c LEFT JOIN hub_sites hs ON hs.id = c.site_id
          WHERE ${hubConds.join(' AND ')} ${siteWhere}
          GROUP BY TRIM(c.customer_code)
          ORDER BY revenue DESC
          LIMIT ?
        `).all(...hubParams, ...(siteFilter !== 'all' ? [siteFilter] : []), limit).map((r) => ({
          customer_code: r.customer_code,
          customer_name: r.customer_name || null,
          revenue: Number(r.revenue) || 0,
          qty: Number(r.qty) || 0,
        }));
        return res.json({ months, rows, hub_mode: true, filters: { sites } });
      }
      const where = ["customer_code IS NOT NULL AND TRIM(customer_code) <> ''", `NOT ${EXCL_INTER_BRANCH}`];
      const params = [];
      if (months > 0) {
        const d = new Date();
        const t = new Date(d.getFullYear(), d.getMonth() - (months - 1), 1);
        where.push('transaction_date >= ?');
        params.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`);
      }
      const rows = db.prepare(`
        SELECT TRIM(customer_code) AS customer_code, MAX(customer_name) AS customer_name,
               SUM(line_amount) AS revenue, SUM(qty_sold) AS qty
        FROM inventory_sales_transactions
        WHERE ${where.join(' AND ')}
        GROUP BY TRIM(customer_code)
        ORDER BY revenue DESC
        LIMIT ?
      `).all(...params, limit).map((r) => ({
        customer_code: r.customer_code,
        customer_name: r.customer_name || null,
        revenue: Number(r.revenue) || 0,
        qty: Number(r.qty) || 0,
      }));
      res.json({ months, rows });
    } catch (err) {
      logError('reports.dashboard.top_customers', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/reports/trends/inventory/top-movers — site-mode top-10 SKUs by
  // lifetime revenue with last-12-months vs prior-12-months delta.
  router.get('/api/reports/trends/inventory/top-movers', ...reportsGuard, (_req, res) => {
    try {
      const now = new Date();
      const twelve = new Date(now.getFullYear(), now.getMonth() - 12, 1);
      const twentyfour = new Date(now.getFullYear(), now.getMonth() - 24, 1);
      const twelveStr = `${twelve.getFullYear()}-${String(twelve.getMonth() + 1).padStart(2, '0')}`;
      const twentyfourStr = `${twentyfour.getFullYear()}-${String(twentyfour.getMonth() + 1).padStart(2, '0')}`;

      const rows = db.prepare(`
        WITH agg AS (
          SELECT sc.item_number,
                 SUM(sc.revenue)     AS total_revenue,
                 SUM(sc.qty_sold)    AS total_qty,
                 SUM(sc.order_count) AS total_orders,
                 SUM(CASE WHEN sc.period >= ? THEN sc.qty_sold ELSE 0 END) AS this_year_qty,
                 SUM(CASE WHEN sc.period >= ? THEN sc.revenue  ELSE 0 END) AS this_year_revenue,
                 SUM(CASE WHEN sc.period >= ? AND sc.period < ? THEN sc.qty_sold ELSE 0 END) AS prior_year_qty,
                 SUM(CASE WHEN sc.period >= ? AND sc.period < ? THEN sc.revenue  ELSE 0 END) AS prior_year_revenue
          FROM inventory_sales_cache sc
          WHERE sc.period IS NOT NULL
          GROUP BY sc.item_number
        ),
        ranked AS (
          SELECT a.*, ROW_NUMBER() OVER (ORDER BY a.total_revenue DESC) AS rn
          FROM agg a
        )
        SELECT r.rn AS rank, r.item_number,
               r.total_revenue, r.total_qty, r.total_orders,
               r.this_year_qty, r.this_year_revenue,
               r.prior_year_qty, r.prior_year_revenue,
               ir.item_description, ir.commodity
        FROM ranked r
        LEFT JOIN (
          SELECT item_number, item_description, commodity,
                 ROW_NUMBER() OVER (PARTITION BY item_number ORDER BY updated_date DESC) AS rn
          FROM inventoryrecord
        ) ir ON TRIM(ir.item_number) = TRIM(r.item_number) AND ir.rn = 1
        WHERE r.rn <= 10
        ORDER BY r.rn ASC
      `).all(twelveStr, twelveStr, twentyfourStr, twelveStr, twentyfourStr, twelveStr);

      res.json({
        site_name: SITE_NAME,
        this_year_from: twelveStr,
        prior_year_from: twentyfourStr,
        data: rows.map(r => {
          const tyQ = Number(r.this_year_qty) || 0;
          const pyQ = Number(r.prior_year_qty) || 0;
          const tyR = Number(r.this_year_revenue) || 0;
          const pyR = Number(r.prior_year_revenue) || 0;
          return {
            rank: r.rank,
            item_number: r.item_number,
            item_description: r.item_description || null,
            commodity: r.commodity || null,
            total_revenue: Number(r.total_revenue) || 0,
            total_qty: Number(r.total_qty) || 0,
            total_orders: Number(r.total_orders) || 0,
            this_year_qty: tyQ,
            this_year_revenue: tyR,
            prior_year_qty: pyQ,
            prior_year_revenue: pyR,
            qty_delta_pct: pyQ > 0 ? Math.round(((tyQ - pyQ) / pyQ) * 1000) / 10 : null,
            revenue_delta_pct: pyR > 0 ? Math.round(((tyR - pyR) / pyR) * 1000) / 10 : null,
          };
        }),
      });
    } catch (err) {
      logError('reports.trends.inventory.top_movers', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Build the full aged-debtors report object. Extracted from the route
  // handler so both the JSON endpoint and the PDF/Excel export endpoint
  // share one query + aging implementation (no drift between screen and
  // download). Throws on DB error; callers wrap in try/catch.
  function buildAgedDebtorsReport(query) {
    const isHub = process.env.HUB_MODE === 'true';
    const minBalance = Math.max(0, parseFloat(query.min_balance) || CUSTOMER_BALANCES_MIN_AMOUNT);
    const salesRepFilter = String(query.sales_rep || 'all').trim();
    const accountTypeFilter = String(query.account_type || 'all').trim();
    const siteFilter = String(query.site || 'all').trim();

    // Open AR documents (synced from Sage AROBL by services/debtorSync.js),
    // joined back to the customer master for name / rep / type / terms. Unlike
    // the old per-customer snapshot, each row is a single open document with a
    // real due date and outstanding amount, so we can age it the Sage way.
    let rows;
    let sites = [];
    // Whether the AR open-item ledger has been synced for this scope — read from
    // the sync markers, NOT row count, so a synced-but-fully-paid site reads as
    // "ready, nothing outstanding" instead of triggering the "no data yet"
    // warning (which is for sites that have never run the AR sync).
    let ledgerReady = false;
    if (isHub) {
      // Per-site ledger/snapshot decision (SYNC-5) is extracted so it can be
      // unit-tested against a seeded mixed-site DB. Each site is sourced from its
      // own best data: open-item ledger if its AR ETL has landed, hub_records
      // snapshot otherwise — a not-yet-synced site no longer vanishes.
      ({ rows, sites, ledgerReady } = acquireHubAgedDebtorRows(prep, siteFilter));
    } else {
      sites = [SITE_NAME];
      ledgerReady = !!prep('SELECT last_synced_at FROM debtor_sync_meta WHERE id = 1').get()?.last_synced_at;
      rows = prep(
        `SELECT i.customer_code, i.reporting_account, i.document_number, i.document_type, i.document_date, i.due_date,
                i.outstanding_amount, i.reference,
                d.customer_name, d.sales_rep, d.account_type, d.terms, d.data, d.local_fields,
                ? AS site_name
         FROM debtor_ar_invoice i
         LEFT JOIN datarecord d ON TRIM(d.customer_number) = TRIM(i.reporting_account)
         WHERE i.source_table = 'AROBL' AND i.outstanding_amount <> 0`
      ).all(SITE_NAME).map(hydrateSalesRepAndAccountType);

      // Fallback: the AR sync has NEVER run for this site (no debtor_sync_meta
      // marker → ledgerReady false), so debtor_ar_invoice is empty. Rather than
      // show all-zero aging tiles while Customer Balances still shows a real
      // outstanding total, age the per-customer snapshot (datarecord) by its
      // OLDEST unpaid invoice — one pseudo-document per customer. A synced-but-
      // paid site (ledgerReady) shows nothing, correctly. ledger_empty still flags
      // !ledgerReady below, so the UI nudges the operator to run the sync; this
      // self-heals to per-document AR aging on the first debtors sync.
      if (!ledgerReady) {
        rows = prep(
          `SELECT TRIM(customer_number) AS customer_code, TRIM(customer_number) AS reporting_account,
                  customer_name, sales_rep, account_type, terms, outstanding_balance_num, unpaid_invoices,
                  data, local_fields, ? AS site_name
           FROM datarecord
           WHERE outstanding_balance_num IS NOT NULL AND outstanding_balance_num <> 0`
        ).all(SITE_NAME).map(hydrateSalesRepAndAccountType).map((r) => {
          // Oldest dated unpaid line — the snapshot array isn't guaranteed
          // oldest-first; null when absent → the engine's "unknown" bucket.
          const inv = parseJsonSafely(r.unpaid_invoices, []);
          let oldestDate = null, oldestT = Infinity;
          if (Array.isArray(inv)) {
            for (const it of inv) {
              const raw = it?.date;
              if (!raw) continue;
              const t = Date.parse(raw);
              if (!Number.isNaN(t) && t < oldestT) { oldestT = t; oldestDate = raw; }
            }
          }
          return {
            ...r,
            document_number: r.customer_code,
            document_type: '',
            document_date: oldestDate,
            due_date: oldestDate,
            outstanding_amount: r.outstanding_balance_num,
            reference: '',
          };
        });
      }
    }


    // Age + join on the REPORTING account (national account for a member, else
    // the customer's own code) so national-account child invoices roll up under
    // the parent and inherit its name/rep/type — matching Customer Balances.
    const repOf = (r) => String(r.reporting_account || r.customer_code || '').trim();
    const keyOf = isHub
      ? (r) => JSON.stringify([r.site_id, repOf(r)])
      : (r) => repOf(r);

    // Customer metadata the engine doesn't carry, keyed by the same composite.
    const meta = new Map();
    const docs = rows.map((r) => {
      const key = keyOf(r);
      if (!meta.has(key)) meta.set(key, {
        customer_code: repOf(r),
        customer_name: r.customer_name || null,
        sales_rep: r.sales_rep || null,
        account_type: r.account_type || null,
        terms: r.terms || null,
        site_name: r.site_name || SITE_NAME,
      });
      return {
        entityCode: key,
        entityName: r.customer_name || null,
        date: r.document_date,
        dueDate: r.due_date,
        outstanding: r.outstanding_amount,
        documentNumber: r.document_number,
        documentType: r.document_type,
        reference: r.reference,
      };
    });

    const aged = ageOpenItems(docs); // document-date basis + Sage buckets (defaults)

    const allRecords = aged.entities.map((e) => {
      const m = meta.get(e.entityCode) || {};
      return {
        customer_number: m.customer_code || e.entityCode,
        customer_name: e.entityName || m.customer_name || '',
        sales_rep: m.sales_rep || '',
        account_type: m.account_type || '',
        terms: m.terms || '',
        site_name: m.site_name || SITE_NAME,
        parsed_balance: e.total,
        bucket: e.primary_bucket,
        age_days: e.oldest_age_days,
        bucket_amounts: e.bucket_amounts,
        doc_count: e.documents.length,
      };
    });

    // Filter dropdown options built from the full (pre-filter) set so the user
    // can always switch back.
    const salesReps = Array.from(new Set(allRecords.map(r => String(r.sales_rep || '').trim()).filter(Boolean))).sort();
    const accountTypes = Array.from(new Set(allRecords.map(r => String(r.account_type || '').trim().toUpperCase()).filter(Boolean))).sort();

    const records = allRecords
      .filter((r) => {
        if (Math.abs(r.parsed_balance) < minBalance) return false;
        if (salesRepFilter !== 'all' && String(r.sales_rep || '').trim() !== salesRepFilter) return false;
        if (accountTypeFilter !== 'all' && String(r.account_type || '').trim().toUpperCase() !== accountTypeFilter.toUpperCase()) return false;
        return true;
      })
      .sort((a, b) => Math.abs(b.parsed_balance) - Math.abs(a.parsed_balance));

    // Summary recomputed over the filtered set so totals match the rows shown.
    const bucketKeys = BUCKET_KEYS;
    const buckets = Object.fromEntries(bucketKeys.map(k => [k, 0]));
    const bucketCounts = Object.fromEntries(bucketKeys.map(k => [k, 0]));
    let totalOutstanding = 0;
    for (const r of records) {
      totalOutstanding += r.parsed_balance;
      for (const k of bucketKeys) {
        buckets[k] += r.bucket_amounts[k] || 0;
        if ((r.bucket_amounts[k] || 0) !== 0) bucketCounts[k] += 1;
      }
    }

    return {
      records,
      summary: {
        total_customers: records.length,
        total_outstanding: totalOutstanding,
        buckets,
        bucket_counts: bucketCounts,
      },
      filters: { sites, sales_reps: salesReps, account_types: accountTypes },
      // True when the AR open-item sync has NOT run for this scope (no markers) —
      // lets the UI tell "nothing outstanding" (synced + paid up) apart from "no
      // data yet" (never synced). Keyed on the sync markers, not row count, so a
      // fully-paid synced branch no longer shows the "no AR data yet" warning.
      ledger_empty: !ledgerReady,
      generated_at: new Date().toISOString(),
      site_name: SITE_NAME,
      hub_mode: isHub,
      min_balance: minBalance,
    };
  }

  router.get('/api/reports/aged-debtors', ...reportsGuard, (req, res) => {
    try {
      res.json(buildAgedDebtorsReport(req.query));
    } catch (err) {
      console.error('[reporting] aged-debtors error:', err);
      res.status(500).json({ error: 'Failed to fetch aged debtors' });
    }
  });

  // GET /api/reports/aged-debtors/export?format=pdf|xlsx
  router.get('/api/reports/aged-debtors/export', ...reportsGuard, async (req, res) => {
    const format = String(req.query.format || 'pdf').toLowerCase();
    try {
      const report = buildAgedDebtorsReport(req.query);
      const { buildAgedDebtorsPdf, buildAgedDebtorsXlsx } = await import('../services/reporting/reportExports.js');
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'xlsx') {
        const buf = await buildAgedDebtorsXlsx(report);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="aged-debtors-${stamp}.xlsx"`);
        return res.send(buf);
      }
      const buf = buildAgedDebtorsPdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="aged-debtors-${stamp}.pdf"`);
      return res.send(buf);
    } catch (err) {
      console.error('[reporting] aged-debtors export error:', err);
      res.status(500).json({ error: 'Failed to export aged debtors' });
    }
  });

  // Build the full aged-creditors (AP) report object. Mirrors
  // buildAgedDebtorsReport, but over the open-item ledger the Creditors module
  // already syncs from Sage APOBL (creditor_ap_invoice), which — unlike the
  // debtor snapshot — has a per-document due date and outstanding amount, so we
  // can age it the Sage way: each document into its own bucket by due date.
  // Shared by the JSON endpoint and the PDF/Excel export so screen and download
  // never diverge. Throws on DB error; callers wrap in try/catch.
  function buildAgedCreditorsReport(query) {
    const isHub = process.env.HUB_MODE === 'true';
    const minBalance = Math.max(0, parseFloat(query.min_balance) || 0);
    const siteFilter = String(query.site || 'all').trim();
    // "Has payment history" — exclude vendors that have never been paid
    // (blank last_payment_date), matching the Creditor Balances toggle.
    const paidOnly = String(query.paid_only).toLowerCase() === 'true';

    let rows;
    let sites = [];
    if (isHub) {
      const params = [];
      let whereSite = '';
      if (siteFilter !== 'all') { whereSite = 'AND COALESCE(s.name, i.site_id) = ?'; params.push(siteFilter); }
      sites = prep(
        `SELECT DISTINCT COALESCE(s.name, i.site_id) AS site_name
         FROM hub_creditor_ap_invoice i LEFT JOIN hub_sites s ON s.id = i.site_id
         WHERE i.outstanding_amount <> 0 ORDER BY site_name`
      ).all().map(r => r.site_name).filter(Boolean);
      rows = prep(
        `SELECT i.site_id, i.vendor_code, i.document_number, i.document_type, i.document_date, i.due_date,
                i.outstanding_amount, i.reference, c.vendor_name, c.terms, c.last_payment_date,
                COALESCE(s.name, i.site_id) AS site_name
         FROM hub_creditor_ap_invoice i
         LEFT JOIN hub_creditor c ON c.site_id = i.site_id AND c.vendor_code = i.vendor_code
         LEFT JOIN hub_sites s ON s.id = i.site_id
         WHERE i.outstanding_amount <> 0 ${whereSite}`
      ).all(...params);
    } else {
      sites = [SITE_NAME];
      rows = prep(
        `SELECT i.vendor_code, i.document_number, i.document_type, i.document_date, i.due_date,
                i.outstanding_amount, i.reference, c.vendor_name, c.terms, c.last_payment_date,
                ? AS site_name
         FROM creditor_ap_invoice i
         LEFT JOIN creditor c ON c.vendor_code = i.vendor_code
         WHERE i.source_table = 'APOBL' AND i.outstanding_amount <> 0`
      ).all(SITE_NAME);
    }

    // Aging entity key. In hub all-sites mode the same vendor_code can exist at
    // multiple sites as distinct AP accounts (the hub ledger is keyed by
    // site_id + vendor_code), so the key must include the site — otherwise
    // different sites' vendors merge into one row and the all-sites totals,
    // vendor count and site attribution are all wrong. Site mode keys by code.
    const keyOf = isHub
      ? (r) => JSON.stringify([r.site_id, String(r.vendor_code || '').trim()])
      : (r) => String(r.vendor_code || '').trim();

    // Per-(site,vendor) metadata (code/name/terms/site) the engine doesn't
    // carry, keyed by the same composite as the aging entity.
    const meta = new Map();
    const docs = rows.map((r) => {
      const key = keyOf(r);
      if (!meta.has(key)) meta.set(key, { vendor_code: String(r.vendor_code || '').trim(), vendor_name: r.vendor_name || null, terms: r.terms || null, site_name: r.site_name || SITE_NAME, last_payment_date: r.last_payment_date || null });
      return {
        entityCode: key,
        entityName: r.vendor_name || null,
        date: r.document_date,
        dueDate: r.due_date,
        outstanding: r.outstanding_amount,
        documentNumber: r.document_number,
        documentType: r.document_type,
        reference: r.reference,
      };
    });

    const aged = ageOpenItems(docs, { scheme: AP_SCHEME }); // AP: due date + monthly periods

    const records = aged.entities
      .filter((e) => {
        if (Math.abs(e.total) < minBalance) return false;
        if (paidOnly) {
          const m = meta.get(e.entityCode) || {};
          if (!m.last_payment_date || !String(m.last_payment_date).trim()) return false;
        }
        return true;
      })
      .map((e) => {
        const m = meta.get(e.entityCode) || {};
        return {
          vendor_code: m.vendor_code || e.entityCode,
          vendor_name: e.entityName || m.vendor_name || '',
          terms: m.terms || '',
          site_name: m.site_name || SITE_NAME,
          parsed_balance: e.total,
          bucket: e.primary_bucket,
          age_days: e.oldest_age_days,
          bucket_amounts: e.bucket_amounts,
          doc_count: e.documents.length,
        };
      })
      .sort((a, b) => Math.abs(b.parsed_balance) - Math.abs(a.parsed_balance));

    // Recompute summary over the filtered set so totals match the rows shown.
    const bucketKeys = AP_SCHEME.keys;
    const buckets = Object.fromEntries(bucketKeys.map(k => [k, 0]));
    const bucketCounts = Object.fromEntries(bucketKeys.map(k => [k, 0]));
    let totalOutstanding = 0;
    for (const r of records) {
      totalOutstanding += r.parsed_balance;
      for (const k of bucketKeys) {
        buckets[k] += r.bucket_amounts[k] || 0;
        if ((r.bucket_amounts[k] || 0) !== 0) bucketCounts[k] += 1;
      }
    }

    return {
      records,
      summary: {
        total_vendors: records.length,
        total_outstanding: totalOutstanding,
        buckets,
        bucket_counts: bucketCounts,
      },
      filters: { sites },
      generated_at: new Date().toISOString(),
      site_name: SITE_NAME,
      hub_mode: isHub,
      min_balance: minBalance,
    };
  }

  router.get('/api/reports/aged-creditors', ...creditorsGuard, (req, res) => {
    try {
      res.json(buildAgedCreditorsReport(req.query));
    } catch (err) {
      console.error('[reporting] aged-creditors error:', err);
      res.status(500).json({ error: 'Failed to fetch aged creditors' });
    }
  });

  // GET /api/reports/aged-creditors/export?format=pdf|xlsx
  router.get('/api/reports/aged-creditors/export', ...creditorsGuard, async (req, res) => {
    const format = String(req.query.format || 'pdf').toLowerCase();
    try {
      const report = buildAgedCreditorsReport(req.query);
      const { buildAgedCreditorsPdf, buildAgedCreditorsXlsx } = await import('../services/reporting/reportExports.js');
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'xlsx') {
        const buf = await buildAgedCreditorsXlsx(report);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="aged-creditors-${stamp}.xlsx"`);
        return res.send(buf);
      }
      const buf = buildAgedCreditorsPdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="aged-creditors-${stamp}.pdf"`);
      return res.send(buf);
    } catch (err) {
      console.error('[reporting] aged-creditors export error:', err);
      res.status(500).json({ error: 'Failed to export aged creditors' });
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
  // Build the rep-exposure report object. Shared by the JSON endpoint and
  // the PDF/Excel export so screen and download never diverge.
  // Hub branch filter: from rows that each carry a `site_name`, return the
  // distinct branch list (dropdown options) and the rows narrowed to the chosen
  // branch. siteFilter 'all' (or site mode) = consolidated across all branches.
  function applyBranchFilter(rows, isHub, siteFilter) {
    if (!isHub) return { sites: [], filtered: rows };
    const sites = Array.from(new Set(rows.map((r) => String(r.site_name || '').trim()).filter(Boolean))).sort();
    const filtered = siteFilter && siteFilter !== 'all'
      ? rows.filter((r) => String(r.site_name || '').trim() === siteFilter)
      : rows;
    return { sites, filtered };
  }

  function buildRepExposureReport(query) {
    const isHub = process.env.HUB_MODE === 'true';
    const minBalance = Math.max(0, parseFloat(query.min_balance) || CUSTOMER_BALANCES_MIN_AMOUNT);
    const siteFilter = String(query.site || 'all').trim();
    {
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
      const branch = applyBranchFilter(records, isHub, siteFilter);
      records = branch.filtered;
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

      return {
        reps, summary, generated_at: new Date().toISOString(),
        site_name: isHub ? (siteFilter !== 'all' ? siteFilter : 'All branches') : SITE_NAME,
        min_balance: minBalance,
        hub_mode: isHub,
        filters: { sites: branch.sites },
      };
    }
  }

  router.get('/api/reports/rep-exposure', ...reportsGuard, (req, res) => {
    try {
      res.json(buildRepExposureReport(req.query));
    } catch (err) {
      console.error('[reporting] rep-exposure error:', err);
      res.status(500).json({ error: 'Failed to fetch rep exposure' });
    }
  });

  // GET /api/reports/rep-exposure/export?format=pdf|xlsx
  router.get('/api/reports/rep-exposure/export', ...reportsGuard, async (req, res) => {
    const format = String(req.query.format || 'pdf').toLowerCase();
    try {
      const report = buildRepExposureReport(req.query);
      const { buildRepExposurePdf, buildRepExposureXlsx } = await import('../services/reporting/reportExports.js');
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'xlsx') {
        const buf = await buildRepExposureXlsx(report);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="rep-exposure-${stamp}.xlsx"`);
        return res.send(buf);
      }
      const buf = buildRepExposurePdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="rep-exposure-${stamp}.pdf"`);
      return res.send(buf);
    } catch (err) {
      console.error('[reporting] rep-exposure export error:', err);
      res.status(500).json({ error: 'Failed to export rep exposure' });
    }
  });

  // GET /api/reports/bat-weekly?year=YYYY — per-week BAT vs Sage credit-note
  // totals + variance + extraction stats, suitable for printing as a one-pager.
  router.get('/api/reports/bat-weekly', ...reportsGuard, (req, res) => {
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    try {
      // BAT reconciliation is a per-branch operational process — there is no hub
      // BAT data to consolidate. Flag it so the hub shows a "site only" note.
      if (process.env.HUB_MODE === 'true') {
        return res.json({ hub_unavailable: true, weeks: [], summary: null, year, available_years: [], generated_at: new Date().toISOString() });
      }
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
  router.get('/api/reports/bat-ytd', ...reportsGuard, (req, res) => {
    // ISO year fallback so a late-Dec call without ?year= matches the
    // ISO year that bat_reconciliations is keyed on.
    const year = req.query.year ? parseInt(req.query.year, 10) : isoYear(new Date());
    try {
      if (process.env.HUB_MODE === 'true') {
        return res.json({ hub_unavailable: true, year, fees: [], summary: null, available_years: [], generated_at: new Date().toISOString() });
      }
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
  router.get('/api/reports/bat-exceptions', ...reportsGuard, (req, res) => {
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    try {
      if (process.env.HUB_MODE === 'true') {
        return res.json({ hub_unavailable: true, year, summary: null, by_reason: [], by_store: [], available_years: [], generated_at: new Date().toISOString() });
      }
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
      // Hub branch filter (matched on the branch's display name): narrow to one
      // branch, or consolidate across all when 'all'. valueExprI/qtyExprI are the
      // same value/qty expressions qualified for the joined hub_inventory (alias i).
      const siteFilter = String(req.query.site || 'all').trim();
      const valueExprI = valueExpr.replace(/\binventory_value\b/g, 'i.inventory_value').replace(/\bqty_on_hand\b/g, 'i.qty_on_hand').replace(/\blast_cost\b/g, 'i.last_cost');
      const qtyExprI = qtyExpr.replace(/\bqty_on_hand\b/g, 'i.qty_on_hand');
      const hubSiteWhere = siteFilter !== 'all' ? 'WHERE COALESCE(s.name, i.site_id) = ?' : '';
      const hubSiteParams = siteFilter !== 'all' ? [siteFilter] : [];
      const commoditySql = isHub
        ? `SELECT
             COALESCE(NULLIF(TRIM(i.commodity), ''), '— Uncategorised') AS commodity,
             COUNT(*)         AS item_count,
             SUM(${valueExprI}) AS total_value,
             SUM(${qtyExprI})   AS total_qty
           FROM hub_inventory i LEFT JOIN hub_sites s ON s.id = i.site_id
           ${hubSiteWhere}
           GROUP BY COALESCE(NULLIF(TRIM(i.commodity), ''), '— Uncategorised')
           ORDER BY total_value DESC`
        : `SELECT
             COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised') AS commodity,
             COUNT(*)         AS item_count,
             SUM(${valueExpr}) AS total_value,
             SUM(${qtyExpr})   AS total_qty
           FROM inventoryrecord
           GROUP BY COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised')
           ORDER BY total_value DESC`;
      const byCommodity = prep(commoditySql).all(...(isHub ? hubSiteParams : [])).map(r => ({
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
           ${hubSiteWhere}
           ORDER BY inventory_value DESC
           LIMIT ?`
        : `SELECT item_number, item_description, qty_on_hand, last_cost, price,
                  COALESCE(NULLIF(TRIM(commodity), ''), '— Uncategorised') AS commodity,
                  ${valueExpr} AS inventory_value,
                  ? AS site_name
           FROM inventoryrecord
           ORDER BY inventory_value DESC
           LIMIT ?`;
      const topItems = (isHub ? prep(topItemsSql).all(...hubSiteParams, topN) : prep(topItemsSql).all(SITE_NAME, topN)).map(r => ({
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

      const sites = isHub
        ? prep(`SELECT DISTINCT COALESCE(s.name, i.site_id) AS site_name
                FROM hub_inventory i LEFT JOIN hub_sites s ON s.id = i.site_id
                ORDER BY site_name`).all().map(r => r.site_name).filter(Boolean)
        : [];

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
        site_name: isHub ? (siteFilter !== 'all' ? siteFilter : 'All branches') : SITE_NAME,
        hub_mode: isHub,
        filters: { sites },
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

  // ==================== MULTI-SITE REPORTING API ====================

  // GET /api/reporting/ar-document-summary — the hub pulls this from each branch
  // (hubEtl) to populate hub_ar_document_summary. Returns the branch's monthly
  // AR document totals for the current + prior financial year (back to Jan of
  // last year covers any FY start).
  router.get('/api/reporting/ar-document-summary', reportingRateLimiter, requireReportingToken, async (req, res) => {
    try {
      const now = new Date();
      const from = Number(`${now.getFullYear() - 1}0101`);
      const to = Number(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`);
      const { months } = await queryArDocSummary(from, to);
      res.json({ months });
    } catch (err) {
      console.error('[reporting.ar-document-summary] Sage query failed', err.message);
      res.status(503).json({ error: 'Sage query failed' });
    }
  });

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

  router.get('/api/reporting/inventory-movement', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      const { limit, offset } = pagination(req, { defaultLimit: 1000, maxLimit: 5000 });
      const rows = prep(
        `SELECT item_number, period, qty_sold, revenue, order_count, last_sale_date
         FROM inventory_sales_cache ORDER BY item_number, period LIMIT ? OFFSET ?`
      ).all(limit, offset);
      const meta = db.prepare('SELECT last_synced_at, last_synced_to, rows_synced FROM inventory_sales_sync_meta WHERE id = 1').get();
      res.json({
        site_id: SITE_ID,
        site_slug: SITE_SLUG,
        offset,
        limit,
        count: rows.length,
        has_more: rows.length === limit,
        records: rows,
        sync_meta: meta || {},
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // After a v099 upgrade the rollup cache is empty until the next inventory-sales
  // sync. The hub pull does delete-and-replace, so an empty pull would WIPE valid
  // Top Items/Dead Stock data on the hub. Rebuild once on first read if the cache
  // is empty but transactions exist — the in-process flag stops repeat rebuilds
  // (even when the rollup is legitimately empty), and the rebuild fits inside the
  // hub's fetch timeout so the pull still succeeds with real data.
  let salesRollupWarmAttempted = false;
  const ensureSalesRollupWarm = () => {
    if (salesRollupWarmAttempted) return;
    const itemEmpty = !prep('SELECT 1 FROM inventory_item_sales_rollup LIMIT 1').get();
    const custEmpty = !prep('SELECT 1 FROM inventory_customer_sales_rollup LIMIT 1').get();
    if (itemEmpty && custEmpty && prep('SELECT 1 FROM inventory_sales_transactions LIMIT 1').get()) {
      // Let a rebuild failure PROPAGATE — do NOT swallow it. The endpoint then
      // returns 500, the hub treats it as a failed pull and SKIPS its
      // delete-and-replace, so it keeps the existing valid hub data instead of
      // wiping it with an empty set. The once-flag is set only after success
      // (below), so the next hub pull retries the rebuild.
      rebuildInventorySalesRollups();
    }
    salesRollupWarmAttempted = true;
  };

  // Per-item monthly sales with inter-branch transfers EXCLUDED — the hub pulls
  // this for the Top Items + Dead Stock tiles. Description comes from the sales
  // cache (v096) falling back to the item master. Trailing 24 months.
  router.get('/api/reporting/inventory-item-sales', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      ensureSalesRollupWarm();
      const { limit, offset } = pagination(req, { defaultLimit: 5000, maxLimit: 20000 });
      // Served from the precomputed rollup cache (rebuilt once per inventory-sales
      // sync) — a cheap indexed SELECT, never an on-demand 24-month aggregation,
      // so this can't freeze the site's event loop / time out the hub's sync.
      const rows = prep(`
        SELECT item_number, period, qty_sold, revenue, item_description
        FROM inventory_item_sales_rollup
        ORDER BY period, item_number
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      res.json({ site_id: SITE_ID, site_slug: SITE_SLUG, offset, limit, count: rows.length, has_more: rows.length === limit, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-customer monthly sales with inter-branch transfers EXCLUDED — the hub
  // pulls this for the Top Customers tile (summed over the selected timeline).
  router.get('/api/reporting/inventory-customer-sales', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      ensureSalesRollupWarm();
      const { limit, offset } = pagination(req, { defaultLimit: 5000, maxLimit: 20000 });
      // Served from the precomputed rollup cache (rebuilt once per inventory-sales
      // sync) — a cheap indexed SELECT, never an on-demand aggregation.
      const rows = prep(`
        SELECT customer_code, customer_name, period, revenue, qty
        FROM inventory_customer_sales_rollup
        ORDER BY period, customer_code
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      res.json({ site_id: SITE_ID, site_slug: SITE_SLUG, offset, limit, count: rows.length, has_more: rows.length === limit, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-document AR open items (debtor open-item ledger) — the hub pulls this to
  // populate hub_debtor_ar_invoice so Aged Debtors ages per-document at head
  // office. Cheap indexed read of the open-item table; no aggregation.
  router.get('/api/reporting/ar-open-items', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      const { limit, offset } = pagination(req, { defaultLimit: 5000, maxLimit: 20000 });
      const rows = prep(`
        SELECT customer_code, reporting_account, document_number, document_type, document_date, due_date,
               original_amount, outstanding_amount, reference
        FROM debtor_ar_invoice
        ORDER BY customer_code, document_number
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      res.json({ site_id: SITE_ID, site_slug: SITE_SLUG, offset, limit, count: rows.length, has_more: rows.length === limit, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-document AP open items (creditor open-item ledger) — the hub pulls this to
  // populate hub_creditor_ap_invoice so Aged Creditors works at head office.
  router.get('/api/reporting/ap-open-items', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      const { limit, offset } = pagination(req, { defaultLimit: 5000, maxLimit: 20000 });
      const rows = prep(`
        SELECT vendor_code, document_number, document_type, document_date, due_date,
               original_amount, outstanding_amount, reference
        FROM creditor_ap_invoice
        ORDER BY vendor_code, document_number
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      res.json({ site_id: SITE_ID, site_slug: SITE_SLUG, offset, limit, count: rows.length, has_more: rows.length === limit, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Creditor master (vendor name / terms / last_payment_date) — the hub pulls
  // this into hub_creditor so Aged Creditors can join vendor metadata; the
  // report's default paid_only=true filter needs last_payment_date, so without
  // it the default hub view stays empty despite AP open items being present.
  router.get('/api/reporting/creditors', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      const { limit, offset } = pagination(req, { defaultLimit: 5000, maxLimit: 20000 });
      const rows = prep(`
        SELECT vendor_code, vendor_name, terms, contact, phone, email, is_active,
               last_receipt_date, last_payment_date
        FROM creditor
        ORDER BY vendor_code
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      res.json({ site_id: SITE_ID, site_slug: SITE_SLUG, offset, limit, count: rows.length, has_more: rows.length === limit, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/reporting/stock-receipt-expiry', reportingRateLimiter, requireReportingToken, (req, res) => {
    try {
      const { limit, offset } = pagination(req, { defaultLimit: 1000, maxLimit: 5000 });
      const rows = prep(`
        SELECT
          sr.receipt_number, sr.supplier_name, sr.receipt_date,
          srl.id AS receipt_line_id, srl.line_no, srl.item_number, srl.item_description,
          srl.qty_received, srl.uom, srl.unit_cost,
          e.expiry_date, e.qty_at_expiry, e.entered_by, e.entry_source, e.notes, e.created_date AS expiry_created
        FROM stock_receipt_line srl
        JOIN stock_receipt sr ON sr.id = srl.receipt_id
        -- Sweets-only (commodity '1'), mirroring listReceiptLines: expiry
        -- tracking doesn't apply to cigarettes/tobacco, and items with no
        -- inventoryrecord row (unknown commodity) are excluded. Without this
        -- the hub mirror surfaces tobacco lines as "missing expiry".
        INNER JOIN (
          SELECT TRIM(item_number) AS item_number,
                 TRIM(commodity) AS commodity,
                 ROW_NUMBER() OVER (PARTITION BY TRIM(item_number) ORDER BY updated_date DESC) AS rn
          FROM inventoryrecord
        ) ic ON ic.item_number = srl.item_number AND ic.rn = 1
        LEFT JOIN stock_receipt_line_expiry e ON e.receipt_line_id = srl.id
        WHERE ic.commodity = '1'
        ORDER BY sr.receipt_date DESC, srl.id, e.expiry_date ASC, e.id ASC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
      res.json({
        site_id: SITE_ID,
        site_slug: SITE_SLUG,
        offset,
        limit,
        count: rows.length,
        has_more: rows.length === limit,
        records: rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  // GET /api/insights — proactive insights feed (rule-based detectors over the
  // synced sales / inventory / debtor data). Site-mode; the hub returns empty.
  router.get('/api/insights', ...reportsGuard, async (req, res) => {
    try {
      const { computeInsights, refreshInsights } = await import('../services/insights.js');
      // ?refresh=true forces a recompute (the Insights page's explicit
      // "Refresh" button) instead of serving the invalidation-driven cache.
      const force = req.query.refresh === 'true' || req.query.refresh === '1';
      res.json(force ? refreshInsights() : computeInsights());
    } catch (err) {
      console.error('[reporting] insights error:', err);
      res.status(500).json({ error: 'Failed to compute insights' });
    }
  });

  // ── Custom insight rules (no-code builder) ──────────────────────────────
  // Reads are open to any reporting user; writes are admin-only (inline check
  // since this router only receives requireAuth).
  const requireAdminInline = (req, res) => {
    if (req.currentUser?.role !== 'admin') { res.status(403).json({ error: 'Admin only' }); return false; }
    return true;
  };

  router.get('/api/insights/rules', ...reportsGuard, async (req, res) => {
    try {
      const { listRules, METRIC_CATALOG } = await import('../services/insights.js');
      res.json({ rules: listRules(), metrics: METRIC_CATALOG });
    } catch (err) {
      console.error('[reporting] insight rules list error:', err);
      res.status(500).json({ error: 'Failed to load insight rules' });
    }
  });

  router.post('/api/insights/rules', requireAuth, async (req, res) => {
    if (!requireAdminInline(req, res)) return;
    try {
      const { createRule } = await import('../services/insights.js');
      res.json(createRule(req.body || {}, req.currentUser?.email || null));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/api/insights/rules/:id', requireAuth, async (req, res) => {
    if (!requireAdminInline(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid rule id' });
    try {
      const { updateRule } = await import('../services/insights.js');
      res.json(updateRule(id, req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/insights/rules/:id', requireAuth, async (req, res) => {
    if (!requireAdminInline(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid rule id' });
    try {
      const { deleteRule } = await import('../services/insights.js');
      const changes = deleteRule(id);
      if (!changes) return res.status(404).json({ error: 'Rule not found' });
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
