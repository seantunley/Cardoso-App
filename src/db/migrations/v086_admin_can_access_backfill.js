import { ensureColumn, ensureTable } from './_helpers.js';

export default {
  // Self-healing backfill: every can_access_* column on user gets set
  // to 1 for admin users.
  //
  // Background: hasPermission() in src/lib/permissions.js bypasses
  // permission checks for admins UNLESS the permission is explicitly 0
  // (so a BAT-only admin can have Network Devices disabled). It assumes
  // "the admin migration sets every existing admin's permissions to 1".
  // Several historical migrations (v17, v25, v49, v55, v69, v76, v77,
  // v78, v81…) added can_access_* columns with `DEFAULT 0` and never
  // backfilled — leaving existing admins denied by the bypass.
  //
  // First symptom: site → hub flip on 2026-05-29 showed BAT Reconciliation
  // missing from an admin's sidebar because can_access_hub_reconciliation
  // had default-0 from v49. Same shape applies to every can_access_*
  // column on an upgrade. Run this UPDATE once, dynamically discovering
  // every can_access_ column so future additions stay covered without
  // a follow-up migration.
  version: 86,
  name: 'admin_can_access_backfill',
  up(db) {
    const cols = db.prepare(`PRAGMA table_info("user")`).all()
      .map(c => c.name)
      .filter(name => name.startsWith('can_access_'));
    if (cols.length === 0) return;
    const setClause = cols.map(c => `${c} = 1`).join(', ');
    const info = db.prepare(`UPDATE "user" SET ${setClause} WHERE role = 'admin'`).run();
    if (info.changes > 0) {
      console.log(`[migration.v86.admin_backfill] flipped ${cols.length} can_access_* columns to 1 on ${info.changes} admin row(s)`);
    }
  },
};
