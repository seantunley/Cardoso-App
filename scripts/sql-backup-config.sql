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
--      (Saturday, per-site staggered slot) + DIFF (Mon–Fri 01:00) — writing
--      compressed .bak into the folder the Kopia agent already snapshots off-site.
--      Full is ~10GB (compressed, can't store uncompressed at 134GB), so DIFFs
--      keep the off-site upload small; Kopia dedups + GFS-retains from the hub.
--      Set @fullTime per site (below) so the sites don't all push their full up
--      the hub line at once; the Kopia snapshot runs ~1.5h after the full slot.
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
-- would run but fail every night. Fail loudly now instead. Names the connected
-- instance so a wrong-instance connection (the common cause on named/remote Sage
-- instances) is obvious rather than a bare "not installed".
IF OBJECT_ID('master.dbo.DatabaseBackup') IS NULL
BEGIN
  DECLARE @guardMsg nvarchar(600) = N'Ola Hallengren''s DatabaseBackup procedure is not installed in master on THIS instance (' + @@SERVERNAME + N'). Either run docs/sql-backup-setup.md step 2, or you are connected to the WRONG instance — connect SSMS to this site''s Sage instance (host\instance, not localhost).';
  RAISERROR(@guardMsg, 16, 1);
  RETURN;
END

/* ══════════════════════════════════════════════════════════════════════════
   ⚠ SET THIS PER SITE — the weekly FULL's Saturday start time (HHMMSS as int).
   Every site's full runs SATURDAY but in its own 3-hour slot, so only one site
   pushes its ~10GB full up the hub line at a time. Set each site's Kopia snapshot
   (scripts/kopia-agent-setup.ps1 -SnapshotTime) ~1.5h AFTER this. Slots:
       Pretoria     010000   (Kopia push 02:30)
       Ermelo       040000   (Kopia push 05:30)
       Johannesburg 070000   (Kopia push 08:30)
       Klerksdorp   100000   (Kopia push 11:30)
       Polokwane    130000   (Kopia push 14:30)
       Welkom       160000   (Kopia push 17:30)
   ══════════════════════════════════════════════════════════════════════════ */
DECLARE @fullTime int = 010000;   -- ← change per site (see table above)

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

/* Timing / bandwidth design:
     • FULL runs SATURDAY at @fullTime — staff don't work weekends, so Saturday
       daytime is free of both DB load and hub traffic. Each site gets its own
       Saturday slot (staggered 3h apart) so only ONE site pushes its ~10GB full
       up the hub line at a time; its Kopia snapshot is set ~1.5h after @fullTime.
     • DIFF runs MON–FRI 01:00, small (done in minutes, dedup'd — no staggering
       needed). No weekend diffs: nothing changes Sat/Sun; the Saturday full is
       the weekend recovery point and Monday's diff picks up the new week. */

/* Retire ANY schedule attached to our two jobs that isn't the canonical one, so
   re-running — or a site first set up under an earlier schedule (e.g. Pretoria) —
   can't leave a job DOUBLE-scheduled. Detach is per-row, hence the cursor. */
DECLARE @cjob sysname, @csched sysname;
DECLARE cleanup CURSOR LOCAL FAST_FORWARD FOR
  SELECT j.name, s.name
  FROM dbo.sysjobschedules js
  JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id
  JOIN dbo.sysjobs j ON js.job_id = j.job_id
  WHERE j.name IN (@full, @diff)
    AND s.name NOT IN (N'Cardoso-Full-Sat', N'Cardoso-Diff-MonFri');
OPEN cleanup; FETCH NEXT FROM cleanup INTO @cjob, @csched;
WHILE @@FETCH_STATUS = 0
BEGIN
  EXEC dbo.sp_detach_schedule @job_name = @cjob, @schedule_name = @csched, @delete_unused_schedule = 1;
  FETCH NEXT FROM cleanup INTO @cjob, @csched;
END
CLOSE cleanup; DEALLOCATE cleanup;

/* FULL → Saturday @fullTime (freq_type 8 = weekly, freq_interval 64 = Saturday).
   sp_update_schedule keeps the per-site time current when the script is re-run
   with a different @fullTime. */
IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Cardoso-Full-Sat')
  EXEC dbo.sp_add_schedule @schedule_name = N'Cardoso-Full-Sat', @freq_type = 8, @freq_interval = 64, @freq_recurrence_factor = 1, @active_start_time = @fullTime;
ELSE
  EXEC dbo.sp_update_schedule @name = N'Cardoso-Full-Sat', @active_start_time = @fullTime;
IF NOT EXISTS (SELECT 1 FROM dbo.sysjobschedules js JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id JOIN dbo.sysjobs j ON js.job_id = j.job_id WHERE j.name = @full AND s.name = N'Cardoso-Full-Sat')
  EXEC dbo.sp_attach_schedule @job_name = @full, @schedule_name = N'Cardoso-Full-Sat';

/* DIFF → Mon–Fri 01:00 (freq_interval 62 = Mon..Fri bitmask). */
IF NOT EXISTS (SELECT 1 FROM dbo.sysschedules WHERE name = N'Cardoso-Diff-MonFri')
  EXEC dbo.sp_add_schedule @schedule_name = N'Cardoso-Diff-MonFri', @freq_type = 8, @freq_interval = 62, @freq_recurrence_factor = 1, @active_start_time = 010000;
IF NOT EXISTS (SELECT 1 FROM dbo.sysjobschedules js JOIN dbo.sysschedules s ON js.schedule_id = s.schedule_id JOIN dbo.sysjobs j ON js.job_id = j.job_id WHERE j.name = @diff AND s.name = N'Cardoso-Diff-MonFri')
  EXEC dbo.sp_attach_schedule @job_name = @diff, @schedule_name = N'Cardoso-Diff-MonFri';

-- Success message stays INSIDE this batch (before the GO) so the guard's RETURN
-- above skips it: a skipped/failed Ola install must NOT print "config applied".
PRINT 'SQL backup config applied: CARDAT/CARSYS/PPDdata SIMPLE; FULL Saturday (per-site slot) + DIFF Mon-Fri 01:00, 9-day local retention. Set the Kopia snapshot ~1.5h after the full slot.';
GO
