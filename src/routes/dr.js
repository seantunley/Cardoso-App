// Disaster recovery endpoints — site-side.
//
// Self-service "restore a lost site from the Hub" flow. The wizard
// running in the operator's browser posts the operator's Hub admin
// credentials AND their local admin password; the site downloads each
// backup artifact from the Hub via /api/hub/dr/* and hands the staged
// files off to apply-restore.ps1.
//
// Auth model:
//   - The kick-off endpoint (POST /api/dr/restore-from-hub) is NOT
//     gated by site session auth (a fresh install has no session).
//     Authentication is the COMBINATION of:
//       a) Hub admin credentials (validated by the Hub via a pre-flight
//          POST /api/hub/dr/list-sites — this also gives us the
//          authoritative site name for the confirmation phrase).
//       b) LOCAL admin password (bcrypt-validated against the local
//          user table) — even on a fresh install where the only admin
//          is admin@example.com with the bootstrap password printed at
//          first boot.
//       c) Typed confirmation phrase `OVERWRITE <site name>` —
//          the expected phrase is DERIVED SERVER-SIDE from the site
//          name returned by the Hub, never trusted from the client.
//     All three are required ALWAYS — there is no auth-skip path for
//     "empty" installs (the previous design's no-auth-on-fresh-install
//     was a real LAN-attacker race).
//   - The status-poll endpoint takes the opaque restoreId as the
//     bearer (16 random bytes = 128 bits). Per-IP rate-limited so a
//     guessing attempt doesn't dominate.
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
import rateLimit from 'express-rate-limit';
import db from '../db/index.js';
import { logError } from '../lib/errorLog.js';
import { logAudit } from '../lib/audit.js';

// ── Status persistence ────────────────────────────────────────────
//
// In-memory map for fast access; mirrored to a per-restore JSON file
// under appDir/.dr-restore-status/ so a wizard surviving a Node
// process restart (nodemon, NSSM auto-restart, OOM kill) can still
// poll progress instead of seeing 404 mid-restore. apply-restore.ps1
// writes its own status file — we don't try to merge those, the
// wizard reads ours pre-handoff and then naturally loses contact
// when the service stops for the swap.
const restoreStatuses = new Map();
const RESTORE_STATUS_TTL_MS = 60 * 60 * 1000; // 1 hour

function statusDir() {
  const appDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
  return path.join(appDir, '.dr-restore-status');
}

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
  // Best-effort file mirror. A write failure here doesn't fail the
  // restore — the in-memory map still has the truth for this process
  // lifetime, and a service restart while the file is missing is the
  // edge case we already accept.
  try {
    fs.mkdirSync(statusDir(), { recursive: true });
    fs.writeFileSync(path.join(statusDir(), `${restoreId}.json`), JSON.stringify(next));
  } catch (err) {
    console.error('[dr] writing status file failed:', err.message);
  }
  return next;
}

