# Kopia off-site backups (site agent → hub server)

Status: **design + rollout runbook** (Stage 1). The code stages (hub-side
status/dashboard/alerts, then the site agent + installer wiring) land in
follow-up PRs, gated behind `KOPIA_ENABLED` so nothing changes until it's
switched on.

## Goal

Back up **everything needed to restore a site** — the database, `.env`, and all
durable `uploads/` data (BAT supplier spreadsheets, OCR POD previews, JTI
archives) — **off-site to the hub**, encrypted, deduplicated, with retention and
self-verification, and with **central visibility on the hub dashboard** so we
know each site's backup is actually working.

Reinstallable files (`node_modules/`, the bundled `node/` runtime, `dist/`,
`src/`, `*.exe`) are **excluded** — the installer recreates them. Restore = run
the same installer version, then drop the data back.

## Why a site agent talking to a hub server

Two requirements drove this shape:

- **"Everything in the folder"** — the dataset is large (GBs of PDFs/previews).
  A site-side Kopia **agent** snapshots the whole tree and ships only **changed
  blocks** (delta + dedup). Pulling all of it from the hub nightly would be full
  transfers every time — impractical.
- **"Most reliable + hub visibility"** — Kopia's **Repository Server mode** is
  the standard central model: the **hub runs the repository server**, every site
  **agent** connects to it, so the hub natively sees **every site's snapshot
  history**. A site that silently stops backing up is caught by a hub-side
  **"site stale" alert** — so the push model's classic blind spot is closed.

This is defense in depth on top of what already ships:

```
 local consistent snapshot (PR #499)         ← fast "restore yesterday", on-box
   +
 hub PULL of the .db + readable folders (PR #500)   ← independent hub-driven copy
   +
 Kopia agent → hub server (THIS)             ← full dataset, off-site, retained,
                                               verified, centrally monitored
   +
 (optional) hub repo → cloud (Part E)        ← survives losing the hub itself
```

## Architecture

```
 Shop PC (Windows)                              HUB (Windows)
 ─────────────────                              ─────────────
 kopia.exe (agent)                              kopia.exe + `kopia server start`  (NSSM: CardosoKopiaServer)
   scheduled task CardosoKopiaAgent  ──HTTPS──▶   repository  D:\kopia-repo
   daily: kopia snapshot create                    - per-site users + ACLs
     C:\Cardoso Customer App                        - client-side encrypted
     (ignore: node_modules, node, dist,             - block dedup across sites
      src, *.exe, logs, caches, live .db)           - retention policy
                                                     - kopia snapshot verify (weekly)
                                                          │
                                          (optional) kopia repository sync-to ▶ Backblaze B2 / S3
```

### Consistency of the live database

The live `database\cardoso.db` (+ `-wal`/`-shm`) must **not** be snapshotted
directly — under WAL it can be captured torn. Instead:

- The site's existing `runLocalBackup()` (02:00) writes a **consistent**
  `database\backups\cardoso-<site>-<ts>.db`.
