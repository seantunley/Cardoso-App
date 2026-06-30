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
 * Resolve the ACTUAL on-disk backup folder for a site — the single source of
 * truth every read path (status, snapshot list, restore, DR fetch) must use so
 * reads and writes can never diverge:
 *   - the readable `<name>-<id>` folder if it exists (post-migration / new pulls)
 *   - else the legacy `<id>` folder if it still exists (pre-migration)
 *   - else the readable folder (the path a new pull will create)
 *
 * @param {string} baseDir  absolute path to database/hub-backups
 * @param {{ id?: string, name?: string, slug?: string }} site
 * @returns {string} absolute path to the site's backup folder
 */
export function resolveSiteBackupDir(baseDir, site) {
  const named = path.join(baseDir, siteBackupDirName(site));
  if (fs.existsSync(named)) return named;
  const id = String(site?.id ?? '').trim();
  if (id) {
    const legacy = path.join(baseDir, id);
    if (fs.existsSync(legacy)) return legacy;
  }
  return named;
}

/**
 * One-time, idempotent migration: rename existing token-named backup folders
 * (database/hub-backups/<site.id>/) to their readable name folder. Best-effort
 * — never throws; logs each action. Safe to call on every pull cycle.
 *
 *   - target missing            → rename id-dir → name-dir
 *   - target already exists      → move any files from the id-dir into it,
 *                                  then remove the now-empty id-dir
 *   - id-dir missing / id===name → nothing to do
 *
 * @param {string} baseDir  absolute path to database/hub-backups
 * @param {Array<{ id: string, name?: string, slug?: string }>} sites
 * @returns {{ renamed: number, merged: number }}
 */
export function reconcileHubBackupDirs(baseDir, sites) {
  let renamed = 0;
  let merged = 0;
  for (const site of sites || []) {
    try {
      const oldName = String(site.id);
      const newName = siteBackupDirName(site);
      if (!oldName || newName === oldName) continue;

      const oldDir = path.join(baseDir, oldName);
      const newDir = path.join(baseDir, newName);
      if (!fs.existsSync(oldDir)) continue;

      if (!fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
        renamed += 1;
        console.log(`[HUB BACKUP] Renamed backup folder ${oldName} → ${newName} (${site.name || 'unnamed'})`);
        continue;
      }

      // Target exists already — move files across, then drop the empty old dir.
      for (const f of fs.readdirSync(oldDir)) {
        const from = path.join(oldDir, f);
        const to = path.join(newDir, f);
        try {
          if (fs.existsSync(to)) continue; // don't clobber an existing backup
          fs.renameSync(from, to);
          merged += 1;
        } catch (e) {
          console.warn(`[HUB BACKUP] could not merge ${oldName}/${f} into ${newName}: ${e.message}`);
        }
      }
      try {
        if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
      } catch (e) {
        console.warn(`[HUB BACKUP] could not remove empty folder ${oldName}: ${e.message}`);
      }
      if (merged > 0) console.log(`[HUB BACKUP] Merged backup folder ${oldName} → ${newName} (${site.name || 'unnamed'})`);
    } catch (err) {
      console.warn(`[HUB BACKUP] folder reconcile failed for site ${site?.id}: ${err.message}`);
    }
  }
  return { renamed, merged };
}
