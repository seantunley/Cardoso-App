// Shared open-item aging engine — the single source of truth for how the app
// ages accounts-receivable (debtors) AND accounts-payable (creditors), built to
// duplicate this site's Sage 300 reports, each verified column-for-column
// against the live report:
//
//   AR (debtors)   — Sage "Aged Trial Balance by Document Date": age each open
//                    document by its DOCUMENT date into WEEKLY periods
//                    (Current / 1–7 / 8–14 / 15–21 / Over 21).
//   AP (creditors) — Sage "Aged Payables by Due Date": age each open document
//                    by its DUE date into MONTHLY periods
//                    (Current / 1–30 / 31–60 / 61–90 / Over 90).
//
// Each open document is aged individually and its amount distributed across the
// periods (never "whole balance in one bucket"); credit notes age by their own
// date like any other document. Pure module: no DB, no Express, no I/O.

// A scheme = { keys (display order; last entry is always 'unknown'), thresholds
// (the three day-boundaries between the four overdue periods), basis, labels }.
// `current` holds everything not yet aged (age ≤ 0 days).
export const AR_SCHEME = {
  keys: ['current', '1-7', '8-14', '15-21', 'over-21', 'unknown'],
  thresholds: [7, 14, 21],
  basis: 'document',
  labels: { current: 'Current', '1-7': '1–7 days', '8-14': '8–14 days', '15-21': '15–21 days', 'over-21': 'Over 21 days', unknown: 'Undated' },
};
export const AP_SCHEME = {
  keys: ['current', '1-30', '31-60', '61-90', 'over-90', 'unknown'],
  thresholds: [30, 60, 90],
  basis: 'due',
  labels: { current: 'Current', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', 'over-90': 'Over 90 days', unknown: 'Undated' },
};

// Back-compat alias: debtor reports + Customer Balances default to the AR scheme.
export const BUCKET_KEYS = AR_SCHEME.keys;

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

// Which period an age-in-days lands in, per the scheme. Current = not yet aged
// (≤0 days); the three thresholds split the four overdue periods.
function bucketForAge(ageDays, scheme) {
  if (ageDays == null) return 'unknown';
  const [b0, b1, b2] = scheme.thresholds;
  const k = scheme.keys;
  if (ageDays <= 0) return k[0];
  if (ageDays <= b0) return k[1];
  if (ageDays <= b1) return k[2];
  if (ageDays <= b2) return k[3];
  return k[4];
}

const emptyBucketMap = (scheme) => Object.fromEntries(scheme.keys.map((k) => [k, 0]));

/**
 * Age a flat list of open documents and distribute each entity's balance
 * across the scheme's periods.
 *
 * @param {Array<{entityCode, entityName?, date?, dueDate?, outstanding,
 *                documentNumber?, documentType?, reference?}>} docs
 * @param {object} [opts]
 * @param {Date}    [opts.asOf]    "Age as of" date (default: today @ local midnight)
 * @param {object}  [opts.scheme]  AR_SCHEME (default) or AP_SCHEME
 * @param {'document'|'due'} [opts.basis]  which date to age by (default: scheme.basis)
 * @returns {{ buckets, bucket_counts, total_outstanding, entities }}
 */
export function ageOpenItems(docs, opts = {}) {
  const {
    asOf = startOfToday(),
    scheme = AR_SCHEME,
    basis = scheme.basis,
  } = opts;

  const asOfMid = toLocalMidnight(asOf) || startOfToday();
  const asOfMs = asOfMid.getTime();

  const buckets = emptyBucketMap(scheme);
  const bucketCounts = emptyBucketMap(scheme);
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
    const bucketKey = bucketForAge(ageDays, scheme);

    let entity = byEntity.get(code);
    if (!entity) {
      entity = {
        entityCode: code,
        entityName: (doc?.entityName ?? '').toString().trim() || null,
        total: 0,
        bucket_amounts: emptyBucketMap(scheme),
        bucket_doc_counts: emptyBucketMap(scheme),
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
  // least one document in.
  const entities = [];
  for (const entity of byEntity.values()) {
    for (const k of scheme.keys) {
      if (entity.bucket_doc_counts[k] > 0) bucketCounts[k] += 1;
    }
    entities.push({
      entityCode: entity.entityCode,
      entityName: entity.entityName,
      total: entity.total,
      bucket_amounts: entity.bucket_amounts,
      oldest_age_days: entity.oldest_age_days,
      primary_bucket: bucketForAge(entity.oldest_age_days, scheme),
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
