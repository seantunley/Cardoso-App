import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // Drop the resource_type CHECK constraint from auditlog.
      //
      // The original schema whitelisted resource_type to one of
      //   'user' | 'connection' | 'record' | 'rule' | 'system'
      // PR #198 added the "Sync from Accpac" trigger flow with three new
      // logAudit calls passing resource_type='site' — without updating the
      // CHECK. Every operator click on the hub's "Sync from Accpac" button
      // (and every scheduled retry) emits a SQLITE_CONSTRAINT_CHECK and the
      // audit row is silently dropped, leaving the hub_audit_log page with
      // no record of who triggered what.
      //
      // The fix could be "add 'site' to the CHECK list", but that just sets
      // up the next merge-loss bug — every new feature that introduces a
      // resource type would need a coordinated CHECK migration. Drop the
      // constraint entirely; resource_type is descriptive metadata, not a
      // foreign-key-style invariant. The status CHECK ('success'|'failure')
      // stays — it's a finite domain that we DO want enforced.
      //
      // SQLite doesn't support ALTER TABLE DROP CONSTRAINT directly, so this
      // does the standard table-swap dance: create new table, copy rows,
      // drop old, rename. Run inside the migration transaction (runMigrations
      // wraps each in db.transaction) so a partial swap rolls back cleanly.
      // Indexes are recreated to match schema.js + migration v40 (the
      // resource lookup index).
      version: 65,
      name: 'auditlog_drop_resource_type_check',
      up(db) {
        const auditExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='auditlog'`).get();
        if (!auditExists) return; // Nothing to migrate; schema.js will create with the new shape.
        db.exec(`
          CREATE TABLE auditlog_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            user_email TEXT NOT NULL,
            user_name TEXT,
            resource_type TEXT,
            resource_id TEXT,
            resource_name TEXT,
            action_details TEXT,
            changes TEXT,
            ip_address TEXT,
            status TEXT CHECK(status IN ('success', 'failure')) NOT NULL,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO auditlog_new (
            id, action_type, user_email, user_name, resource_type,
            resource_id, resource_name, action_details, changes,
            ip_address, status, created_date
          )
          SELECT
            id, action_type, user_email, user_name, resource_type,
            resource_id, resource_name, action_details, changes,
            ip_address, status, created_date
          FROM auditlog;
          DROP TABLE auditlog;
          ALTER TABLE auditlog_new RENAME TO auditlog;
          CREATE INDEX IF NOT EXISTS idx_auditlog_created_date
            ON auditlog(created_date);
          CREATE INDEX IF NOT EXISTS idx_auditlog_resource
            ON auditlog(resource_type, resource_id, created_date DESC);
        `);
      },
    };
