import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 43,
      name: 'drop_speedtest_tables',
      up(db) {
        db.exec(`DROP TABLE IF EXISTS site_speedtest`);
        db.exec(`DROP TABLE IF EXISTS hub_speedtest`);
      },
    };
