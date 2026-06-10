// Resolve how the backup-config endpoint exposes the .env file. Pure (reads only
// process.env) so it can be unit-tested without importing the backup route module
// (which prepares DB statements at load and needs a migrated DB). The endpoint in
// routes/backup.js imports it.
export function getBackupConfigExportMode() {
  const raw = String(process.env.BACKUP_CONFIG_EXPORT_MODE || '').trim().toLowerCase();
  if (['disabled', 'redacted', 'full'].includes(raw)) return raw;
  // Default to REDACTED everywhere. Returning the full unredacted .env
  // (SESSION_SECRET, ENCRYPTION_KEY) whenever NODE_ENV !== 'production' was a
  // footgun — a service started without NODE_ENV set would expose secrets over
  // the reporting-token-gated endpoint. Full/disabled now require an explicit
  // BACKUP_CONFIG_EXPORT_MODE opt-in (SEC-3).
  return 'redacted';
}
