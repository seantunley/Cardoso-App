# SQL Server backups → off-site (per-site runbook)

Back up the site's SQL Server databases (Sage: **CARDAT**, **CARSYS**, **PPDdata**)
and carry them **off-site to the hub, deduped, with Grandfather-Father-Son
retention** — reusing the Kopia agent already deployed for the app-DB off-site
backup. Ola Hallengren makes the SQL backups; Kopia does the copy + dedup + GFS.

**Design (why this shape):**
- The company DB is ~134 GB → the compressed `.bak` is ~10 GB, and it can't be
  stored uncompressed on the box. So **backup compression stays on.**
- Compressed fulls **dedup poorly** in Kopia, so a nightly *full* would push
  ~10 GB off-site every night. Instead: **weekly FULL (Saturday) + DIFF (Mon–Fri
  01:00).** The diff is only what changed that day — small — so the nightly
  off-site upload is small; the 10 GB full moves once a week. No weekend diffs:
  staff don't work weekends, so nothing changes Sat/Sun.
- **The fulls are staggered so they don't crush the hub uplink.** The ~10 GB full
  uploads to the hub when Kopia snapshots, and every site pushes to the *same* hub
  line. If all sites did their full at once, the line would saturate. So each site
  does its full **Saturday in its own 3-hour slot**, and its **Kopia snapshot runs
  ~1.5 h after** — only one site pushes a full at a time. Saturday works because
  no one's working, so the daytime slots are free.

  | Slot | Site | SQL full (Sat) | Kopia snapshot |
  |---|---|---|---|
  | 1 | Pretoria | 01:00 | 02:30 |
  | 2 | Ermelo | 04:00 | 05:30 |
  | 3 | Johannesburg | 07:00 | 08:30 |
  | 4 | Klerksdorp | 10:00 | 11:30 |
  | 5 | Polokwane | 13:00 | 14:30 |
  | 6 | Welkom | 16:00 | 17:30 |

  The daily **diffs** are tiny (Kopia dedups them), so they don't need staggering —
  they all run 01:00 and the snapshot carries them at the site's usual time.
- The `.bak`s land in `C:\Cardoso Customer App\database\sql-backups`, which is
  **inside the folder the Kopia agent snapshots** and **not** in `.kopiaignore`,
  so they ride off-site automatically. Kopia dedups + GFS-retains from the hub;
  the site keeps **9 days** locally (`full + latest diff` for restore).
- All three DBs are set to **SIMPLE** recovery — a nightly backup is the recovery
  point, no minute-level point-in-time, no transaction-log management.

**Prerequisite:** the site's **Kopia agent is already set up** (its off-site tile
is green on the Hub Backups page). If not, do that first (`docs/kopia-backups.md`).

**Per-site variables:** the site **slug**, its **Saturday slot** (the full's
`@fullTime` + matching Kopia snapshot time, table above), and the **Sage SQL
instance**. The Sage instance is often a *named* instance (e.g.
`CARDOSOCISERVER\SQLEXPRESS`), **not** the default `localhost` — get the exact
`host\instance` from the site's Sage connection (Settings → Connections, or
`docs/operator-runbook.md`) and use it in steps 1–3. Installing into the wrong
instance is the usual cause of step 3 aborting with *"DatabaseBackup not
installed"*. DB names and paths are otherwise the same across the estate —
confirm the DB names per site if any differ.

> **Remote Sage box?** If the Sage SQL Server runs on a *different machine* from
> the Cardoso app, its `.bak` folder lands on that machine, which the Kopia agent
> (on the app box) doesn't snapshot. Then either back up to a UNC share on the app
> box (grant the SQL service account write to it and use that path below), or run
> a Kopia agent on the SQL box. The common case is a **local named instance**
> (same box), where the paths below work as-is.

---

## Per site — 5 steps

### 1. Backup folder + permission (PowerShell, admin, on the site)
SQL Server writes backups as its **service account**, not you — grant it write,
or the backup silently fails.
```powershell
$d = "C:\Cardoso Customer App\database\sql-backups"
New-Item -ItemType Directory $d -Force | Out-Null
# The SQL service account depends on the instance:
#   default instance (MSSQLSERVER) → 'NT SERVICE\MSSQLSERVER'
#   named instance <NAME>          → 'NT SERVICE\MSSQL$<NAME>'  e.g. MSSQL$SQLEXPRESS
#   a named/domain service account → grant THAT account instead.
# (single quotes so PowerShell doesn't treat $<NAME> as a variable)
icacls $d /grant 'NT SERVICE\MSSQL$SQLEXPRESS:(OI)(CI)M'   # ← match THIS site's instance
```

