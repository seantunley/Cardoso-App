import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 1,
      name: 'initial_schema_columns',
      up(db) {
        ensureColumn(db, 'datarecord', 'local_fields', `TEXT DEFAULT '{}'`);
        ensureColumn(db, 'databaseconnection', 'last_error', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_current', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_7_days', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_14_days', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_21_days', 'TEXT');
        ensureColumn(db, 'datarecord', 'outstanding_balance', 'TEXT');
      },
    };
