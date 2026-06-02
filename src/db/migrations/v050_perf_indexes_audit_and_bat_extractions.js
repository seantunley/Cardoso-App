import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 50,
      name: 'perf_indexes_audit_and_bat_extractions',
      up(db) {
        // Audit-log lookups by (resource_type, resource_id) — used by the
        // record-history endpoint and credit-debug — were doing a full table
        // scan + sort. Composite index covers the WHERE and the ORDER BY.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_auditlog_resource
                 ON auditlog(resource_type, resource_id, created_date DESC)`);
        // BAT OCR claimNext() filters on (reconciliation_id, extraction_status)
        // and orders by id. The existing single-column status index forced a
        // re-sort on every claim during a 200-PDF extraction.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_recon_status
                 ON bat_invoice_extractions(reconciliation_id, extraction_status, id)`);
      },
    };
