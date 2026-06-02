import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // hub_audit_log was a parallel audit surface that mirrored
      // every hub admin action already captured in `auditlog` (see
      // PR #262 commit message). The dual-write was not actually
      // adding information — every logHubAudit call was paired
      // with a logAudit call writing a hub_*-prefixed action_type
      // to the canonical auditlog table, so the hub_audit_log page
      // was a strict subset of the System Audit Log filtered to
      // `action_type LIKE 'hub_%'`. Removed the page, the writer,
      // the route, and the can_access_hub_audit_log permission;
      // this migration drops the now-dead table.
      //
      // No data loss: every row in hub_audit_log has a corresponding
      // row in auditlog with the same actor + target + timestamp
      // (within milliseconds — the two writes were sequential at
      // the call site). DROP TABLE leaves disk pages dormant until
      // the next VACUUM (see the v66 comment for reclamation cadence).
      version: 67,
      name: 'drop_defunct_hub_audit_log',
      up(db) {
        db.exec('DROP TABLE IF EXISTS hub_audit_log');
      },
    };
