import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 34,
      name: 'perf_index_autoflagrule_active_priority',
      up(db) {
        // activeAutoFlagRules runs on every sync and auto-flag check:
        //   SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC
        // Without an index this is a full table scan on every run.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_autoflagrule_active_priority
          ON autoflagrule (is_active, priority DESC);
        `);
      },
    };
