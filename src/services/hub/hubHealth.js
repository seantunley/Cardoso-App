// Hub health-summary functions — turn raw per-site machine + backup
// snapshots into the rolled-up status that drives the hub dashboard
// tiles (ok / warning / critical / failed / stale / unavailable) and
// the "needs attention" badges.
//
// Carved out of src/routes/hub.js as part of the module split. These
// were closure helpers nested inside createHubRouter, which made them
// completely untestable — the only way to exercise the warning/
// critical thresholds was to mock the entire route handler. Pulling
// them into a pure module lets us pin the thresholds with unit tests
// so a future "let's bump the warning floor from 75% to 80%" can't
// silently change which sites the operator sees flagged red.

/**
 * @typedef {Object} SqlBackupHealth
 * @property {'ok'|'stale'|'failed'|'unavailable'} status
 * @property {boolean} needs_attention
 * @property {string|null} last_success_at  ISO timestamp of most-recent successful backup, or null
 *
 * @typedef {Object} MachineHealthSummary
 * @property {'ok'|'warning'|'critical'|'unavailable'} status
 * @property {boolean} needs_attention
 * @property {string[]} reasons             human-readable reasons that drove the status
 */

// Tile shows "stale" when the freshest successful backup is older
// than this. Aligned with the nightly backup cron — anything past
// 24h means at least one scheduled run was missed/failed.
const SQL_BACKUP_STALE_AGE_MS = 24 * 3600 * 1000;

// Machine-health thresholds. Critical promotes over warning; warning
// over ok. Tuned so a healthy site sits at "ok", a site under load
// shows "warning", and a site that's actually about to fall over shows
// "critical".
const CPU_WARNING_PERCENT = 75;
const CPU_CRITICAL_PERCENT = 90;
const MEMORY_WARNING_PERCENT = 80;
const MEMORY_CRITICAL_PERCENT = 90;
const DISK_WARNING_FREE_PERCENT = 20;
const DISK_CRITICAL_FREE_PERCENT = 10;

/**
 * Roll up a per-site SQL-backup snapshot into a health verdict for the
 * hub dashboard. "Unavailable" if the snapshot itself is missing/bad;
 * "failed" if any database in the snapshot reports !isSuccess; "stale"
 * if every successful backup is older than SQL_BACKUP_STALE_AGE_MS;
 * "ok" otherwise.
 *
 * @param {{
 *   ok?: boolean,
 *   databases?: Array<{ isSuccess?: boolean, backupAt?: string }>
 * } | null | undefined} sqlBackup
 * @returns {SqlBackupHealth}
 */
export function getSqlBackupHealth(sqlBackup) {
  if (!sqlBackup?.ok) {
    return { status: 'unavailable', needs_attention: true, last_success_at: null };
  }

  const databases = Array.isArray(sqlBackup.databases) ? sqlBackup.databases : [];
  if (databases.length === 0) {
    return { status: 'unavailable', needs_attention: true, last_success_at: null };
  }

  const successTimes = databases
    .filter((db) => db.isSuccess && db.backupAt)
    .map((db) => new Date(db.backupAt).getTime())
    .filter((value) => Number.isFinite(value));

  const latestSuccessMs = successTimes.length > 0 ? Math.max(...successTimes) : null;
  const latestSuccessAt = latestSuccessMs ? new Date(latestSuccessMs).toISOString() : null;
  const anyFailed = databases.some((db) => db.isSuccess === false);
  const stale = !latestSuccessMs || ((Date.now() - latestSuccessMs) > SQL_BACKUP_STALE_AGE_MS);

  return {
    status: anyFailed ? 'failed' : stale ? 'stale' : 'ok',
    needs_attention: anyFailed || stale,
    last_success_at: latestSuccessAt,
  };
}

/**
 * Roll up a per-site machine-health snapshot (CPU, memory, disks,
 * Cardoso service status) into a single verdict + list of reasons.
 * "Unavailable" if the snapshot itself is missing/bad; otherwise
 * starts at "ok" and promotes to "warning" or "critical" per the
 * thresholds above. Critical never demotes to warning.
 *
 * @param {{
 *   ok?: boolean,
 *   message?: string,
 *   cpu?: { usage_percent?: number },
 *   memory?: { used_percent?: number },
 *   disks?: Array<{ drive?: string, free_percent?: number }>,
 *   cardoso_service?: { present?: boolean, status?: string }
 * } | null | undefined} machineHealth
 * @returns {MachineHealthSummary}
 */
export function getMachineHealthSummary(machineHealth) {
  if (!machineHealth?.ok) {
    return {
      status: 'unavailable',
      needs_attention: true,
      reasons: [machineHealth?.message || 'Machine health unavailable'],
    };
  }

  const reasons = [];
  let status = 'ok';

  const promote = (nextStatus, reason) => {
    if (reason) reasons.push(reason);
    if (status === 'critical' || nextStatus === status) return;
    if (nextStatus === 'critical' || (nextStatus === 'warning' && status === 'ok')) {
      status = nextStatus;
    }
  };

  const cpuUsage = Number(machineHealth.cpu?.usage_percent);
  if (Number.isFinite(cpuUsage) && cpuUsage >= CPU_CRITICAL_PERCENT) promote('critical', `CPU ${cpuUsage.toFixed(1)}%`);
  else if (Number.isFinite(cpuUsage) && cpuUsage >= CPU_WARNING_PERCENT) promote('warning', `CPU ${cpuUsage.toFixed(1)}%`);

  const memoryUsed = Number(machineHealth.memory?.used_percent);
  if (Number.isFinite(memoryUsed) && memoryUsed >= MEMORY_CRITICAL_PERCENT) promote('critical', `RAM ${memoryUsed.toFixed(1)}% used`);
  else if (Number.isFinite(memoryUsed) && memoryUsed >= MEMORY_WARNING_PERCENT) promote('warning', `RAM ${memoryUsed.toFixed(1)}% used`);

  const disks = Array.isArray(machineHealth.disks) ? machineHealth.disks : [];
  disks.forEach((disk) => {
    const freePercent = Number(disk.free_percent);
    if (!Number.isFinite(freePercent)) return;
    const label = disk.drive || 'disk';
    if (freePercent <= DISK_CRITICAL_FREE_PERCENT) promote('critical', `${label} low space (${freePercent.toFixed(1)}% free)`);
    else if (freePercent <= DISK_WARNING_FREE_PERCENT) promote('warning', `${label} low space (${freePercent.toFixed(1)}% free)`);
  });

  const service = machineHealth.cardoso_service;
  if (service?.present && service.status && service.status !== 'Running') {
    promote('warning', `Cardoso service ${String(service.status).toLowerCase()}`);
  }

  return {
    status,
    needs_attention: status !== 'ok',
    reasons,
  };
}
