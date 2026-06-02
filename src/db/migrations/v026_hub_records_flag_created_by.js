import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 26,
      name: 'hub_records_flag_created_by',
      up(db) {
        const hubRecordsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
        if (hubRecordsExists) {
          ensureColumn(db, 'hub_records', 'flag_created_by', 'TEXT');
        }
      },
    };
