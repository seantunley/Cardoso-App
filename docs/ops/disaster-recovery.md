# Disaster Recovery — restoring a site from Hub backups

This runbook covers two recovery scenarios:

1. **Hot restore** — site machine is alive, but its data is corrupt or
   the operator wants to roll back. Use the Hub UI.
2. **Cold restore** — site machine is gone (dead disk, lost laptop,
   fresh Windows install). Use the manual restore script with a copy
   of the Hub's per-site backup folder.

Both paths restore the same set of artifacts:

| Artifact                   | Source on Hub                                                          | Lands at on the site                |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| `cardoso-<site>-<ts>.db`   | `database/hub-backups/<siteId>/cardoso-<siteId>-<ts>.db`               | `<AppDir>/database/cardoso.db`      |
| `config-<site>-<ts>.env`   | `database/hub-backups/<siteId>/config-<siteId>-<ts>.env`               | `<AppDir>/.env`                     |
| `bat-previews-<site>-<ts>.zip` | `database/hub-backups/<siteId>/bat-previews-<siteId>-<ts>.zip`     | `<AppDir>/uploads/bat-previews/`    |
| `jti-archive-<site>-<ts>.zip`  | `database/hub-backups/<siteId>/jti-archive-<siteId>-<ts>.zip`      | `<AppDir>/uploads/jti-archive/`     |
| `bat-archive-<site>-<ts>.zip`  | `database/hub-backups/<siteId>/bat-archive-<siteId>-<ts>.zip`      | `<AppDir>/uploads/bat-archive/`     |

All five files share the same `-YYYY-MM-DD-HH-MM-SS` timestamp suffix —
the Hub pulls them as a set during its hourly backup cron.

## What's NOT in a backup

- **Source PDFs** referenced by `bat_invoice_extractions.pdf_url`. These
  point to remote URLs (Drive/SharePoint) — the bytes were never on the
  site. As long as the remote source still resolves, you don't need
  them. Preview JPEGs in the backup are sufficient for the UI to show
  what was OCR'd.
- **Application code**. Reinstall via `git clone` + `npm install` +
  `npm run build`, or via the standard Windows installer.
- **Node runtime / NSSM service wrapper**. Reinstalled by the standard
  install scripts.
- **The Hub itself**. If the Hub dies, every site loses its off-machine
  backup. The Hub's own `database/cardoso.db` should be backed up to a
  separate location (cloud, NAS) — that backup also restores the
  `hub-backups/` directory contents if the Hub disk itself is lost.

## Hot restore — alive site, push from Hub UI

Use this when the site machine is up and reachable from the Hub but its
data is bad (corruption, accidental delete, botched re-extract).

1. **Hub UI** → Hub Admin → Sites → pick the site → **Restore**.
2. Pick the snapshot you want to push back. The list shows companion
   file presence (`previews`, `jti_archive`, `bat_archive`, `env`)
   alongside each snapshot — only checked items get restored.
3. Tick the include-* boxes for everything you want to push:
   - `include_previews` — previews zip
   - `include_jti_archive` — JTI export history
   - `include_bat_archive` — BAT supplier source files
   - `include_env` — site `.env` (encryption keys, secrets)
