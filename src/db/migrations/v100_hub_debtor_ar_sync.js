export default {
  version: 100,
  name: 'hub_debtor_ar_sync',
  up(db) {
    // Per-site marker that a hub AR open-item sync COMPLETED for a site —
    // independent of whether it returned any rows. The Aged Debtors hub builder
    // (acquireHubAgedDebtorRows) uses THIS, not the presence of
    // hub_debtor_ar_invoice rows, to decide ledger-vs-snapshot per site.
    //
    // Why: the hub ETL full-refreshes a site (DELETE then INSERT). A site that
    // syncs successfully but is fully paid up (zero open items) ends with NO
    // ledger rows — indistinguishable, by row presence alone, from a site whose
    // AR ETL has never run. Falling back to the hub_records snapshot for the
    // former would show its (possibly stale) snapshot balances even though the
    // authoritative open-item ledger says it owes nothing.
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_debtor_ar_sync (
        site_id   TEXT PRIMARY KEY,
        synced_at TEXT
      );
    `);

    // Backfill: any site that already has AR rows has obviously synced before
    // this marker existed — seed it so Aged Debtors keeps using their ledger
    // immediately on upgrade, not only after the next ETL cycle. (Sites that
    // synced-empty before this migration have no rows to backfill from; they
    // self-correct on their next AR sync.)
    const arExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='hub_debtor_ar_invoice'`
    ).get();
    if (arExists) {
      db.exec(`
        INSERT OR IGNORE INTO hub_debtor_ar_sync (site_id, synced_at)
        SELECT site_id, MAX(synced_at) FROM hub_debtor_ar_invoice GROUP BY site_id
      `);
    }
  },
};
