import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 53,
      name: 'error_log',
      up(db) {
        // Centralised error journal — one row per error from anywhere in the
        // app (BAT/OCR, Sage pool, sync engine, audit-log flush, browser-side
        // errors via /api/log/client-error, unhandled promise rejections).
        // Surfaces a user-facing "System log" page so off-site operators can
        // see what failed without grepping logs/errors.log.
        db.exec(`
          CREATE TABLE IF NOT EXISTS error_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT 'error',
            message TEXT NOT NULL,
            stack TEXT,
            context TEXT,
            occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_occurred ON error_log(occurred_at DESC)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source, occurred_at DESC)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_level ON error_log(level, occurred_at DESC)`);
      },
    };