4. Enter your operator password and submit.
5. The Hub mints one-shot tokens, posts to the site's
   `POST /api/hub/restore`, the site downloads each artifact into
   `<AppDir>\.restore-staging\<restore_id>\`, and launches
   `apply-restore.ps1` via Windows Task Scheduler.
6. The script: stops the service → backs up live files to
   `*.before-restore-<ts>` → swaps in the snapshot files → runs
   `PRAGMA integrity_check` → starts the service → writes
   `<AppDir>\.last-restore-status.json`.
7. On any failure, the script automatically rolls back from the
   `.before-restore-<ts>` files. Service starts either way.
8. Watch the site tile in Hub UI — it'll go offline briefly then come
   back. Read `.last-restore-status.json` (or the Site Info tile) to
   confirm `state: "ok"`.

### What gets backed up before the swap

The restore script saves the live files aside before overwriting them so
nothing is unrecoverable:

- `cardoso.db` → `cardoso.db.before-restore-<unix>`
- `uploads/bat-previews/` → `uploads/bat-previews.before-restore-<unix>/`
- `uploads/jti-archive/` → `uploads/jti-archive.before-restore-<unix>/`
- `uploads/bat-archive/` → `uploads/bat-archive.before-restore-<unix>/`
- `.env` → `.env.before-restore-<unix>`

These stay on disk after a successful restore — delete manually once
you've confirmed the new state is good (e.g. one week later).

## Cold restore — site machine is gone

Use this when there's no live site to push to: a fresh Windows install,
a replacement laptop, a recovered-from-disk-failure box.

### Prerequisites

- A copy of the Hub's per-site backup folder (`database/hub-backups/<siteId>/`)
  reachable from the new machine. Options:
  - SSH/RDP into the Hub and copy via `xcopy` / `robocopy`.
  - Mount the Hub's disk as a network share.
  - USB drive or temporary file share.
- Node + npm installed on the new machine (any version supported by the
  app's `package.json`).
- The app source checked out: `git clone <repo>` + `npm install`
  + `npm run build`. (Restore lays files into the install dir; the dir
  needs to exist with at least `node_modules/` populated.)

### Steps

1. **Check the backup folder is complete** — list files:

   ```powershell
   Get-ChildItem "Z:\hub-backups\<siteId>" | Sort-Object LastWriteTime -Descending | Select-Object -First 10
   ```

   You should see at least one set with all 5 artifacts at a single
   timestamp. If the latest set is incomplete, pick the most recent
   complete one with `--at <YYYY-MM-DD-HH-MM-SS>` in step 3.

2. **Dry-run the restore** to confirm the script picks the right files:

   ```powershell
   node scripts\restore-site-from-hub-backups.mjs `
     --backups "Z:\hub-backups\<siteId>" `
     --target  "C:\Cardoso Customer App" `
     --dry-run
   ```

   Output shows which timestamp it selected and which companion files
   it found vs missing. Stop and investigate if anything important is
   marked `(missing)`.

3. **Run for real**:

   ```powershell
   node scripts\restore-site-from-hub-backups.mjs `
     --backups "Z:\hub-backups\<siteId>" `
     --target  "C:\Cardoso Customer App"
   ```

   The script:
   - Verifies `PRAGMA integrity_check` passes on the source `.db`.
   - Copies the `.db` into `<target>\database\cardoso.db` (clearing
     stale `.db-wal` / `.db-shm` sidecars).
   - Copies `.env` into `<target>\.env` (move the existing one aside
     first if present).
   - Unzips each archive into the corresponding `<target>\uploads\<name>\`.
   - Prints next steps.

4. **Sanity-check the restored `.env`** — the file is the snapshot from
   the Hub, which may have stale values for the new machine:
   - `SITE_ID` should match what the Hub knows the site as (otherwise
     subsequent backups will land in the wrong hub-backups subdir).
   - `HUB_URL` may need updating if the Hub moved.
   - `PORT` may conflict with something on the new machine.
   - `DB_PATH` if non-default.

5. **Install the service** (or run manually for first boot):

   ```powershell
   .\scripts\install-service.bat
   ```

6. **Smoke-test in the UI**:
   - Customers list loads (proves DB decryption works → `.env` correct).
   - Recent reconciliations show preview thumbnails (proves
     `bat-previews/` restored).
   - JTI history shows past monthly exports (proves `jti-archive/`
     restored).
   - BAT recon → click a row → "View original supplier file" works
     (proves `bat-archive/` restored).
   - Audit log has entries from before the restore.

7. **Confirm the new site rejoins backup rotation**:
   - Within an hour, the next Hub backup pull should succeed for this
     site (visible in Hub Admin → System Log under `[HUB BACKUP]`).
   - The new backup files appear in `database/hub-backups/<siteId>/`
     on the Hub.

### Manual fallback if the script fails

If `restore-site-from-hub-backups.mjs` errors (e.g. `better-sqlite3`
not installed, weird Windows permission), do the lay-down by hand:

```powershell
# DB
Copy-Item "Z:\hub-backups\<siteId>\cardoso-<siteId>-<TS>.db" `
  "C:\Cardoso Customer App\database\cardoso.db" -Force
Remove-Item "C:\Cardoso Customer App\database\cardoso.db-wal" -ErrorAction SilentlyContinue
Remove-Item "C:\Cardoso Customer App\database\cardoso.db-shm" -ErrorAction SilentlyContinue

# .env
Copy-Item "Z:\hub-backups\<siteId>\config-<siteId>-<TS>.env" `
  "C:\Cardoso Customer App\.env" -Force

