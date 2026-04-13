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

  stmts.activeAutoFlagRules  = db.prepare('SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC');
  stmts.updateAutoFlag       = db.prepare("UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = 1, flag_source = 'auto' WHERE id = ?");
  stmts.clearAutoFlag        = db.prepare("UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE id = ? AND auto_flagged = 1");
  stmts.clearAllAutoFlags    = db.prepare("UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE auto_flagged = 1");

  if (process.env.HUB_MODE === 'true') {
    stmts.getHubSetting     = db.prepare('SELECT value FROM hub_settings WHERE key = ?');
    stmts.setHubSetting     = db.prepare('INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    stmts.hubSitesForBackup = db.prepare('SELECT id, name, url, token FROM hub_sites');
  }

  return stmts;
}

export { buildStatements };
