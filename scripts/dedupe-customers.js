#!/usr/bin/env node
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node scripts/dedupe-customers.js <sqlite-db-path>');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const hasDatarecord = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='datarecord'`).get();
if (!hasDatarecord) {
  console.error('datarecord table not found');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

const tx = db.transaction(() => {
  const dupGroups = db.prepare(`
    SELECT TRIM(customer_number) AS customer_number, COUNT(*) AS cnt
    FROM datarecord
    WHERE TRIM(COALESCE(customer_number, '')) != ''
    GROUP BY TRIM(customer_number)
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, customer_number ASC
  `).all();

  const keepers = db.prepare(`
    SELECT id
    FROM datarecord
    WHERE TRIM(customer_number) = ?
    ORDER BY
      CASE WHEN updated_date IS NULL THEN 1 ELSE 0 END,
      COALESCE(updated_date, created_date, synced_at, '') DESC,
      id DESC
    LIMIT 1
  `);

  const updateKeeperFlag = db.prepare(`
    UPDATE datarecord
    SET flag_color = ?, flag_reason = ?
    WHERE id = ?
  `);

  const deleteDupes = db.prepare(`DELETE FROM datarecord WHERE id = ?`);

  const report = [];
  for (const group of dupGroups) {
    const keeper = keepers.get(group.customer_number)?.id;
    const rows = db.prepare(`
      SELECT id, customer_name, updated_date, created_date, synced_at, flag_color, flag_reason
      FROM datarecord
      WHERE TRIM(customer_number) = ?
      ORDER BY
        CASE WHEN updated_date IS NULL THEN 1 ELSE 0 END,
        COALESCE(updated_date, created_date, synced_at, '') DESC,
        id DESC
    `).all(group.customer_number);

    // Check if keeper already has a flag
    const keeperRow = rows.find(r => r.id === keeper);
    const keeperHadFlag = keeperRow && keeperRow.flag_color && keeperRow.flag_color !== 'none';

    // Collect flags from deleted duplicates
    let preservedFlagColor = null;
    let preservedFlagReason = null;
    const removed = [];
    for (const row of rows) {
      if (row.id === keeper) continue;
      removed.push({
        id: row.id,
        name: row.customer_name,
        updated_date: row.updated_date,
        created_date: row.created_date,
        synced_at: row.synced_at,
        flag_color: row.flag_color,
        flag_reason: row.flag_reason,
      });
      // Remember the first non-none flag from a deleted dupe
      if (!preservedFlagColor && row.flag_color && row.flag_color !== 'none') {
        preservedFlagColor = row.flag_color;
        preservedFlagReason = row.flag_reason;
      }
      if (!dryRun) deleteDupes.run(row.id);
    }

    // Apply preserved flag to keeper (only if keeper didn't already have one)
    if (!dryRun && !keeperHadFlag && preservedFlagColor) {
      updateKeeperFlag.run(preservedFlagColor, preservedFlagReason, keeper);
    }

    report.push({ customer_number: group.customer_number, kept_id: keeper, removed_count: removed.length, removed });
  }

  return report;
});

const report = tx();
console.log(JSON.stringify({ ok: true, dryRun, dbPath, groups: report.length, report }, null, 2));
