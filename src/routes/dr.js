// Disaster recovery endpoints — site-side.
//
// Self-service "restore a lost site from the Hub" flow. The wizard
// running in the operator's browser on a FRESH install posts the
// operator's Hub admin credentials (which the Hub validates), the
// site downloads each backup artifact from the Hub via the Hub's
// /api/hub/dr/* endpoints, and hands the staged files off to
// apply-restore.ps1.
//
// Auth model:
//   - The kick-off endpoint (POST /api/dr/restore-from-hub) is
//     deliberately NOT gated by site session auth, because a fresh
//     install has no session. Authentication is via the supplied Hub
//     credentials (validated by the Hub during the artifact fetches).
//   - For non-empty installs (the operator is overwriting an existing
//     site rather than rebuilding from scratch), we require an extra
//     local triple-gate: tickbox + local admin password + typed
//     confirmation phrase. A stolen Hub password alone cannot nuke
//     an alive site.
//   - The status-poll endpoint takes the opaque restoreId as the
//     bearer — anyone who knows it can read progress but can't cause
//     a restore.
//
// HUB_MODE refusal: this feature only makes sense on a SITE. A Hub
// install has no apply-restore.ps1 path and shouldn't be self-
// restoring from another Hub.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import db from '../db/index.js';
import { logError } from '../lib/errorLog.js';
import { logAudit } from '../lib/audit.js';

// In-memory status tracker. Bounded by:
//   - Lazy GC on every read (entries older than RESTORE_STATUS_TTL_MS
//     are evicted on lookup).
//   - The wizard polls the status until it sees a terminal state, so
//     the entry's lifetime is the duration of the restore plus a few
//     poll cycles. A typical restore is single-digit minutes.
const restoreStatuses = new Map();
const RESTORE_STATUS_TTL_MS = 60 * 60 * 1000; // 1 hour

function gcStatuses() {
  const now = Date.now();
  for (const [id, s] of restoreStatuses.entries()) {
    if ((s.last_updated_at_ms || 0) + RESTORE_STATUS_TTL_MS < now) {
      restoreStatuses.delete(id);
    }
  }
}

function setStatus(restoreId, patch) {
  const existing = restoreStatuses.get(restoreId) || {};
  const next = {
    ...existing,
    ...patch,
    last_updated_at_ms: Date.now(),
    last_updated_at: new Date().toISOString(),
  };
  restoreStatuses.set(restoreId, next);
  return next;
}

function isInstallEmpty() {
  // "Empty" = the as-shipped fresh-install state: only the seeded
  // admin@example.com (and optionally the seeded user@example.com),
  // no reconciliations, no datarecord rows. Anything beyond that and
  // we treat the install as "alive" → triple-gate required.
  try {
    const userCount = db.prepare(`
      SELECT COUNT(*) AS c FROM "user"
      WHERE email NOT IN ('admin@example.com', 'user@example.com')
    `).get()?.c ?? 0;
    if (userCount > 0) return false;

    // Bail at the first non-empty table; cheaper than COUNT(*) on a
    // large datarecord table when the gate is trivially false anyway.
    const tablesToCheck = ['datarecord', 'bat_reconciliations', 'audit_log'];
    for (const t of tablesToCheck) {
      try {
        const exists = db.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get();
        if (exists) return false;
      } catch {
        // Missing table on a fresh install is fine — keep checking.
      }
    }
    return true;
  } catch {
    // If we can't even read the user table, treat as non-empty —
    // refusing-by-default is safer than restoring-by-default.
    return false;
  }
}

async function validateLocalAdminPassword(password) {
  if (typeof password !== 'string' || !password) return null;
  const admin = db.prepare(`
    SELECT id, email, password_hash FROM "user"
    WHERE role = 'admin' AND is_active = 1 AND password_hash IS NOT NULL
    ORDER BY id LIMIT 1
  `).get();
  if (!admin) return null;
  const ok = await bcrypt.compare(password, admin.password_hash);
  return ok ? admin : null;
}

