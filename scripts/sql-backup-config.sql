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
--      (Saturday 22:00) + nightly DIFF (Sun–Fri 01:00) — writing compressed .bak
--      into the folder the Kopia agent already snapshots off-site. Full is ~10GB
--      (compressed, can't store uncompressed at 134GB), so nightly DIFFs keep
--      the off-site upload small; Kopia dedups + GFS-retains from the hub. Both
--      jobs finish before the 02:30 Kopia snapshot so no .bak is captured
--      mid-write.
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

/* Drop Ola's default daily schedule ONLY if it is actually attached to @full
   (a shared 'Daily-0100' might belong to another Agent job — detaching from a
   job it isn't on would error and stop the script). */
IF EXISTS (
  SELECT 1 FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name = @full AND s.name = N'Daily-0100')
  EXEC dbo.sp_detach_schedule @job_name = @full, @schedule_name = N'Daily-0100', @delete_unused_schedule = 1;

/* Timing invariant: both jobs must FINISH before the Kopia agent snapshots the
   app folder at 02:30 (scripts/kopia-agent-setup.ps1), or the snapshot could
   capture a .bak mid-write. The DIFF is small and runs 01:00 (done in minutes).
   The weekly FULL is ~10GB (from a 134GB DB) + verify, so it runs SATURDAY 22:00
   — ~4.5h of headroom before the Sunday 02:30 snapshot carries the finished
   file off-site. */

/* FULL → weekly Saturday 22:00 (freq_type 8 = weekly, freq_interval 64 = Sat). */
IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Weekly-Sat-2200')
  EXEC dbo.sp_add_schedule @schedule_name = N'Weekly-Sat-2200', @freq_type = 8, @freq_interval = 64, @freq_recurrence_factor = 1, @active_start_time = 220000;
IF NOT EXISTS (
  SELECT 1 FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name = @full AND s.name = N'Weekly-Sat-2200')
  EXEC dbo.sp_attach_schedule @job_name = @full, @schedule_name = N'Weekly-Sat-2200';

/* DIFF → nightly Sun–Fri 01:00 (freq_interval 63 = Sun..Fri bitmask; Saturday is
   excluded because the FULL already covers Saturday night). */
IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Daily-SunFri-0100')
  EXEC dbo.sp_add_schedule @schedule_name = N'Daily-SunFri-0100', @freq_type = 8, @freq_interval = 63, @freq_recurrence_factor = 1, @active_start_time = 010000;
IF NOT EXISTS (
  SELECT 1 FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name = @diff AND s.name = N'Daily-SunFri-0100')
  EXEC dbo.sp_attach_schedule @job_name = @diff, @schedule_name = N'Daily-SunFri-0100';
GO

PRINT 'SQL backup config applied: CARDAT/CARSYS/PPDdata SIMPLE; FULL weekly (Sat 22:00) + DIFF nightly (Sun-Fri 01:00), 9-day local retention. Both finish before the 02:30 Kopia snapshot.';
