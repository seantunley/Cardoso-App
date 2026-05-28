import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 32,
      name: 'databaseconnection_use_encryption',
      up(db) {
        ensureColumn(db, 'databaseconnection', 'use_encryption', 'INTEGER NOT NULL DEFAULT 0');
      },
    };
