// Custom insight rules — operator-defined thresholds layered on top of the
// built-in insights detectors. Each rule names a known metric (from the
// engine's metric catalog), a comparison operator and a threshold; when the
// current metric value satisfies the comparison the engine emits an insight
// card. No SQL is stored — the metric is a safe enum the engine knows how to
// compute — so this is "no-code" but injection-safe.
export default {
  version: 90,
  name: 'insight_rules',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS insight_rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        metric      TEXT    NOT NULL,
        operator    TEXT    NOT NULL,        -- gt | gte | lt | lte
        threshold   REAL    NOT NULL,
        severity    TEXT    NOT NULL DEFAULT 'medium',  -- high | medium | low | info
        category    TEXT    NOT NULL DEFAULT 'Custom',
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_by  TEXT,
        created_at  TEXT DEFAULT (now_local()),
        updated_at  TEXT DEFAULT (now_local())
      );
      CREATE INDEX IF NOT EXISTS idx_insight_rules_enabled ON insight_rules(enabled);
    `);
  },
};
