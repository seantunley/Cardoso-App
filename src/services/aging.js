// Shared open-item aging engine — the single source of truth for how the app
// ages accounts-receivable (debtors) AND accounts-payable (creditors), built to
// duplicate Sage 300's Aged Trial Balance method:
//
//   - Each OPEN DOCUMENT is aged individually (never "whole balance in one
//     bucket"); an entity's balance is DISTRIBUTED across the periods.
//   - Documents are aged by DUE DATE (Sage's default for invoices), falling
//     back to document date when a due date is missing.
//   - Weekly periods: Current (<7d overdue) / 7–13 / 14–20 / 21+ — matching the
//     buckets the site's Sage A/R is configured with.
//   - Credit/debit notes (negative outstanding) are treated As Current by
//     default (Sage's "Age Credit Notes And Debit Notes = As Current" option);
//     pass creditNoteMode:'age' to age them by date instead.
//
// Pure module: no DB, no Express, no I/O — so it's trivially unit-testable and
// reused by both report builders in routes/reporting.js.

export const WEEKLY_BUCKETS = [7, 14, 21];

// Bucket keys are fixed (they pair with BUCKET_META in AgedDebtors.jsx and
// BUCKET_LABELS in reportExports.js). The four dated buckets correspond to the
// three `boundaries`; `unknown` collects documents with no usable date.
export const BUCKET_KEYS = ['current', '7-13', '14-20', '21+', 'unknown'];

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

// Which bucket an overdue-day count lands in. Negative days (not yet due) and
// anything under the first boundary are Current.
function bucketForAge(ageDays, boundaries) {
  if (ageDays == null) return 'unknown';
  if (ageDays < boundaries[0]) return 'current';
  if (ageDays < boundaries[1]) return '7-13';
  if (ageDays < boundaries[2]) return '14-20';
  return '21+';
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
 * @param {'due'|'document'} [opts.basis]  which date to age by (default 'due')
 * @param {number[]} [opts.boundaries]     three day-boundaries (default [7,14,21])
 * @param {'current'|'age'} [opts.creditNoteMode]  how to place negative docs (default 'current')
 * @returns {{ buckets, bucket_counts, total_outstanding, entities }}
 */
export function ageOpenItems(docs, opts = {}) {
  const {
    asOf = startOfToday(),
    basis = 'due',
    boundaries = WEEKLY_BUCKETS,
    creditNoteMode = 'current',
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

    let bucketKey = bucketForAge(ageDays, boundaries);
    // Sage "As Current" handling for credit/debit notes & prepayments.
    if (creditNoteMode === 'current' && outstanding < 0) bucketKey = 'current';

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
      primary_bucket: bucketForAge(entity.oldest_age_days, boundaries),
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
