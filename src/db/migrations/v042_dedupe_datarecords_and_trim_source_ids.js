import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 42,
      name: 'dedupe_datarecords_and_trim_source_ids',
      up(db) {
        // Trim trailing whitespace from source_id (MSSQL char padding)
        db.prepare(`UPDATE datarecord SET source_id = TRIM(source_id) WHERE source_id != TRIM(source_id)`).run();

        // Remove duplicate records — keep the one with the latest updated_date per source_table + source_id
        const dupes = db.prepare(`
          SELECT source_table, TRIM(source_id) AS source_id, COUNT(*) AS cnt
          FROM datarecord
          WHERE source_id IS NOT NULL AND TRIM(source_id) != ''
          GROUP BY source_table, TRIM(source_id)
          HAVING COUNT(*) > 1
        `).all();

        if (dupes.length > 0) {
          const deleteOlder = db.prepare(`
            DELETE FROM datarecord WHERE id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY source_table, TRIM(source_id)
                  ORDER BY
                    CASE WHEN flag_color IS NOT NULL AND flag_color != '' AND flag_color != 'none' THEN 0 ELSE 1 END,
                    updated_date DESC
                ) AS rn
                FROM datarecord
                WHERE source_table = ? AND TRIM(source_id) = ?
              ) WHERE rn = 1
            ) AND source_table = ? AND TRIM(source_id) = ?
          `);

          let totalRemoved = 0;
          for (const d of dupes) {
            const result = deleteOlder.run(d.source_table, d.source_id, d.source_table, d.source_id);
            totalRemoved += result.changes;
          }
          console.log(`[migration-42] Removed ${totalRemoved} duplicate records across ${dupes.length} groups`);
        }

        // Add unique index to prevent future duplicates
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_datarecord_source_unique ON datarecord (source_table, source_id) WHERE source_id IS NOT NULL AND source_id != ''`);
      },
    };
