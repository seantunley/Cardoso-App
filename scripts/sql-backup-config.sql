-- Cardoso — SQL Server backup configuration (per site).
--
-- Run ONCE per site in SSMS (New Query → paste → F5), AFTER Ola Hallengren's
-- solution is installed on that instance (see docs/sql-backup-setup.md step 2).
-- Idempotent — safe to re-run.
--
-- What it does:
--   1. Sets the three databases to SIMPLE recovery. A nightly backup is the
--      recovery point; we don't need minute-level point-in-time, so SIMPLE
--      avoids transaction-log growth and log-backup management.
--   2. Reconfigures Ola's jobs as weekly FULL (Sunday) + nightly DIFF (Mon–Sat),
--      writing compressed .bak into the folder the Kopia agent already snapshots
--      off-site. Full is ~10GB (compressed, can't store uncompressed at 134GB),
--      so nightly DIFFs keep the off-site upload small; Kopia dedups + GFS-
--      retains from the hub.
--   9-day (@CleanupTime=220h) local retention keeps `full + latest diff` on the
--   box for restore; Kopia holds the long-tail off-site.
--
-- ⚠ Confirm the database names below match THIS site before running.

SET NOCOUNT ON;

/* ---- 1. Recovery models: all three SIMPLE ---- */
IF DB_ID('CARSYS')  IS NOT NULL AND (SELECT recovery_model_desc FROM sys.databases WHERE name = 'CARSYS')  <> 'SIMPLE' ALTER DATABASE CARSYS  SET RECOVERY SIMPLE;
IF DB_ID('CARDAT')  IS NOT NULL AND (SELECT recovery_model_desc FROM sys.databases WHERE name = 'CARDAT')  <> 'SIMPLE' ALTER DATABASE CARDAT  SET RECOVERY SIMPLE;
IF DB_ID('PPDdata') IS NOT NULL AND (SELECT recovery_model_desc FROM sys.databases WHERE name = 'PPDdata') <> 'SIMPLE' ALTER DATABASE PPDdata SET RECOVERY SIMPLE;
GO

USE msdb;
GO

/* ---- 2a. FULL job → weekly Sunday 01:00 ---- */
EXEC dbo.sp_update_jobstep
  @job_name = N'DatabaseBackup - USER_DATABASES - FULL', @step_id = 1,
  @command  = N'EXECUTE dbo.DatabaseBackup @Databases = ''CARDAT,CARSYS,PPDdata'', @Directory = ''C:\Cardoso Customer App\database\sql-backups'', @BackupType = ''FULL'', @Compress = ''Y'', @Verify = ''Y'', @CheckSum = ''Y'', @CleanupTime = 220, @LogToTable = ''Y''';

-- drop the default daily schedule if it's still attached
IF EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Daily-0100')
  EXEC dbo.sp_detach_schedule @job_name = N'DatabaseBackup - USER_DATABASES - FULL', @schedule_name = N'Daily-0100', @delete_unused_schedule = 1;

IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Weekly-Sun-0100')
  EXEC dbo.sp_add_schedule @schedule_name = N'Weekly-Sun-0100', @freq_type = 8, @freq_interval = 1, @freq_recurrence_factor = 1, @active_start_time = 010000;

IF NOT EXISTS (
  SELECT 1 FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name = N'DatabaseBackup - USER_DATABASES - FULL' AND s.name = N'Weekly-Sun-0100')
  EXEC dbo.sp_attach_schedule @job_name = N'DatabaseBackup - USER_DATABASES - FULL', @schedule_name = N'Weekly-Sun-0100';

/* ---- 2b. DIFF job → nightly Mon–Sat 01:00 ---- */
EXEC dbo.sp_update_jobstep
  @job_name = N'DatabaseBackup - USER_DATABASES - DIFF', @step_id = 1,
  @command  = N'EXECUTE dbo.DatabaseBackup @Databases = ''CARDAT,CARSYS,PPDdata'', @Directory = ''C:\Cardoso Customer App\database\sql-backups'', @BackupType = ''DIFF'', @Compress = ''Y'', @Verify = ''Y'', @CheckSum = ''Y'', @CleanupTime = 220, @LogToTable = ''Y''';

IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Weekly-MonSat-0100')
  EXEC dbo.sp_add_schedule @schedule_name = N'Weekly-MonSat-0100', @freq_type = 8, @freq_interval = 126, @freq_recurrence_factor = 1, @active_start_time = 010000;

IF NOT EXISTS (
  SELECT 1 FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name = N'DatabaseBackup - USER_DATABASES - DIFF' AND s.name = N'Weekly-MonSat-0100')
  EXEC dbo.sp_attach_schedule @job_name = N'DatabaseBackup - USER_DATABASES - DIFF', @schedule_name = N'Weekly-MonSat-0100';
GO

PRINT 'SQL backup config applied: CARDAT/CARSYS/PPDdata SIMPLE; FULL weekly (Sun 01:00) + DIFF nightly (Mon-Sat 01:00), 9-day local retention.';
