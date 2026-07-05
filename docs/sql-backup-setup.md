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

**Per-site variables:** the site **slug**, and its **Saturday slot** (the full's
`@fullTime` in the SQL script + the matching Kopia snapshot time — see the table
above). DB names and paths are the same across the estate — confirm the DB names
per site if any differ.

---

## Per site — 5 steps

### 1. Backup folder + permission (PowerShell, admin, on the site)
SQL Server writes backups as its **service account**, not you — grant it write,
or the backup silently fails.
```powershell
$d = "C:\Cardoso Customer App\database\sql-backups"
New-Item -ItemType Directory $d -Force | Out-Null
icacls $d /grant "NT SERVICE\MSSQLSERVER:(OI)(CI)M"
# If SQL runs under a named/domain service account, grant THAT account instead.
```

### 2. Install Ola Hallengren's backup **procedures** (PowerShell, via dbatools)
Procedures only — **no `-InstallJobs`**. Current dbatools rejects `-InstallJobs`
with any `-Solution` other than `All` (*"Jobs can only be created for all
solutions"*), and we don't want the IndexOptimize/IntegrityCheck jobs anyway —
`scripts/sql-backup-config.sql` creates exactly the two backup jobs we need.
```powershell
Install-Module dbatools -Scope AllUsers -Force        # once per box; needs internet
Install-DbaMaintenanceSolution -SqlInstance localhost `
  -Database master `
  -BackupLocation "C:\Cardoso Customer App\database\sql-backups" `
  -CleanupTime 220 `
  -Solution Backup
```
This installs the `DatabaseBackup` procedure + `CommandLog` table in `master`.
(Offline box: download `MaintenanceSolution.sql` from https://ola.hallengren.com,
set `@CreateJobs='N'` and run it against `master` in SSMS.)

### 3. Recovery models + backup jobs (SSMS)
Open `scripts/sql-backup-config.sql`, **set `@fullTime` to this site's Saturday
slot** (the table above — e.g. Ermelo `040000`), **confirm the DB names**, run it
(F5). It sets all three DBs to SIMPLE and **creates + configures** the two Agent
jobs — **FULL Saturday @fullTime** + **DIFF Mon–Fri 01:00** with 9-day local
retention. (It's the script — not dbatools — that creates the jobs, so it's fine
that step 2 installed procedures only. Re-runnable — changing `@fullTime` and
re-running re-times the full.)

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
Run the FULL job once for the off-site baseline, then push it by **triggering the
registered agent task** (it runs as SYSTEM and is already connected — no PsExec
needed, and it's exactly what runs nightly):
```powershell
# in SSMS: right-click 'DatabaseBackup - USER_DATABASES - FULL' → Start Job; wait
#   for it to finish (Job Activity Monitor), then on the site:
Start-ScheduledTask -TaskName 'CardosoKopiaAgent'
```
(If you must snapshot by hand instead, run it as SYSTEM:
`PsExec64.exe -s "C:\Cardoso Customer App\kopia\kopia.exe" snapshot create "C:\Cardoso Customer App"`.)

On the hub → **Backups → the site → View snapshots**: the newest snapshot should
be bigger (it swept up the `.bak`s), and the **SQL backups** panel should turn
green. That confirms SQL is going off-site.

---

## Restore
Latest **FULL** + latest **DIFF**. `Restore-DbaDatabase` (dbatools) resolves the
chain automatically from the backup folder, or restore manually: full first
(`WITH NORECOVERY`), then the diff (`WITH RECOVERY`).

## Tuning (after the first week)
- **Nightly off-site cost** = the size difference between two consecutive Kopia
  snapshots (Hub → View snapshots). With diffs it should be small.
- Local disk tight? Lower `@CleanupTime` — but keep it **> 7 days** so the weekly
  full survives for the diff chain.
- Bigger daily churn than expected? The diff grows through the work week and
  resets at the **Saturday** full — that's normal.