function getStatus(restoreId) {
  const mem = restoreStatuses.get(restoreId);
  if (mem) return mem;
  // File fallback — survives a Node process restart mid-restore.
  try {
    const raw = fs.readFileSync(path.join(statusDir(), `${restoreId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── In-process restore lock ───────────────────────────────────────
//
// Two operators (or one operator double-clicking) initiating a restore
// at the same time would queue two apply-restore.ps1 Task Scheduler
// runs racing the same live cardoso.db. The lock is process-local;
// after the apply script stops the service the process dies and any
// stale lock dies with it. Lock is cleared on the IIFE's terminal
// state, win or lose.
let restoreInProgress = false;

// ── Helpers ───────────────────────────────────────────────────────

// Strip control characters and cap length. Used on every user-supplied
// value that flows into a log or audit-log free-text field. Without
// this an attacker can post `email: "x\n[FATAL] fake line"` and
// pollute the log viewer.
function sanitizeForLog(value, max = 200) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
}

// Local admin authentication — bcrypt against the first active admin
// in the user table. Returns the user row on success, null on failure.
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

// "Empty" check — used only for the wizard's UX summary now (NOT for
// auth gating, that always requires the override). Widened from the
// previous version which only sniffed three tables — a site with a
// configured Sage connection would have looked empty.
function isInstallEmpty() {
  try {
    const userCount = db.prepare(`
      SELECT COUNT(*) AS c FROM "user"
      WHERE email NOT IN ('admin@example.com', 'user@example.com')
    `).get()?.c ?? 0;
    if (userCount > 0) return false;

    const tablesToCheck = [
      'datarecord', 'bat_reconciliations', 'bat_invoice_extractions',
      'bat_invoice_lookups', 'auditlog', 'databaseconnection',
    ];
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
    return false; // refusing-by-default is safer than defaulting to "empty"
  }
}

// Look up the chosen site on the Hub and return its name. Doubles as a
// pre-flight credentials check — a 401 here gives the operator clear
// feedback at kickoff time instead of via polling.
async function lookupSiteOnHub({ hubUrl, hubEmail, hubPassword, siteId }) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(`${hubUrl}/api/hub/dr/list-sites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: hubEmail, password: hubPassword }),
      signal: ctrl.signal,
    });
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || 'Hub creds rejected'), { status: 401 });
    }
    if (!r.ok) {
      throw Object.assign(new Error(`Hub returned HTTP ${r.status}`), { status: 502 });
    }
    const data = await r.json().catch(() => ({}));
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    const site = sites.find((s) => s.id === siteId);
    if (!site) {
      throw Object.assign(new Error(`Hub does not know about site_id=${siteId}`), { status: 404 });
    }
    return site;
  } finally {
    clearTimeout(timeout);
  }
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

// Per-IP rate limit on the status endpoint. Wizard polls every 1s
// (= 60/min). Cap at 90/min to absorb burst polls during the brief
// page-render window without inviting brute-force enumeration of the
// 128-bit restoreId space.
const statusEndpointLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Status polling rate limit exceeded.' },
});

