// Shared open-item aging engine — the single source of truth for how the app
// ages accounts-receivable (debtors) AND accounts-payable (creditors), built to
// duplicate this site's Sage 300 Aged Trial Balance, verified column-for-column
// against the live report:
//
//   - Each OPEN DOCUMENT is aged individually (never "whole balance in one
//     bucket"); an entity's balance is DISTRIBUTED across the periods.
//   - Documents are aged by DOCUMENT DATE (the basis the site's Sage report
//     uses — confirmed: our document-date totals tie to the cent), falling back
//     to due date only when a document date is somehow missing.
//   - Periods match Sage exactly: Current (not yet aged, ≤0 days) / 1–7 / 8–14
//     / 15–21 / Over 21 days.
//   - Credit/debit notes (negative outstanding) age by their own date like any
//     other document (the site's Sage ages them by date, not "As Current" —
//     its Over-21 column carries the aged credits as a negative).
//
// Pure module: no DB, no Express, no I/O — so it's trivially unit-testable and
// reused by both report builders in routes/reporting.js.

// Bucket keys are fixed (they pair with BUCKET_META in the report components and
// BUCKET_LABELS in reportExports.js). `unknown` collects documents with no
// usable date. Order here is the display order.
export const BUCKET_KEYS = ['current', '1-7', '8-14', '15-21', 'over-21', 'unknown'];

// Parse a stored date ('YYYY-MM-DD' or 'YYYYMMDD') or a Date into LOCAL
// midnight, so day-count math against a local-midnight asOf can't drift by a
// day across timezones. Returns null when there's no usable date.
function toLocalMidnight(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

// Which Sage period an age-in-days lands in. Current = not yet aged (≤0 days,
// i.e. dated on/after the as-of date); then weekly periods 1–7, 8–14, 15–21,
// and everything older in Over 21.
function bucketForAge(ageDays) {
  if (ageDays == null) return 'unknown';
  if (ageDays <= 0) return 'current';
  if (ageDays <= 7) return '1-7';
  if (ageDays <= 14) return '8-14';
  if (ageDays <= 21) return '15-21';
  return 'over-21';
}

function emptyBucketMap() {
  return Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0]));
}

/**
 * Age a flat list of open documents and distribute each entity's balance
 * across the weekly periods.
 *
 * @param {Array<{entityCode, entityName?, date?, dueDate?, outstanding,
 *                documentNumber?, documentType?, reference?}>} docs
 * @param {object} [opts]
 * @param {Date}    [opts.asOf]           "Age as of" date (default: today @ local midnight)
 * @param {'document'|'due'} [opts.basis]  which date to age by (default 'document')
 * @returns {{ buckets, bucket_counts, total_outstanding, entities }}
 */
export function ageOpenItems(docs, opts = {}) {
  const {
    asOf = startOfToday(),
    basis = 'document',
  } = opts;

  const asOfMid = toLocalMidnight(asOf) || startOfToday();
  const asOfMs = asOfMid.getTime();

  const buckets = emptyBucketMap();
  const bucketCounts = emptyBucketMap();
  let totalOutstanding = 0;

  const byEntity = new Map();

  for (const doc of docs || []) {
    const outstanding = Number(doc?.outstanding) || 0;
    const code = String(doc?.entityCode ?? '').trim();

    const docDate = toLocalMidnight(doc?.date);
    const dueDate = toLocalMidnight(doc?.dueDate);
    const effective = basis === 'due' ? (dueDate || docDate) : (docDate || dueDate);

    const ageDays = effective ? Math.floor((asOfMs - effective.getTime()) / 86400000) : null;

    // Every document — invoices and credit notes alike — ages by its own date.
    const bucketKey = bucketForAge(ageDays);

    let entity = byEntity.get(code);
    if (!entity) {
      entity = {
        entityCode: code,
        entityName: (doc?.entityName ?? '').toString().trim() || null,
        total: 0,
        bucket_amounts: emptyBucketMap(),
        bucket_doc_counts: emptyBucketMap(),
        oldest_age_days: null,
        documents: [],
      };
      byEntity.set(code, entity);
    }
    if (!entity.entityName && doc?.entityName) entity.entityName = String(doc.entityName).trim();

    entity.total += outstanding;
    entity.bucket_amounts[bucketKey] += outstanding;
    entity.bucket_doc_counts[bucketKey] += 1;
    if (ageDays != null && (entity.oldest_age_days == null || ageDays > entity.oldest_age_days)) {
      entity.oldest_age_days = ageDays;
    }
    entity.documents.push({
      documentNumber: doc?.documentNumber ?? null,
      documentType: doc?.documentType ?? null,
      date: doc?.date ?? null,
      dueDate: doc?.dueDate ?? null,
      outstanding,
      ageDays,
      bucketKey,
      reference: doc?.reference ?? null,
    });

    totalOutstanding += outstanding;
    buckets[bucketKey] += outstanding;
  }

  // Per-bucket entity counts: an entity is counted once per bucket it has at
  // least one document in (matches the report copy "customers with at least
  // one invoice in that bucket").
  const entities = [];
  for (const entity of byEntity.values()) {
    for (const k of BUCKET_KEYS) {
      if (entity.bucket_doc_counts[k] > 0) bucketCounts[k] += 1;
    }
    entities.push({
      entityCode: entity.entityCode,
      entityName: entity.entityName,
      total: entity.total,
      bucket_amounts: entity.bucket_amounts,
      oldest_age_days: entity.oldest_age_days,
      primary_bucket: bucketForAge(entity.oldest_age_days),
      documents: entity.documents,
    });
  }

  return {
    buckets,
    bucket_counts: bucketCounts,
    total_outstanding: totalOutstanding,
    entities,
  };
}
