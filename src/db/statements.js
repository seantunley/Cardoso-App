/**
 * Pre-compiled prepared statements.
 * Extracted from server.js for US-002.
 */

function buildStatements(db) {
  const stmts = {};

  stmts.getUserById        = db.prepare('SELECT * FROM "user" WHERE id = ?');
  stmts.getUserByEmail     = db.prepare('SELECT * FROM "user" WHERE email = ?');
  stmts.updateUserPassword = db.prepare('UPDATE "user" SET password_hash = ? WHERE id = ?');

  stmts.kpiTotalRecords  = db.prepare('SELECT COUNT(*) as count FROM datarecord');
  stmts.kpiFlagCounts    = db.prepare('SELECT flag_color, COUNT(*) as count FROM datarecord GROUP BY flag_color');
  stmts.kpiLastSync      = db.prepare('SELECT completed_at FROM syncrun ORDER BY completed_at DESC LIMIT 1');
  stmts.kpiLastRun       = db.prepare('SELECT status, completed_at FROM syncrun ORDER BY completed_at DESC LIMIT 1');
  stmts.kpiActiveConns   = db.prepare("SELECT COUNT(*) as count FROM databaseconnection WHERE status = 'active'");

  stmts.autoRecordsForFlags  = db.prepare('SELECT * FROM datarecord WHERE flag_color IS NOT NULL OR auto_flagged = 1 OR outstanding_balance IS NOT NULL');
  stmts.activeAutoFlagRules  = db.prepare('SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC');
  stmts.updateAutoFlag       = db.prepare("UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = 1, flag_source = 'auto' WHERE id = ?");
  stmts.clearAutoFlag        = db.prepare("UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE id = ? AND auto_flagged = 1");
  stmts.clearAllAutoFlags    = db.prepare("UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE auto_flagged = 1");

  // Sync-engine prepared statements are NOT created here — see syncEngine.js.
  // An earlier draft of this PR added them to buildStatements, but
  // buildStatements is invoked at module load via the import chain
  // `server → scheduler → syncEngine`, which runs BEFORE
  // initSchema/runMigrations in server.js. On a site upgrading from a
  // pre-v41 database the eager prepare of `flag_snapshots` queries
  // boot-failed with `no such table: flag_snapshots` before the migration
  // could create it. The sync statements live in a lazy module-level
  // cache in syncEngine.js so the first prepare runs after migrations
  // have completed — same perf benefit (one prepare per process) without
  // the boot-order dependency.

  // Earlier drafts eagerly prepared three hub statements here
  // (getHubSetting / setHubSetting / hubSitesForBackup) gated on
  // HUB_MODE. They turned out to be dead — no consumer referenced
  // them — and the eager prepare boot-failed on a site→hub flip
  // because buildStatements runs BEFORE initSchema creates the hub
  // tables (same race documented above for the sync statements).
  // Future hub-only prepared statements should follow the lazy
  // module-cache pattern in syncEngine.js (getSyncStmt).

  return stmts;
}

export { buildStatements };
