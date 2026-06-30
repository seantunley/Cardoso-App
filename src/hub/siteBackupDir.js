// Human-readable folder naming for site backups stored on the hub.
//
// The hub pulls each site's SQLite backup into database/hub-backups/<dir>/.
// That <dir> used to be site.id — an opaque token — so an operator browsing
// the hub's disk had no idea which folder belonged to which shop ("I do not
// know who or what they are"). This module names the folder by the site's
// operator-facing NAME, SUFFIXED WITH THE SITE ID so it stays unique, and
// migrates the old token-named folders over once so existing backups become
// identifiable too.
//
// IMPORTANT — uniqueness: the rest of the hub-backup code is *directory-scoped*
// per site (pull, prune, status, snapshot list, restore, DR fetch all operate
// on one folder). A name-only folder is NOT unique — two sites whose names
// collide after sanitising/truncation ("A/B" and "A_B", or two 64-char names
// sharing a prefix) would share a folder, letting one site prune or clobber
// another's snapshots and report the wrong status. So the folder name always
// includes the unique site id as a suffix; the name is just a readable prefix.

import fs from 'fs';
import path from 'path';

function sanitizeId(id) {
  return String(id ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/**
 * Folder-safe, UNIQUE, human-readable directory name for a site's hub backups:
 * `<sanitizedName>-<siteId>` (e.g. "Ermelo-a3f9c2d4"), or just the id when no
 * name/slug is available. The id suffix guarantees uniqueness; the name prefix
 * keeps the folder identifiable on disk.
 *
 * @param {{ id?: string, name?: string, slug?: string }} site
 * @returns {string}
 */
export function siteBackupDirName(site) {
  const safeId = sanitizeId(site?.id) || 'unknown';
  const rawName = site?.name || site?.slug || '';
  const safeName = String(rawName)
    .trim()
    .replace(/[^A-Za-z0-9 ._-]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 48);
  return safeName ? `${safeName}-${safeId}` : safeId;
}

/**
 * Every on-disk folder that belongs to a site: the canonical `<name>-<id>`, the
 * legacy bare `<id>`, or an older `<oldName>-<id>` left behind by a previous
 * display name. Matched by the STABLE id suffix so renaming a site (which
 * changes the readable prefix) does NOT orphan its existing backups.
 *
 * `reserved` holds other sites' folder names + ids so that — in the unlikely
 * case one site's id is a dash-suffix of another's folder — a site can't claim
 * a folder that is another site's canonical name or exact id.
 *
 * @param {string} baseDir
 * @param {{ id?: string, name?: string, slug?: string }} site
 * @param {Set<string>} [reserved]
 * @returns {string[]} matching directory names (not full paths)
 */
function existingSiteDirs(baseDir, site, reserved = new Set()) {
  const safeId = sanitizeId(site?.id);
  if (!safeId) return [];
  const canonical = siteBackupDirName(site);
  let entries;
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) =>
      !reserved.has(n) &&
      (n === canonical || n === safeId || (n.endsWith(`-${safeId}`) && n.length > safeId.length + 1)),
    );
}

/**
 * Resolve the ACTUAL on-disk backup folder for a site — the single source of
 * truth every read path (status, snapshot list, restore, DR fetch) must use so
 * reads and writes can never diverge:
 *   - the canonical `<name>-<id>` folder if it exists (post-migration / new pulls)
 *   - else the legacy bare `<id>` folder, matched EXACTLY (pre-migration)
 *   - else the canonical folder (the path a new pull will create)
 *
 * Deliberately NO `*-<id>` suffix scan here: without the full site list it could
 * claim another site whose id is a dash-suffix of this one (ids "x" vs "a-x",
 * where "Foo-a-x" ends with "-x"), serving another site's backups. Post-RENAME
 * read continuity is handled by reconcileHubBackupDirs, which runs per-site on
 * every pull and HAS the cross-site reserved guard.
 *
 * @param {string} baseDir  absolute path to database/hub-backups
 * @param {{ id?: string, name?: string, slug?: string }} site
 * @returns {string} absolute path to the site's backup folder
 */
export function resolveSiteBackupDir(baseDir, site) {
  const canonical = siteBackupDirName(site);
  const canonicalDir = path.join(baseDir, canonical);
  if (fs.existsSync(canonicalDir)) return canonicalDir;
  const id = String(site?.id ?? '').trim();
  if (id) {
    const legacy = path.join(baseDir, id);
    if (fs.existsSync(legacy)) return legacy;
  }
  return canonicalDir;
}

/**
 * Idempotent migration: bring every folder that belongs to a site under its
 * current canonical `<name>-<id>`. Handles BOTH the legacy bare-`<id>` folders
 * AND a rename (older `<oldName>-<id>` → new `<name>-<id>`), matching by the
 * stable id suffix. Best-effort — never throws; logs each action. Safe to call
 * on every pull (bulk) and per-site (so the notify-backup-ready path, which
 * calls pullBackupForSite directly, also migrates).
 *
 *   - canonical missing      → rename the source folder → canonical
 *   - canonical exists        → move files across (no clobber), drop empty source
 *
 * @param {string} baseDir  absolute path to database/hub-backups
 * @param {Array<{ id: string, name?: string, slug?: string }>} sites  sites to migrate
 * @param {{ allSites?: Array }} [opts]  full site list for the cross-site reserved guard
 * @returns {{ renamed: number, merged: number }}
 */
export function reconcileHubBackupDirs(baseDir, sites, { allSites } = {}) {
  let renamed = 0;
  let merged = 0;
  const list = sites || [];
  const all = allSites || list;
  for (const site of list) {
    try {
      const canonical = siteBackupDirName(site);
      const canonicalDir = path.join(baseDir, canonical);

      // Other sites' canonical names + ids — never migrate one of those into
      // this site's folder (guards the dash-suffix-collision edge case).
      const reserved = new Set();
      for (const o of all) {
        if (o === site || (o?.id != null && o.id === site?.id)) continue;
        reserved.add(siteBackupDirName(o));
        reserved.add(sanitizeId(o?.id));
      }

      const sources = existingSiteDirs(baseDir, site, reserved).filter((n) => n !== canonical);
      for (const src of sources) {
        const oldDir = path.join(baseDir, src);
        if (!fs.existsSync(canonicalDir)) {
          fs.renameSync(oldDir, canonicalDir);
          renamed += 1;
          console.log(`[HUB BACKUP] Renamed backup folder ${src} -> ${canonical} (${site.name || 'unnamed'})`);
          continue;
        }
        // Canonical exists — move files across, then drop the empty source dir.
        for (const f of fs.readdirSync(oldDir)) {
          const to = path.join(canonicalDir, f);
          try {
            if (fs.existsSync(to)) continue; // don't clobber an existing backup
            fs.renameSync(path.join(oldDir, f), to);
            merged += 1;
          } catch (e) {
            console.warn(`[HUB BACKUP] could not merge ${src}/${f} into ${canonical}: ${e.message}`);
          }
        }
        try {
          if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
        } catch (e) {
          console.warn(`[HUB BACKUP] could not remove empty folder ${src}: ${e.message}`);
        }
      }
    } catch (err) {
      console.warn(`[HUB BACKUP] folder reconcile failed for site ${site?.id}: ${err.message}`);
    }
  }
  return { renamed, merged };
}