# Each uploads/ archive
Expand-Archive "Z:\hub-backups\<siteId>\bat-previews-<siteId>-<TS>.zip" `
  -DestinationPath "C:\Cardoso Customer App\uploads\bat-previews" -Force
Expand-Archive "Z:\hub-backups\<siteId>\jti-archive-<siteId>-<TS>.zip" `
  -DestinationPath "C:\Cardoso Customer App\uploads\jti-archive" -Force
Expand-Archive "Z:\hub-backups\<siteId>\bat-archive-<siteId>-<TS>.zip" `
  -DestinationPath "C:\Cardoso Customer App\uploads\bat-archive" -Force
```

Then start the service.

## Troubleshooting

### "PRAGMA integrity_check FAILED" on the source `.db`

The selected snapshot is corrupt. Try the previous timestamp:

```powershell
node scripts\restore-site-from-hub-backups.mjs `
  --backups "Z:\hub-backups\<siteId>" `
  --target  "C:\Cardoso Customer App" `
  --at      "2026-05-12-02-00-00"
```

If multiple consecutive snapshots fail, the corruption pre-dates the
backup window — investigate the live DB at the time those backups were
taken. The Hub's `hub_backup_integrity` table records the integrity
verdict for every pulled snapshot; query it to find the most recent
clean one:

```sql
SELECT filename, result, created_at
FROM hub_backup_integrity
WHERE site_id = '<siteId>' AND result = 'ok'
ORDER BY created_at DESC LIMIT 5;
```

### Site comes up but customers/Sage queries fail with decryption errors

`ENCRYPTION_KEY` in the restored `.env` doesn't match the key the live
DB's `databaseconnection.encrypted_password` rows were encrypted with.
This usually means:

- The `.env` is from a different site (wrong `siteId` selected).
- The `.env` predates a key rotation. Find a newer `config-*.env` in
  the backup folder.
- The operator manually edited `ENCRYPTION_KEY` after the snapshot was
  taken. Restore the matching pair (snapshot DB + same-timestamp `.env`).

### Service starts but Hub backup pull keeps failing

The site's `REPORTING_TOKEN` (in `.env`) must match what the Hub has
stored in `hub_sites.token` for this site. After a cold restore, the
restored `.env` and the Hub's stored token agree by construction.
If they don't, the Hub UI → Sites → Edit lets you reset the site token
without disrupting the live DB.

### `.before-restore-<ts>` files are taking up disk

Safe to delete after one-week confidence in the restore. The hot-restore
script doesn't auto-prune these — the operator decides when to drop
them, since they're the rollback path if a problem surfaces later.

```powershell
Get-ChildItem "C:\Cardoso Customer App" -Filter "*.before-restore-*" -Recurse | Remove-Item -Recurse -Force
```

## Verification — periodic restore drill

Once a quarter, do an end-to-end cold restore drill against a throwaway
machine (or VM). The drill catches two failure modes that nothing else
will:

1. **Backup completeness regression** — a code change ships that stops
   one of the artifacts being included, but no test fails.
2. **Restore script regression** — node version changes, dependency
   bumps, or filesystem layout changes break the restore script in a
   way that only manifests on a fresh install.

Drill steps:

1. Spin up a fresh Windows VM. Install Node + clone the repo + `npm install`.
2. Copy the Hub's `database/hub-backups/<chosenSiteId>/` to the VM.
3. Run the cold-restore steps above.
4. Boot the service. Sanity-check items from step 6 of the cold-restore
   procedure.
5. Document anything that didn't work in the runbook.

The sanity checks deliberately cover all five artifacts — if any one
of the items fails, the corresponding artifact is broken.
