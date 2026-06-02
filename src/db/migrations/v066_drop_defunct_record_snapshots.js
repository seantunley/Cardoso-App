import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // Drop the defunct record_snapshots table.
      //
      // The table was a snapshot-on-every-sync record that nobody
      // actually read. Writes were dropped earlier (see the comment
      // at src/services/syncEngine.js around the runWriteRows helper)
      // but the existing rows were left in place — "the table itself
      // is kept around (no destructive migration)".
      //
      // On busy production sites that table accumulated ~600 MB/month
      // of dead JSON before writes stopped. One site was found at
      // 1,001,490 rows totalling 3.7 GB of cardoso.db (the entire
      // database file was 99% this one table). The defunct-table-with-
      // no-readers state had no upside; drop it.
      //
      // IF EXISTS so the migration is a no-op on installs that already
      // saw the table dropped manually (e.g. operator ran the
      // operator-runbook cleanup before this release deployed) AND on
      // brand-new installs that never had the table created.
      //
      // Important: DROP TABLE alone does NOT shrink cardoso.db on disk
      // — SQLite frees the pages but the file size is unchanged until
      // a VACUUM runs. The monthly VACUUM cron added in the same
      // release reclaims the disk within ~30 days. Operators who want
      // the disk back immediately can run a one-shot VACUUM (see the
      // operator runbook section on disk recovery).
      version: 66,
      name: 'drop_defunct_record_snapshots',
      up(db) {
        db.exec('DROP TABLE IF EXISTS record_snapshots');
      },
    };
