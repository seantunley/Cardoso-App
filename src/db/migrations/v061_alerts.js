import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 61,
      name: 'alerts',
      up(db) {
        // Operator alerts surfaced by the alert engine (src/lib/alertEngine.js).
        // Each row is one firing of one rule. dedup_key is what stops
        // the engine writing the same active alert repeatedly while a
        // condition persists; resolved_at NULL = still active.
        //
        // Severity is a fixed enum mainly so the future email channel
        // (env-var opt-in) can apply per-severity routing without a
        // separate config table. context is a small JSON blob the rule
        // attaches at fire time (offending values, links, etc.).
        db.exec(`
          CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_name TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
            message TEXT NOT NULL,
            context TEXT,
            dedup_key TEXT NOT NULL,
            fired_at TEXT NOT NULL,
            resolved_at TEXT,
            resolved_by TEXT
          )
        `);
        // The dominant query pattern is "is there an active alert for
        // this dedup_key?" — partial index keyed on dedup_key WHERE
        // resolved_at IS NULL satisfies that without scanning resolved
        // history.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_alerts_active_dedup
            ON alerts(dedup_key) WHERE resolved_at IS NULL
        `);
        // For the dashboard / API: latest alerts overall.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_fired ON alerts(fired_at DESC)`);
      },
    };
