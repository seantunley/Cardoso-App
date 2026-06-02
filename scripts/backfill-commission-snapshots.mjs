// Backfill commission_unpaid_snapshot for past periods that pre-date
// the unpaid-tracking code. Re-runs the unpaid query against Sage for
// each period whose archive exists but whose snapshot is missing.
//
// Usage:
//   node --env-file=.env.dev scripts/backfill-commission-snapshots.mjs
//   node --env-file=.env.dev scripts/backfill-commission-snapshots.mjs --periods 6
//
// Each period uses the snapshotted commission rates the operator was
// being paid at — read from settings TODAY because we don't have a
// rate history yet. So if the rate has changed since the period was
// paid, the clawback will be off; in practice the rate hasn't moved.
import 'dotenv/config';
import db from '../src/db/index.js';
import { getSagePool } from '../src/services/batReconciliation.js';
import { runCustomerSqlQuery } from '../src/services/customerSqlPool.js';
import {
  DEFAULT_COMMISSION_UNPAID_SQL,
  getCommissionSettings,
} from '../src/services/commission.js';

const argv = process.argv.slice(2);
const periodsFlag = argv.findIndex((a) => a === '--periods');
const PERIODS = periodsFlag >= 0 ? Math.max(1, Number(argv[periodsFlag + 1]) || 6) : 6;

// Pull the most recent N periods from commission_archive that don't
// already have a populated snapshot. Falls back to enumerating the
// last N canonical periods if there are no archives at all.
function targetPeriods() {
  const archives = db.prepare(`
    SELECT DISTINCT a.period_year, a.period_month, a.period_from, a.period_to
    FROM commission_archive a
    WHERE NOT EXISTS (
      SELECT 1 FROM commission_unpaid_snapshot s
      WHERE s.period_year = a.period_year AND s.period_month = a.period_month
    )
    ORDER BY a.period_year DESC, a.period_month DESC
    LIMIT ?
  `).all(PERIODS);
  if (archives.length > 0) return archives;

  // No archives — generate the last N canonical periods from today.
  const out = [];
  const now = new Date();
  for (let i = 1; i <= PERIODS; i++) {
    const ref = new Date(now.getFullYear(), now.getMonth() - i, 15);
    const y = ref.getFullYear();
    const m = ref.getMonth() + 1;
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevYear = m === 1 ? y - 1 : y;
    const pad = (n) => String(n).padStart(2, '0');
    out.push({
      period_year: y, period_month: m,
      period_from: `${prevYear}-${pad(prevMonth)}-24`,
      period_to:   `${y}-${pad(m)}-23`,
    });
  }
  return out;
}

function toYyyymmddInt(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Number(`${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`);
}

const settings = getCommissionSettings();
const sweetsRate = Number(settings.sweets_rate) || 0;
const refRate = Number(settings.reference_rate) || 0;
const vatDivisor = 1 + (Number.isFinite(settings.vat_rate) ? settings.vat_rate : 0.14);
const unpaidSql = (settings.unpaid_query_override || '').trim().length > 0
  ? settings.unpaid_query_override
  : DEFAULT_COMMISSION_UNPAID_SQL;

await getSagePool(); // open the pool once

const insertSnapshot = db.prepare(`
  INSERT INTO commission_unpaid_snapshot (
    period_year, period_month, sales_rep,
    invoice_number, customer_code, customer_name, invoice_date,
    net_sweet_amount, outstanding_amount,
    sweets_rate_at_paid, reference_rate_at_paid,
    sweet_commission_at_paid, reference_commission_at_paid,
    archive_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  ON CONFLICT(period_year, period_month, invoice_number) DO UPDATE SET
    sales_rep = excluded.sales_rep,
    customer_code = excluded.customer_code,
    customer_name = excluded.customer_name,
    invoice_date = excluded.invoice_date,
    net_sweet_amount = excluded.net_sweet_amount,
    outstanding_amount = excluded.outstanding_amount,
    sweets_rate_at_paid = excluded.sweets_rate_at_paid,
    reference_rate_at_paid = excluded.reference_rate_at_paid,
    sweet_commission_at_paid = excluded.sweet_commission_at_paid,
    reference_commission_at_paid = excluded.reference_commission_at_paid
`);

const periods = targetPeriods();
console.log(`Backfilling ${periods.length} period(s)…`);

for (const p of periods) {
  const fromInt = toYyyymmddInt(p.period_from);
  const toInt = toYyyymmddInt(p.period_to);
  process.stdout.write(`  ${p.period_year}-${String(p.period_month).padStart(2, '0')} (${p.period_from} → ${p.period_to}) … `);
  try {
    const result = await runCustomerSqlQuery(unpaidSql, { from: fromInt, to: toInt, vat: vatDivisor });
    const rows = result.recordset || [];
    db.transaction(() => {
      for (const row of rows) {
        const sales_rep = String(row.sales_rep || '').trim() || 'Unknown';
        const net = Number(row.net_sweet_amount) || 0;
        insertSnapshot.run(
          p.period_year, p.period_month, sales_rep,
          String(row.invoice_number || '').trim(),
          String(row.customer_code || '').trim() || null,
          row.customer_name || null,
          row.invoice_date != null ? String(row.invoice_date) : null,
          net,
          Number(row.outstanding_amount) || 0,
          sweetsRate, refRate,
          net * sweetsRate, net * refRate,
        );
      }
    })();
    console.log(`${rows.length} unpaid invoice${rows.length === 1 ? '' : 's'} snapshotted`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

console.log('\nDone.');
process.exit(0);
