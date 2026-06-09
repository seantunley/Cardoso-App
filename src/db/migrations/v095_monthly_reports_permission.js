import { ensureColumn } from './_helpers.js';

// Single permission gating the "Monthly Reports" sidebar group (Monthly Sales
// Figures + Sales Commission). Admins keep access automatically (matches every
// other can_access_* permission), and existing Sales Commission users are
// backfilled so they don't lose access when commission moves under this group's
// permission.
export default {
  version: 95,
  name: 'monthly_reports_permission',
  up(db) {
    ensureColumn(db, 'user', 'can_access_monthly_reports', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`UPDATE "user" SET can_access_monthly_reports = 1 WHERE role = 'admin' OR can_access_commission = 1`);
  },
};