### 2. Install Ola Hallengren's backup **procedures** (PowerShell, via dbatools)
Procedures only — **no `-InstallJobs`**. Current dbatools rejects `-InstallJobs`
with any `-Solution` other than `All` (*"Jobs can only be created for all
solutions"*), and we don't want the IndexOptimize/IntegrityCheck jobs anyway —
`scripts/sql-backup-config.sql` creates exactly the two backup jobs we need.
**Install into THIS site's Sage instance** (`-SqlInstance`), not `localhost` —
otherwise Ola lands in the wrong instance and step 3 aborts.
```powershell
Install-Module dbatools -Scope AllUsers -Force        # once per box; needs internet
$SqlInstance = "CARDOSOCISERVER\SQLEXPRESS"            # ← this site's Sage instance (or 'localhost')
Install-DbaMaintenanceSolution -SqlInstance $SqlInstance `
  -Database master `
  -BackupLocation "C:\Cardoso Customer App\database\sql-backups" `
  -CleanupTime 220 `
  -Solution Backup
```
This installs the `DatabaseBackup` procedure + `CommandLog` table in `master` **on
that instance**. (Offline box: download `MaintenanceSolution.sql` from
https://ola.hallengren.com, set `@CreateJobs='N'`, and run it against `master` on
the **Sage instance** in SSMS.)

### 3. Recovery models + scheduling (SSMS)
**Connect SSMS to the same Sage instance** as step 2 (`host\instance`, not
`localhost`) — the script's first guard checks Ola's `DatabaseBackup` proc exists
*on the connected instance*, so a wrong connection is what makes it abort.

**First, check the edition** — it decides how the backups get scheduled:
```sql
SELECT SERVERPROPERTY('Edition') AS edition, SERVERPROPERTY('EngineEdition') AS engine;
-- EngineEdition 2 = Standard, 3 = Enterprise, 4 = EXPRESS.
```
Express has **no SQL Server Agent**, so it can't use Agent jobs — use **3b**.
Everything else uses **3a**. (Edition, not the instance name: an instance *named*
`SQLEXPRESS` that is really Standard reports engine 2 and uses 3a.)

#### 3a. Standard / Enterprise (SQL Agent)
Open `scripts/sql-backup-config.sql`, **set `@fullTime` to this site's Saturday
slot** (the table above — e.g. Ermelo `040000`), **confirm the DB names**, run it
(F5). It sets all three DBs to SIMPLE and **creates + configures** the two Agent
jobs — **FULL Saturday @fullTime** + **DIFF Mon–Fri 01:00** with 9-day local
retention. Re-runnable — changing `@fullTime` and re-running re-times the full.

#### 3b. Express (no Agent → Windows Task Scheduler + sqlcmd)
On Express the config script sets the recovery models and then **stops** (it
prints that it made no jobs). Schedule the two backups with Task Scheduler instead
(PowerShell, admin). Express can't compress, so `@Compress` is omitted — its `.bak`
are uncompressed (bounded: Express caps each DB at 10 GB), and Kopia still dedups
them off-site.
```powershell
$inst = "CARDOSOCISERVER\SQLEXPRESS"                    # this site's Express instance
$dir  = "C:\Cardoso Customer App\database\sql-backups"
$common = "@Databases='CARDAT,CARSYS,PPDdata', @Directory='$dir', @Verify='Y', @CheckSum='Y', @CleanupTime=220, @LogToTable='Y'"

# FULL — Saturday at this site's slot
$full = New-ScheduledTaskAction -Execute 'sqlcmd.exe' `
  -Argument "-S `"$inst`" -E -b -Q `"EXEC master.dbo.DatabaseBackup @BackupType='FULL', $common`""
Register-ScheduledTask -TaskName 'CardosoSqlBackupFull' -Force -RunLevel Highest -User 'SYSTEM' `
  -Action $full -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At '01:00')  # ← slot

# DIFF — Mon–Fri 01:00
$diff = New-ScheduledTaskAction -Execute 'sqlcmd.exe' `
  -Argument "-S `"$inst`" -E -b -Q `"EXEC master.dbo.DatabaseBackup @BackupType='DIFF', $common`""
Register-ScheduledTask -TaskName 'CardosoSqlBackupDiff' -Force -RunLevel Highest -User 'SYSTEM' `
  -Action $diff -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At '01:00')
```
> ⚠ The task runs as **SYSTEM**, which must be a **sysadmin** on the instance.
> Ola's `DatabaseBackup` requires sysadmin when run outside SQL Agent (see Ola's
> [permissions FAQ](https://ola.hallengren.com/frequently-asked-questions.html#permissions))
> — `db_backupoperator` is **not** enough and the tasks will fail. If SYSTEM isn't
> sysadmin, either run the task as the SQL service account (which is), or in SSMS:
> `CREATE LOGIN [NT AUTHORITY\SYSTEM] FROM WINDOWS; ALTER SERVER ROLE sysadmin ADD MEMBER [NT AUTHORITY\SYSTEM];`
> Verify by running the FULL task once (step 5) and checking a `.bak` appears.

If CARSYS (or any DB) was in FULL recovery its log may be bloated — reclaim it:
```sql
USE CARSYS; DBCC SHRINKFILE (2, 200);   -- file 2 is the log on a standard DB
```

### 4. Kopia: staggered snapshot time + GFS retention (PowerShell, admin)
**a) Move this site's snapshot to its slot** (~1.5 h after the full — the table
above), so only one site pushes its full up the hub line at a time:
```powershell
Set-ScheduledTask -TaskName 'CardosoKopiaAgent' `
  -Trigger (New-ScheduledTaskTrigger -Daily -At '05:30')   # ← this site's push time