- The agent snapshots **`database\backups\`** (and ignores `database\cardoso.db*`),
  so every Kopia snapshot contains a clean, restorable DB copy.
- `uploads\` is append-only (previews/archives written once), so it's
  snapshotted directly.

### Ignore rules (`.kopiaignore` at the app root)

```
/node_modules/
/node/
/dist/
/src/
/nssm/
/logs/
*.exe
/database/cardoso.db
/database/cardoso.db-wal
/database/cardoso.db-shm
/database/tmp-backups/
/uploads/bat-pdf-cache/
```

(Keeps: `database/backups/`, `.env`, `uploads/bat-archive/`,
`uploads/bat-previews/`, `uploads/jti-archive/`, and any other real data.)

## Part A — Hub: install Kopia + run the repository server (operator action)

> One-time, on the **hub**. ~15 minutes.

1. **Install Kopia** — `kopia.exe` (Windows AMD64) from
   https://github.com/kopia/kopia/releases → `C:\Cardoso Hub\kopia\kopia.exe`.
2. **Create the repository** (local filesystem on the hub):
   ```powershell
   $env:KOPIA_PASSWORD="<repo encryption password>"   # vault! lose it = lose backups
   kopia repository create filesystem --path D:\kopia-repo
   kopia policy set --global --keep-latest=10 --keep-daily=14 --keep-weekly=8 --keep-monthly=12
   ```
3. **Generate a server TLS cert** and note its fingerprint (sites pin it):
   ```powershell
   kopia server start --tls-generate-cert --tls-cert-file C:\Cardoso Hub\kopia\server.cert ^
     --tls-key-file C:\Cardoso Hub\kopia\server.key --address 0.0.0.0:51515
   # copy the printed SHA256 cert fingerprint — sites need it
   ```
4. **Add a user per site** (username convention `cardoso@<SiteName>`):
   ```powershell
   kopia server user add cardoso@Ermelo            # prompts for that site's password
   ```
5. **Register the server as a service** with the bundled NSSM:
   ```powershell
   nssm install CardosoKopiaServer "C:\Cardoso Hub\kopia\kopia.exe" ^
     server start --address 0.0.0.0:51515 ^
     --tls-cert-file "C:\Cardoso Hub\kopia\server.cert" ^
     --tls-key-file "C:\Cardoso Hub\kopia\server.key"
   nssm set CardosoKopiaServer AppEnvironmentExtra KOPIA_PASSWORD=<repo password>
   nssm set CardosoKopiaServer Start SERVICE_AUTO_START
   nssm start CardosoKopiaServer
   ```
6. **Hub `.env`** (so the app can read repo status for the dashboard):
   ```
   KOPIA_ENABLED=true
   KOPIA_EXE=C:\Cardoso Hub\kopia\kopia.exe
   KOPIA_REPO_PATH=D:\kopia-repo
   KOPIA_PASSWORD=<repo password>
   KOPIA_SITE_STALE_HOURS=26
   ```

## Part B — Site: the Kopia agent (shipped by the installer — Stage 3)

When `KOPIA_ENABLED=true` and the hub server settings are present (installer
config page or `.env`), the site installer:

1. drops `kopia.exe` and writes the app-root `.kopiaignore` above;
2. connects to the hub server:
   ```powershell
   kopia repository connect server --url=https://<hub>:51515 ^
     --server-cert-fingerprint=<fp> ^
     --override-username=cardoso --override-hostname=<SiteName> ^
     --password=<this site's server password>
   ```
3. registers a Scheduled Task `CardosoKopiaAgent` (daily ~02:30, after the
   02:00 local backup) running:
   ```
   kopia snapshot create "C:\Cardoso Customer App"
   ```

Running as a **Scheduled Task** (its own process, not the Node event loop) is
deliberate — it can't be frozen by the app, which is the failure that started
all of this.

## Part C — Hub dashboard visibility (Stage 2)

The hub reads its own repo (it *is* the server) and surfaces per-site off-site
status on the existing **HubBackups** page, alongside the pull status from
PR #500:

- `GET /api/hub/kopia-status` → for each site (by `cardoso@<SiteName>` source):
  newest snapshot age, snapshot count, total size, last `verify` result, and a
  green/amber/red verdict.
- New alert rule **`kopia-site-stale`**: fires when a site's newest snapshot is
  older than `KOPIA_SITE_STALE_HOURS`, or the repo/server is unreachable — a
  broken off-site path is loud, not silent.

All gated by `KOPIA_ENABLED`; absent ⇒ the feature is inert and the dashboard
hides the column.

## Part D — Weekly verification (Stage 3)

Scheduled Task `CardosoKopiaVerify` on the hub, weekly:
`kopia snapshot verify --verify-files-percent=5` — structural + sampled content
verification of the repo. Result feeds the dashboard.

## Part E — Geographic safety against losing the hub (optional, recommended)

Replicate the hub repo to cloud on a schedule (third Scheduled Task):
```powershell
kopia repository sync-to b2 --bucket=<cardoso-hub-repo> --parallel=4
```
Data is client-side encrypted before it leaves the hub. (Backblaze B2 ≈
$6/TB/mo.) Add once the local repo is trusted.

## Part F — Restore drill (write it down before you need it)

On the hub (or any recovery box with `kopia` + the repo password):
```powershell
$env:KOPIA_PASSWORD="<repo password>"
kopia repository connect filesystem --path D:\kopia-repo
kopia snapshot list cardoso@<SiteName>:C:\Cardoso Customer App   # pick a time
kopia restore <snapshotID> C:\restore                            # full site data tree
```
Then on the site: install the same app version, stop the service, copy the
restored `database\backups\cardoso-*.db` in as `database\cardoso.db`, restore
`uploads\` and `.env`, start the service. A scripted `scripts/kopia-restore.ps1`
ships in Stage 4.

## Rollout order

1. **Hub:** Part A (install Kopia, create repo, start server, add site users).
2. **Hub app:** enable `KOPIA_ENABLED`; Stage 2 dashboard column lights up
   (empty until sites report).
3. **Pilot site:** Stage 3 agent via installer; watch the site's row go green;
   do a test restore to a scratch dir.
4. **All sites:** ship the agent via the next installer build.
5. **Part E** (cloud) once the hub repo is trusted.
6. Only after Kopia retention is proven, relax the local keep-last-6 pruning.

## Build stages (tracked separately)

- **Stage 1 (this doc).**
- **Stage 2 — hub-side status:** `kopia` status reader + `/api/hub/kopia-status`
  + HubBackups column + `kopia-site-stale` alert. Unit-testable here.
- **Stage 3 — site agent:** vendor `kopia.exe`, `.kopiaignore`, installer
  connect + Scheduled Tasks. Needs a Windows test build before any site.
- **Stage 4 — restore script, optional cloud replication, retire keep-last-N.**
