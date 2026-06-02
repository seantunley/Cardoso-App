import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 3,
      name: 'flag_source_and_terms',
      up(db) {
        ensureColumn(db, 'datarecord', 'flag_source', `TEXT DEFAULT NULL`);
        ensureColumn(db, 'datarecord', 'terms', 'TEXT');
      },
    };