export function createDrRouter() {
  const router = Router();

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
  //     includes:              { previews, jti_archive, bat_archive, env },
  //     new_site_url:          'https://this-machine.example',
  //     override: {
  //       local_admin_password: '...',
  //       confirmation_phrase:  'OVERWRITE Cardoso-Ermelo',
  //       // expected_phrase is NOT accepted here — server derives it
  //       // from the Hub-supplied site name (see lookupSiteOnHub).
  //     },
  //   }
  router.post('/api/dr/restore-from-hub', async (req, res) => {
    if (refuseIfHub(req, res)) return;
    gcStatuses();

    const {
      hub_url, hub_email, hub_password,
      site_id, snapshot_filename, includes = {},
      new_site_url, override,
    } = req.body || {};

    // Body shape validation.
    if (!hub_url || !hub_email || !hub_password || !site_id || !snapshot_filename || !new_site_url) {
      return res.status(400).json({
        error: 'Missing one of: hub_url, hub_email, hub_password, site_id, snapshot_filename, new_site_url.',
      });
    }
    if (!/^https?:\/\/.+/i.test(hub_url) || !/^https?:\/\/.+/i.test(new_site_url)) {
      return res.status(400).json({ error: 'hub_url and new_site_url must be http(s):// URLs.' });
    }
    if (!/^[\w.\-+ ]+$/.test(snapshot_filename) || snapshot_filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid snapshot_filename.' });
    }
    if (!override || typeof override !== 'object') {
      return res.status(400).json({
        error: 'Override block required. Pass { local_admin_password, confirmation_phrase }.',
      });
    }
    const { local_admin_password, confirmation_phrase } = override;
    if (!local_admin_password || !confirmation_phrase) {
      return res.status(400).json({
        error: 'Override must include local_admin_password and confirmation_phrase.',
      });
    }

    // Pre-flight against the Hub: validates Hub creds AND looks up the
    // authoritative site name. This is the source of truth for the
    // confirmation phrase — never trusted from the client (the previous
    // design accepted expected_phrase from the request body and
    // compared it to itself, making the gate trivially bypassable).
    let hubSite;
    try {
      hubSite = await lookupSiteOnHub({
        hubUrl: hub_url.replace(/\/$/, ''),
        hubEmail: hub_email,
        hubPassword: hub_password,
        siteId: site_id,
      });
    } catch (lookupErr) {
      try {
        logError('dr.hub_preflight', lookupErr, {
          hub_url: sanitizeForLog(hub_url),
          hub_email: sanitizeForLog(hub_email),
          site_id: sanitizeForLog(site_id),
          ip: sanitizeForLog(req.ip, 64),
        }, 'warn');
      } catch (e) { console.error('[dr.hub_preflight]', { hub_url: sanitizeForLog(hub_url), site_id: sanitizeForLog(site_id) }, e.message); }
      return res.status(lookupErr.status || 502).json({ error: lookupErr.message });
    }

    // Server-derived expected phrase. Compared against what the user
    // typed. The hubSite.name comes from the Hub's authoritative
    // hub_sites table — a request-body forged name can't pass.
    const expectedPhrase = `OVERWRITE ${hubSite.name}`;
    if (confirmation_phrase !== expectedPhrase) {
      return res.status(400).json({
        error: 'Confirmation phrase does not match. Type the phrase exactly as shown on the wizard.',
      });
    }

    // Local admin password validation. Required ALWAYS, including on
    // truly fresh installs (admin@example.com with the bootstrap
    // password printed at first boot is a valid admin and bcrypt-
    // verifies correctly). Eliminates the previous "no-auth on empty
    // install" path which was a real LAN-attacker race.
    const adminUser = await validateLocalAdminPassword(local_admin_password);
    if (!adminUser) {
      try {
        logError('dr.override_auth_failed', new Error('Bad local admin password during DR override'), {
          ip: sanitizeForLog(req.ip, 64),
          hub_email: sanitizeForLog(hub_email),
        }, 'warn');
      } catch (e) { console.error('[dr.override_auth_failed]', { hub_email: sanitizeForLog(hub_email) }, e.message); }
      return res.status(401).json({ error: 'Local admin password is incorrect.' });
    }

    if (process.platform !== 'win32') {
      return res.status(400).json({
        error: 'DR restore is only supported on Windows site installs (apply-restore.ps1 is PowerShell).',
      });
    }

    // Lock acquisition — fail-fast on concurrent kickoffs.
    if (restoreInProgress) {
      return res.status(409).json({
        error: 'Another DR restore is already in progress on this machine. Wait for it to finish (or for the service to restart) before initiating a new one.',
      });
    }
    restoreInProgress = true;

    // 16 random bytes (128 bits) — enough that an attacker can't
    // realistically enumerate a live restoreId.
    const restoreId = crypto.randomBytes(16).toString('hex');
    const appDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
    const stagingDir = path.join(appDir, '.restore-staging', restoreId);
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
      logAudit({
        req,
        action: 'dr_restore_initiated',
        resourceType: 'system',
        resourceId: 'self',
        resourceName: snapshot_filename,
        details:
          `DR restore initiated from hub ${sanitizeForLog(hub_url)} as ${sanitizeForLog(hub_email)}, ` +
          `site_id=${sanitizeForLog(site_id, 64)}, site_name=${sanitizeForLog(hubSite.name, 100)}, ` +
          `local_admin=${sanitizeForLog(adminUser.email)}`,
        changes: {
          restore_id: restoreId,
          hub_url: sanitizeForLog(hub_url),
          hub_email: sanitizeForLog(hub_email),
          site_id: sanitizeForLog(site_id, 64),
          snapshot_filename,
          new_site_url: sanitizeForLog(new_site_url),
        },
        status: 'success',
        userOverride: { email: `dr-wizard:${sanitizeForLog(hub_email)}`, full_name: 'dr-wizard' },
      });
    } catch (e) { console.error('[dr.restore_initiated_audit]', { restoreId }, e.message); }

    setStatus(restoreId, {
      restore_id: restoreId,
      phase: 'starting',
      message: 'Restore queued',
      total_files: 1
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

    // ── Background work (fire-and-forget) ──
    (async () => {
      const hubUrl = hub_url.replace(/\/$/, '');
      const FETCH_TIMEOUT = 30 * 60 * 1000;

      const tsMatch = snapshot_filename.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/);
      const ts = tsMatch ? tsMatch[1] : null;

      const companions = {
        previews:    includes.previews    && ts ? `bat-previews-${site_id}-${ts}.zip` : null,
        jti_archive: includes.jti_archive && ts ? `jti-archive-${site_id}-${ts}.zip` : null,
        bat_archive: includes.bat_archive && ts ? `bat-archive-${site_id}-${ts}.zip` : null,
        env:         includes.env         && ts ? `config-${site_id}-${ts}.env`     : null,
      };

      let stagedDb = null;
      const stagedPaths = { previews: null, jti_archive: null, bat_archive: null, env: null };

      try {
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
        setStatus(restoreId, { files_completed: 1, bytes_downloaded: dbBytes });

        const phaseLabels = {
          previews:    'BAT preview JPEGs',
          jti_archive: 'JTI export history',
          bat_archive: 'BAT supplier source files',
          env:         'site .env (encryption keys, secrets)',
        };
        let totalBytes = dbBytes;
        const companionFailures = [];
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
            setStatus(restoreId, { files_completed: completed, bytes_downloaded: totalBytes });
          } catch (companionErr) {
            const msg = String(companionErr.message || '');
            const is404 = /HTTP 404/.test(msg);
            companionFailures.push({ key, filename, error: msg, missing: is404 });
            try {
              logError('dr.companion_fetch', companionErr, { restore_id: restoreId, key, filename });
            } catch (e) { console.error('[dr.companion_fetch]', { restoreId, key, filename }, e.message); }
          }
        }

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
          companionFailures.push({ key: 'hub_url_update', error: String(urlErr.message || urlErr) });
          try { logError('dr.hub_url_update', urlErr, { restore_id: restoreId }); } catch (e) { console.error('[dr.hub_url_update]', { restoreId }, e.message); }
        }

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
        } catch (e) { console.error('[dr.staging_cleanup]', { restoreId, stagingDir }, e.message); }
        setStatus(restoreId, {
          phase: 'failed',
          message: 'Restore failed before file swap. Live install untouched.',
          error: String(err.message || err),
          terminal: true,
        });
        try { logError('dr.restore_pipeline', err, { restore_id: restoreId }); } catch (e) { console.error('[dr.restore_pipeline]', { restoreId }, e.message); }
      } finally {
        // Lock release on terminal state, regardless of outcome. On
        // success the apply-restore.ps1 script will stop the service
        // and the lock dies with the process anyway; on failure we
        // want a retry to be possible.
        restoreInProgress = false;
      }
    })().catch((unexpected) => {
      // Last-resort safety net for an unhandled throw outside the
      // inner try (shouldn't happen — every await is wrapped — but
      // the sync prefix code in the IIFE could throw before the try
      // begins). Keep the lock from sticking.
      restoreInProgress = false;
      try {
        setStatus(restoreId, {
          phase: 'failed',
          message: 'Restore failed unexpectedly.',
          error: String(unexpected?.message || unexpected),
          terminal: true,
        });
      } catch (e) { console.error('[dr.restore_pipeline_fallback]', { restoreId }, e.message); }
    });
  });

  // GET /api/dr/restore-status/:restoreId
  // Polled by the wizard at ~1s. Per-IP rate-limited at 90/min.
  // 128-bit restoreId is the bearer; falls back to file-on-disk if
  // the in-memory map was lost (Node restart).
  router.get('/api/dr/restore-status/:restoreId', statusEndpointLimiter, (req, res) => {
    gcStatuses();
    // Whitelist the restoreId shape (32 lowercase hex chars) so a
    // crafted request can't trick the file-fallback into reading
    // arbitrary disk paths via traversal in :restoreId.
    if (!/^[a-f0-9]{32}$/.test(req.params.restoreId)) {
      return res.status(400).json({ error: 'Invalid restore_id format.' });
    }
    const status = getStatus(req.params.restoreId);
    if (!status) {
      return res.status(404).json({ error: 'Unknown or expired restore_id.' });
    }
    res.json(status);
  });

  // GET /api/dr/install-state
  // Wizard reads this for the install summary card; auth gating no
  // longer depends on it (override is required ALWAYS now). Returns
  // the broader is-empty signal that includes Sage connections etc.
  router.get('/api/dr/install-state', (req, res) => {
    if (refuseIfHub(req, res)) return;
    res.json({
      empty: isInstallEmpty(),
      hub_mode: process.env.HUB_MODE === 'true',
    });
  });

  return router;
}
