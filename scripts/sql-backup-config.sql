-- Cardoso — SQL Server backup configuration (per site).
--
-- Run ONCE per site in SSMS (New Query → paste → F5), AFTER Ola Hallengren's
-- backup PROCEDURES are installed on that instance (see docs/sql-backup-setup.md
-- step 2 — procedures only, no SQL Agent jobs). Idempotent — safe to re-run.
--
-- What it does:
--   1. Sets the three databases to SIMPLE recovery. A nightly backup is the
--      recovery point; we don't need minute-level point-in-time, so SIMPLE
--      avoids transaction-log growth and log-backup management.
--   2. CREATES (if missing) and configures the two backup jobs — weekly FULL
--      (Sunday) + nightly DIFF (Mon–Sat) — writing compressed .bak into the
--      folder the Kopia agent already snapshots off-site. Full is ~10GB
--      (compressed, can't store uncompressed at 134GB), so nightly DIFFs keep
--      the off-site upload small; Kopia dedups + GFS-retains from the hub.
--   9-day (@CleanupTime=220h) local retention keeps `full + latest diff` on the
--   box for restore; Kopia holds the long-tail off-site.
--
-- This script OWNS the jobs, so it does NOT depend on dbatools' -InstallJobs
-- (which current dbatools only allows with -Solution All). Installing Ola with
-- -Solution Backup gets the DatabaseBackup procedure + CommandLog table; the
-- jobs below are created here.
--
-- ⚠ Confirm the database names below match THIS site before running.

SET NOCOUNT ON;

/* ---- 1. Recovery models: all three SIMPLE ---- */
IF DB_ID('CARSYS')  IS NOT NULL AND (SELECT recovery_model_desc FROM sys.databases WHERE name = 'CARSYS')  <> 'SIMPLE' ALTER DATABASE CARSYS  SET RECOVERY SIMPLE;
IF DB_ID('CARDAT')  IS NOT NULL AND (SELECT recovery_model_desc FROM sys.databases WHERE name = 'CARDAT')  <> 'SIMPLE' ALTER DATABASE CARDAT  SET RECOVERY SIMPLE;
IF DB_ID('PPDdata') IS NOT NULL AND (SELECT recovery_model_desc FROM sys.databases WHERE name = 'PPDdata') <> 'SIMPLE' ALTER DATABASE PPDdata SET RECOVERY SIMPLE;
GO

/* ---- 2. Backup jobs: create if missing, then (re)configure the command ---- */
USE msdb;

-- Guard: the DatabaseBackup procedure must exist (Ola installed) or the jobs
-- would run but fail every night. Fail loudly now instead.
IF OBJECT_ID('master.dbo.DatabaseBackup') IS NULL
BEGIN
  RAISERROR('Ola Hallengren''s DatabaseBackup procedure is not installed in master. Run docs/sql-backup-setup.md step 2 first.', 16, 1);
  RETURN;
END

DECLARE @full  sysname       = N'DatabaseBackup - USER_DATABASES - FULL';
DECLARE @diff  sysname       = N'DatabaseBackup - USER_DATABASES - DIFF';
DECLARE @dir   nvarchar(4000) = N'C:\Cardoso Customer App\database\sql-backups';
DECLARE @dbs   nvarchar(4000) = N'CARDAT,CARSYS,PPDdata';
DECLARE @fullCmd nvarchar(max) = N'EXECUTE dbo.DatabaseBackup @Databases = ''' + @dbs + N''', @Directory = ''' + @dir + N''', @BackupType = ''FULL'', @Compress = ''Y'', @Verify = ''Y'', @CheckSum = ''Y'', @CleanupTime = 220, @LogToTable = ''Y''';
DECLARE @diffCmd nvarchar(max) = N'EXECUTE dbo.DatabaseBackup @Databases = ''' + @dbs + N''', @Directory = ''' + @dir + N''', @BackupType = ''DIFF'', @Compress = ''Y'', @Verify = ''Y'', @CheckSum = ''Y'', @CleanupTime = 220, @LogToTable = ''Y''';

/* FULL job */
IF NOT EXISTS (SELECT 1 FROM dbo.sysjobs WHERE name = @full)
BEGIN
  EXEC dbo.sp_add_job     @job_name = @full, @enabled = 1, @description = N'Cardoso SQL off-site backup (Ola Hallengren) — weekly FULL';
  EXEC dbo.sp_add_jobstep @job_name = @full, @step_name = N'Backup', @subsystem = N'TSQL', @database_name = N'master', @command = @fullCmd;
  EXEC dbo.sp_add_jobserver @job_name = @full;
END
ELSE
  EXEC dbo.sp_update_jobstep @job_name = @full, @step_id = 1, @database_name = N'master', @command = @fullCmd;

/* DIFF job */
IF NOT EXISTS (SELECT 1 FROM dbo.sysjobs WHERE name = @diff)
BEGIN
  EXEC dbo.sp_add_job     @job_name = @diff, @enabled = 1, @description = N'Cardoso SQL off-site backup (Ola Hallengren) — nightly DIFF';
  EXEC dbo.sp_add_jobstep @job_name = @diff, @step_name = N'Backup', @subsystem = N'TSQL', @database_name = N'master', @command = @diffCmd;
  EXEC dbo.sp_add_jobserver @job_name = @diff;
END
ELSE
  EXEC dbo.sp_update_jobstep @job_name = @diff, @step_id = 1, @database_name = N'master', @command = @diffCmd;

/* Drop Ola's default daily schedule if a pre-existing job still has it. */
IF EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Daily-0100')
  EXEC dbo.sp_detach_schedule @job_name = @full, @schedule_name = N'Daily-0100', @delete_unused_schedule = 1;

/* FULL → weekly Sunday 01:00 (freq_type 8 = weekly, freq_interval 1 = Sunday). */
IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Weekly-Sun-0100')
  EXEC dbo.sp_add_schedule @schedule_name = N'Weekly-Sun-0100', @freq_type = 8, @freq_interval = 1, @freq_recurrence_factor = 1, @active_start_time = 010000;
IF NOT EXISTS (
  SELECT 1 FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name = @full AND s.name = N'Weekly-Sun-0100')
  EXEC dbo.sp_attach_schedule @job_name = @full, @schedule_name = N'Weekly-Sun-0100';

/* DIFF → nightly Mon–Sat 01:00 (freq_interval 126 = Mon..Sat bitmask). */
IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Weekly-MonSat-0100')
  EXEC dbo.sp_add_schedule @schedule_name = N'Weekly-MonSat-0100', @freq_type = 8, @freq_interval = 126, @freq_recurrence_factor = 1, @active_start_time = 010000;
IF NOT EXISTS (
  SELECT 1 FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name = @diff AND s.name = N'Weekly-MonSat-0100')
  EXEC dbo.sp_attach_schedule @job_name = @diff, @schedule_name = N'Weekly-MonSat-0100';
GO

PRINT 'SQL backup config applied: CARDAT/CARSYS/PPDdata SIMPLE; FULL weekly (Sun 01:00) + DIFF nightly (Mon-Sat 01:00), 9-day local retention.';
