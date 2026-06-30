// Human-readable folder naming for site backups stored on the hub.
//
// The hub pulls each site's SQLite backup into database/hub-backups/<dir>/.
// That <dir> used to be site.id — an opaque token — so an operator browsing
// the hub's disk had no idea which folder belonged to which shop ("I do not
// know who or what they are"). This module names the folder by the site's
// operator-facing NAME instead, and migrates the old token-named folders over
// once so the existing backups become identifiable too.

import fs from 'fs';
import path from 'path';

/**
 * Folder-safe, human-readable directory name for a site's hub backups.
 * Prefers the operator name ("Ermelo"), falls back to slug, then the opaque
 * id. Sanitised to a filesystem-safe token (same scheme as the JTI / commission
 * archive receivers).
 *
 * @param {{ id?: string, name?: string, slug?: string }} site
 * @returns {string}
 */
export function siteBackupDirName(site) {
  const raw = site?.name || site?.slug || site?.id || 'unknown';
  const safe = String(raw)
    .trim()
    .replace(/[^A-Za-z0-9 ._-]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 64);
  // Never return empty (a name of all-punctuation would sanitise to '') —
  // fall back to the id so we always have a stable folder.
  return safe || String(site?.id || 'unknown');
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
