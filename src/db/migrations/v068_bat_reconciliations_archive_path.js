import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // Archive every uploaded BAT supplier spreadsheet so a later
      // dispute can be replayed against the original file. Today the
      // upload route parses the .xlsx into DB rows then unlinks the
      // multer temp file in a finally block — once the operator is
      // looking at the recon there's no way to re-open the source if
      // a supplier disagrees with the totals. archive_path stores the
      // copy's location under uploads/bat-archive/<reconId>/.
      version: 68,
      name: 'bat_reconciliations_archive_path',
      up(db) {
        db.exec(`ALTER TABLE bat_reconciliations ADD COLUMN archive_path TEXT`);
      },
    };
