// Hub mirror for the AR Document Summary report. Site installs compute their
// monthly posted-document totals from Sage (ARIBH) and the hub pulls them down
// per branch (hubEtl.syncSite), so the hub can show the report per branch with
// a consolidated view. One row per (site, month); the hub upserts the rolling
// current+prior financial-year window each ETL cycle.
export default {
  version: 94,
  name: 'hub_ar_document_summary',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_ar_document_summary (
        site_id  TEXT NOT NULL,
        ym       TEXT NOT NULL,          -- 'YYYY-MM'
        inv_excl REAL DEFAULT 0, inv_vat REAL DEFAULT 0, inv_incl REAL DEFAULT 0,
        cn_excl  REAL DEFAULT 0, cn_vat  REAL DEFAULT 0, cn_incl  REAL DEFAULT 0,
        dn_excl  REAL DEFAULT 0, dn_vat  REAL DEFAULT 0, dn_incl  REAL DEFAULT 0,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, ym)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_ar_doc_summary_site ON hub_ar_document_summary(site_id, ym);
    `);
  },
};