```

**b) GFS retention.**
> ⚠ **Run kopia as the account the agent uses.** The repository connection is
> cached **per Windows user**, and the `CardosoKopiaAgent` task runs as **SYSTEM**
> (see `scripts/kopia-agent-setup.ps1`). An interactive admin shell is *not*
> connected — a raw `kopia …` there fails with *"repository not connected."* Run
> kopia commands **as SYSTEM** via PsExec:
```powershell
# -s = run as SYSTEM (the connected account); PsExec64 from Sysinternals.
PsExec64.exe -s "C:\Cardoso Customer App\kopia\kopia.exe" policy set `
  "cardoso@<SLUG>:C:\Cardoso Customer App" `
  --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --keep-annual 3
```
`keep-daily`=son · `keep-weekly`=father · `keep-monthly`=grandfather · +annual long-tail.

### 5. Seed the baseline + verify
Run the FULL once for the off-site baseline, wait for it to finish, then push it
by triggering the Kopia task (SYSTEM + already connected — no PsExec needed):
```powershell
# Run the full once:
#   3a (Agent):   in SSMS right-click 'DatabaseBackup - USER_DATABASES - FULL' → Start Job
#   3b (Express): Start-ScheduledTask -TaskName 'CardosoSqlBackupFull'
# Wait for it to finish (a .bak appears under database\sql-backups), then:
Start-ScheduledTask -TaskName 'CardosoKopiaAgent'
```
(If you must snapshot by hand instead, run it as SYSTEM:
`PsExec64.exe -s "C:\Cardoso Customer App\kopia\kopia.exe" snapshot create "C:\Cardoso Customer App"`.)

On the hub → **Backups → the site → View snapshots**: the newest snapshot should
be bigger (it swept up the `.bak`s), and the **SQL backups off-site** panel (top
of that dialog) should list CARDAT/CARSYS/PPDdata and turn green.

> This panel + the fleet-row SQL dot come from the off-site SQL-verify feature
> (**PR #522**), which reads the `.bak` files *inside the Kopia snapshot* — not
> the site-polled "SQL Server (DAT)" layer, which tracks SQLBackupAndFTP and stays
> N/A for these Ola jobs. If #522 isn't deployed yet, verify instead by browsing
> the snapshot tree (**View snapshots → Browse**) to `database/sql-backups` and
> confirming today's `.bak` are there.

---

## Restore
Use **`Restore-DbaDatabase`** (dbatools) pointed at the backup folder — it resolves
the correct FULL + matching DIFF chain automatically, which is the safe path.

Restoring by hand, mind the chain: a DIFF only applies on top of the FULL it was
based on. With this schedule, between the Saturday FULL and the first weekday DIFF
the newest DIFF in the folder still belongs to the *previous* week's full, so
"latest full + latest diff" would be rejected (differential base ≠ chosen full).
Restore the chosen **FULL** (`WITH NORECOVERY`), then the **latest DIFF whose base
is that full** (`WITH RECOVERY`) — or the full **alone** (`WITH RECOVERY`) if no
diff on that full exists yet.

## Tuning (after the first week)
- **Nightly off-site cost** = the size difference between two consecutive Kopia
  snapshots (Hub → View snapshots). With diffs it should be small.
- Local disk tight? Lower `@CleanupTime` — but keep it **> 7 days** so the weekly
  full survives for the diff chain.
- Bigger daily churn than expected? The diff grows through the work week and
  resets at the **Saturday** full — that's normal.