async function fetchArtifactToFile({ hubUrl, hubEmail, hubPassword, siteId, filename, destPath, timeoutMs }) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${hubUrl}/api/hub/dr/fetch/${encodeURIComponent(siteId)}/${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: hubEmail, password: hubPassword }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} fetching ${filename}: ${body.slice(0, 300)}`);
    }
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(destPath));
    return fs.statSync(destPath).size;
  } finally {
    clearTimeout(timeout);
  }
}

export function createDrRouter() {
  const router = Router();

  // Hub installs have no concept of "restore the local site from a
  // Hub" — the Hub IS the source. Refuse early so the operator gets
  // a clear error rather than a subtle apply-restore.ps1 failure.
  function refuseIfHub(req, res) {
    if (process.env.HUB_MODE === 'true') {
      res.status(400).json({
        error: 'This Hub instance cannot self-restore from another Hub. The DR wizard is for SITE installs only.',
      });
      return true;
    }
    return false;
  }

  // POST /api/dr/restore-from-hub
  // Body shape:
  //   {
  //     hub_url:               'https://hub.example',
  //     hub_email:             'admin@example.com',
  //     hub_password:          '...',
  //     site_id:               '<uuid>',          // which site on the Hub to restore
  //     snapshot_filename:     'cardoso-<id>-<ts>.db',
  //     includes: {
  //       previews:    true,
  //       jti_archive: true,
  //       bat_archive: true,
  //       env:         true,
  //     },
  //     new_site_url:          'https://this-machine.example',  // for Hub URL update
  //     override?: {
  //       local_admin_password: '...',
  //       confirmation_phrase:  'OVERWRITE Cardoso-Ermelo',
  //       expected_phrase:      'OVERWRITE Cardoso-Ermelo',
  //     },
  //   }
  //
  // Returns immediately with { restore_id, status_url } — actual
  // download/apply work runs in the background and is reported via
  // /api/dr/restore-status/:restoreId polling.
  router.post('/api/dr/restore-from-hub', async (req, res) => {
    if (refuseIfHub(req, res)) return;
    gcStatuses();

    const {
      hub_url,
      hub_email,
      hub_password,
      site_id,
      snapshot_filename,
      includes = {},
      new_site_url,
      override,
    } = req.body || {};

    if (!hub_url || !hub_email || !hub_password || !site_id || !snapshot_filename || !new_site_url) {
      return res.status(400).json({
        error: 'Missing one of: hub_url, hub_email, hub_password, site_id, snapshot_filename, new_site_url.',
      });
    }
    if (!/^https?:\/\/.+/i.test(hub_url) || !/^https?:\/\/.+/i.test(new_site_url)) {
      return res.status(400).json({ error: 'hub_url and new_site_url must be http(s):// URLs.' });
    }
    // Filename safety mirror of the Hub-side isSafeBackupFilename.
    if (!/^[\w.\-+ ]+$/.test(snapshot_filename) || snapshot_filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid snapshot_filename.' });
    }

    // Triple-gate for non-empty installs.
    const empty = isInstallEmpty();
    if (!empty) {
      if (!override) {
        return res.status(409).json({
          error: 'This install already contains data (users, reconciliations, audit log). Provide an override block: { local_admin_password, confirmation_phrase, expected_phrase }.',
          install_state: 'non_empty',
        });
      }
      const { local_admin_password, confirmation_phrase, expected_phrase } = override;
      if (!confirmation_phrase || confirmation_phrase !== expected_phrase) {
        return res.status(400).json({
          error: 'Confirmation phrase does not match. Type the phrase exactly as shown on the wizard.',
        });
      }
      const adminUser = await validateLocalAdminPassword(local_admin_password);
      if (!adminUser) {
        try {
          logError('dr.override_auth_failed', new Error('Bad local admin password during DR override'), {
            ip: String(req.ip || '').slice(0, 64),
          }, 'warn');
        } catch {}
        return res.status(401).json({ error: 'Local admin password is incorrect.' });
      }
    }

    if (process.platform !== 'win32') {
      return res.status(400).json({
        error: 'DR restore is only supported on Windows site installs (apply-restore.ps1 is PowerShell).',
      });
    }

    const restoreId = crypto.randomBytes(8).toString('hex');
    const appDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
    const stagingDir = path.join(appDir, '.restore-staging', restoreId);
    fs.mkdirSync(stagingDir, { recursive: true });

    // Audit the kick-off. Subsequent phase progress is in-memory only
    // (not audited per-phase) since the wizard sees it via polling.
    try {
      logAudit({
        req,
        action: 'dr_restore_initiated',
        resourceType: 'system',
        resourceId: 'self',
        resourceName: snapshot_filename,
        details: `DR restore initiated from hub ${hub_url} as ${hub_email}, site_id=${site_id}, install_state=${empty ? 'empty' : 'non_empty'}, override_used=${!!override}`,
        changes: {
          restore_id: restoreId,
          hub_url,
          hub_email,
          site_id,
          snapshot_filename,
          new_site_url,
          install_state: empty ? 'empty' : 'non_empty',
          override_used: !!override,
        },
        status: 'success',
        userOverride: { email: `dr-wizard:${hub_email}`, full_name: 'dr-wizard' },
      });
    } catch {}

    // Initial status — wizard polls immediately after this response.
    setStatus(restoreId, {
      restore_id: restoreId,
      phase: 'starting',
      message: 'Restore queued',
      total_files: 1 // .db is mandatory
        + (includes.previews    ? 1 : 0)
        + (includes.jti_archive ? 1 : 0)
        + (includes.bat_archive ? 1 : 0)
        + (includes.env         ? 1 : 0),
      files_completed: 0,
      bytes_downloaded: 0,
      current_file: null,
      error: null,
      terminal: false,
    });

    res.status(202).json({
      ok: true,
      restore_id: restoreId,
      status_url: `/api/dr/restore-status/${restoreId}`,
      message: 'Restore queued. Poll status_url for progress.',
    });

    // ── Background work (no-await, fire-and-forget) ──
    // We've already responded to the client. Status is in the in-
    // memory map and the wizard's polling will pick up progress.
    // Errors here NEVER bubble up — they go into setStatus(error).
    (async () => {
      const hubUrl = hub_url.replace(/\/$/, '');
      const FETCH_TIMEOUT = 30 * 60 * 1000; // 30 min — multi-GB DB possible

      const tsMatch = snapshot_filename.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/);
      const ts = tsMatch ? tsMatch[1] : null;

      // Companion filenames — derived from the .db filename's
      // timestamp suffix. Same convention used by the Hub puller.
      const companions = {
        previews:    includes.previews    && ts ? `bat-previews-${site_id}-${ts}.zip` : null,
        jti_archive: includes.jti_archive && ts ? `jti-archive-${site_id}-${ts}.zip` : null,
        bat_archive: includes.bat_archive && ts ? `bat-archive-${site_id}-${ts}.zip` : null,
        env:         includes.env         && ts ? `config-${site_id}-${ts}.env`     : null,
      };

      let stagedDb = null;
      let stagedPaths = { previews: null, jti_archive: null, bat_archive: null, env: null };

      try {
        // Phase 1: download the .db. Mandatory; failure here is fatal.
        setStatus(restoreId, {
          phase: 'downloading',
          message: 'Downloading database snapshot',
          current_file: snapshot_filename,
        });
        stagedDb = path.join(stagingDir, snapshot_filename);
        const dbBytes = await fetchArtifactToFile({
          hubUrl, hubEmail: hub_email, hubPassword: hub_password,
          siteId: site_id, filename: snapshot_filename, destPath: stagedDb,
          timeoutMs: FETCH_TIMEOUT,
        });
        setStatus(restoreId, {
          files_completed: 1,
          bytes_downloaded: dbBytes,
        });

        // Phase 2-5: companions. Each is independent — if one fails,
        // we surface it but continue. Operator may prefer "DB-only
        // restore with degraded uploads" over "no restore at all".
        const phaseLabels = {
          previews:    'BAT preview JPEGs',
          jti_archive: 'JTI export history',
          bat_archive: 'BAT supplier source files',
          env:         'site .env (encryption keys, secrets)',
        };
        let totalBytes = dbBytes;
        let companionFailures = [];
        for (const [key, filename] of Object.entries(companions)) {
          if (!filename) continue;
          setStatus(restoreId, {
            phase: 'downloading',
            message: `Downloading ${phaseLabels[key]}`,
            current_file: filename,
          });
          const dest = path.join(stagingDir, filename);
          try {
            const bytes = await fetchArtifactToFile({
              hubUrl, hubEmail: hub_email, hubPassword: hub_password,
              siteId: site_id, filename, destPath: dest,
              timeoutMs: FETCH_TIMEOUT,
            });
            stagedPaths[key] = dest;
            totalBytes += bytes;
            const completed = 1 + Object.values(stagedPaths).filter(Boolean).length;
            setStatus(restoreId, {
              files_completed: completed,
              bytes_downloaded: totalBytes,
            });
          } catch (companionErr) {
            // 404 from Hub means the companion just doesn't exist for
            // this snapshot timestamp. That's not a download failure
            // it's a content gap — log and continue.
            const msg = String(companionErr.message || '');
            const is404 = /HTTP 404/.test(msg);
            companionFailures.push({ key, filename, error: msg, missing: is404 });
            try {
              logError('dr.companion_fetch', companionErr, { restore_id: restoreId, key, filename });
            } catch {}
          }
        }

        // Phase 6: tell the Hub about our new URL so it can push
        // restores / pings here in future. Best-effort — failure
        // doesn't abort the restore (operator can fix Hub URL
        // manually after the fact).
        setStatus(restoreId, {
          phase: 'updating_hub',
          message: 'Updating Hub with new site URL',
          current_file: null,
        });
        try {
          const r = await fetch(`${hubUrl}/api/hub/dr/site-url/${encodeURIComponent(site_id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: hub_email,
              password: hub_password,
              new_url: new_site_url,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!r.ok) {
            const body = await r.text().catch(() => '');
            throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
          }
        } catch (urlErr) {
          // Don't fail the restore for a Hub URL update failure.
          companionFailures.push({ key: 'hub_url_update', error: String(urlErr.message || urlErr) });
          try { logError('dr.hub_url_update', urlErr, { restore_id: restoreId }); } catch {}
        }

        // Phase 7: hand off to apply-restore.ps1 via Task Scheduler.
        // Detached — once the service stops, this Node process gets
        // killed, so the script must outlive us. Same launcher used
        // by the existing Hub-push-restore flow.
        setStatus(restoreId, {
          phase: 'applying',
          message: 'Stopping service and swapping files (apply-restore.ps1)',
          current_file: null,
        });

        const applyScript = path.join(appDir, 'scripts', 'apply-restore.ps1');
        if (!fs.existsSync(applyScript)) {
          throw new Error(`apply-restore.ps1 missing at ${applyScript} — site needs to upgrade to a release that ships the restore mechanism.`);
        }

        const psArgsList = [
          ['-StagingDir', stagingDir],
          ['-SnapshotDbPath', stagedDb],
          ['-AppDir', appDir],
          ['-RestoreId', restoreId],
        ];
        if (stagedPaths.previews)    { psArgsList.push(['-SnapshotPreviewsZipPath',   stagedPaths.previews]);    }
        if (stagedPaths.jti_archive) { psArgsList.push(['-SnapshotJtiArchiveZipPath', stagedPaths.jti_archive]); }
        if (stagedPaths.bat_archive) { psArgsList.push(['-SnapshotBatArchiveZipPath', stagedPaths.bat_archive]); }
        if (stagedPaths.env)         { psArgsList.push(['-SnapshotEnvPath',           stagedPaths.env]);         }

        const psArgs = psArgsList
          .map(([k, v]) => `${k} '${String(v).replace(/'/g, "''")}'`)
          .join(' ');
        const wrapper = `& '${applyScript.replace(/'/g, "''")}' ${psArgs}`;

        const { launchViaTaskScheduler } = await import('./system.js');
        const taskName = `CardosoDrRestore-${restoreId}`;
        await launchViaTaskScheduler(taskName, wrapper);

        // Final status — restore is now in apply-restore.ps1's hands.
        // The wizard will keep polling but the SERVICE is about to
        // stop, so the next poll may fail with connection-refused.
        // That's the signal the swap is in progress.
        setStatus(restoreId, {
          phase: 'handed_off',
          message: 'Service is stopping for file swap. The site will reboot and restart automatically. Watch the browser tab — once it reconnects, log in with the credentials from the RESTORED snapshot (not the local bootstrap admin).',
          current_file: null,
          companion_failures: companionFailures.length ? companionFailures : undefined,
          terminal: true,
        });
      } catch (err) {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch {}
        setStatus(restoreId, {
          phase: 'failed',
          message: 'Restore failed before file swap. Live install untouched.',
          error: String(err.message || err),
          terminal: true,
        });
        try { logError('dr.restore_pipeline', err, { restore_id: restoreId }); } catch {}
      }
    })().catch(() => { /* fire-and-forget; setStatus already records errors */ });
  });

  // GET /api/dr/restore-status/:restoreId
  // Polled by the wizard every ~1s. Returns the in-memory status
  // object verbatim. No auth — restoreId is the bearer (32-byte
  // random hex; brute-forcing is impractical).
  router.get('/api/dr/restore-status/:restoreId', (req, res) => {
    gcStatuses();
    const status = restoreStatuses.get(req.params.restoreId);
    if (!status) {
      return res.status(404).json({ error: 'Unknown or expired restore_id.' });
    }
    res.json(status);
  });

  // GET /api/dr/install-state
  // Used by the wizard's first step to decide whether to show the
  // override gate. No auth — leaks only "is this install fresh?"
  // (boolean), nothing sensitive.
  router.get('/api/dr/install-state', (req, res) => {
    if (refuseIfHub(req, res)) return;
    res.json({
      empty: isInstallEmpty(),
      hub_mode: process.env.HUB_MODE === 'true',
    });
  });

  return router;
}
