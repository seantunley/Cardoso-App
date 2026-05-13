#!/usr/bin/env node
// Manual disaster recovery — rebuild a site from Hub backups.
//
// USE CASE: the site machine is gone (dead disk, lost laptop, fresh
// Windows install). You have a copy of the Hub's per-site backup folder
// somewhere reachable (network share, USB drive, copied from the Hub's
// database/hub-backups/<siteId>/). This script lays down everything a
// site needs to come back to life:
//
//   - .db        → <target>/database/cardoso.db
//   - .env       → <target>/.env
//   - 3 zips     → unpacked into <target>/uploads/<bat-previews|jti-archive|bat-archive>/
//
// The Hub-push UI (Hub Admin → Sites → Restore) does the same thing
// over the network when a site is alive. This script is for the
// disconnected case: cold-start a site from a backup folder on disk.
//
// AFTER RUNNING:
//   - Reinstall the app (git clone + npm install + npm run build)
//   - Start the service — it'll find the restored DB + uploads/ in place
//
// USAGE:
//   node scripts/restore-site-from-hub-backups.mjs \
//     --backups <path-to-hub-backups-site-folder> \
//     --target  <path-to-fresh-app-install> \
//     [--at <YYYY-MM-DD-HH-MM-SS>]     # default: latest snapshot
//     [--skip-env]                      # don't overwrite an existing .env
//     [--dry-run]                       # print what would happen, don't touch disk
//
// EXAMPLE:
//   node scripts/restore-site-from-hub-backups.mjs \
//     --backups "Z:\hub-backups\58e505b3-120b-499a-b546-8ee3b780188e" \
//     --target  "C:\Cardoso Customer App"

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--skip-env') { out[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        console.error(`Missing value for ${a}`);
        process.exit(2);
      }
      out[k] = v;
      i += 1;
    }
  }
  return out;
}

function bail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function findArtifact(backupsDir, prefix, suffix, ts) {
  // ts may be null (= latest). Sort newest-first by parsed timestamp.
  // Backup filenames embed the timestamp as -YYYY-MM-DD-HH-MM-SS just
  // before the extension; sorting alphabetically on that substring is
  // equivalent to sorting chronologically.
  const files = fs.readdirSync(backupsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort()
    .reverse();
  if (ts) {
    return files.find((f) => f.includes(ts)) || null;
  }
  return files[0] || null;
}

function extractTimestamp(filename) {
  const m = filename.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\./);
  return m ? m[1] : null;
}

async function unzipInto(zipPath, destDir, dryRun) {
  // Use yauzl if available (already in tree), fall back to PowerShell
  // Expand-Archive on Windows for the standalone case where node_modules
  // might not be installed yet.
  if (dryRun) {
    console.log(`  [dry-run] would unzip ${zipPath} → ${destDir}`);
    return;
  }
  fs.mkdirSync(destDir, { recursive: true });
  let yauzl;
  try { yauzl = require('yauzl'); } catch { yauzl = null; }
  if (yauzl) {
    await new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          // Reject path-traversal entries. Zips from our own endpoints
          // are safe but a third-party-modified backup could embed
          // ../etc/passwd-style names; refuse them rather than write
          // outside destDir.
          if (entry.fileName.includes('..') || path.isAbsolute(entry.fileName)) {
            return reject(new Error(`Unsafe path in zip: ${entry.fileName}`));
          }
          const target = path.join(destDir, entry.fileName);
          if (/\/$/.test(entry.fileName)) {
            fs.mkdirSync(target, { recursive: true });
            zipfile.readEntry();
            return;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          zipfile.openReadStream(entry, (e2, readStream) => {
            if (e2) return reject(e2);
            const ws = fs.createWriteStream(target);
            readStream.pipe(ws);
            ws.on('finish', () => zipfile.readEntry());
            ws.on('error', reject);
          });
        });
        zipfile.on('end', resolve);
        zipfile.on('error', reject);
      });
    });
  } else if (process.platform === 'win32') {
    // Standalone fallback — PowerShell ships on every Windows install.
    const { execFileSync } = await import('child_process');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit' });
  } else {
    bail(`yauzl not installed and not on Windows — install dependencies first or unzip ${zipPath} manually into ${destDir}`);
  }
}

async function integrityCheck(dbPath) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { Database = null; }
  if (!Database) {
    console.warn(`  [warn] better-sqlite3 not installed — skipping PRAGMA integrity_check on ${path.basename(dbPath)}`);
    return true;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
    if (!ok) {
      console.error('  PRAGMA integrity_check FAILED:', JSON.stringify(rows).slice(0, 500));
    }
    return ok;
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.backups || !args.target) {
    console.error('Required: --backups <hub-backups-folder> --target <app-dir>');
    console.error('See header of this file for full usage.');
    process.exit(2);
  }

  const backupsDir = path.resolve(args.backups);
  const targetDir = path.resolve(args.target);
  const at = args.at || null;
  const dryRun = !!args['dry-run'];
  const skipEnv = !!args['skip-env'];

  if (!fs.existsSync(backupsDir)) bail(`Backups dir not found: ${backupsDir}`);
  if (!fs.statSync(backupsDir).isDirectory()) bail(`Not a directory: ${backupsDir}`);

  // Find the .db first — it's the anchor everything else timestamp-matches against.
  const dbFile = findArtifact(backupsDir, 'cardoso-', '.db', at);
  if (!dbFile) {
    bail(`No cardoso-*.db found in ${backupsDir}${at ? ` matching timestamp ${at}` : ''}`);
  }
  const ts = extractTimestamp(dbFile);
  if (!ts) bail(`Could not parse timestamp from ${dbFile} — expected -YYYY-MM-DD-HH-MM-SS suffix`);

  console.log(`Selected snapshot: ${dbFile}`);
  console.log(`Timestamp:         ${ts}`);
  console.log(`Source:            ${backupsDir}`);
  console.log(`Target:            ${targetDir}`);
  console.log(`Mode:              ${dryRun ? 'DRY RUN (no disk changes)' : 'LIVE'}`);
  console.log('');

  // Companion files — all match the same timestamp.
  const envFile = findArtifact(backupsDir, 'config-', '.env', ts);
  const previewsZip = findArtifact(backupsDir, 'bat-previews-', '.zip', ts);
  const jtiZip = findArtifact(backupsDir, 'jti-archive-', '.zip', ts);
  const batZip = findArtifact(backupsDir, 'bat-archive-', '.zip', ts);

  console.log('Companion artifacts (matched on timestamp):');
  console.log(`  config .env:      ${envFile || '(missing — operator must supply .env manually)'}`);
  console.log(`  bat-previews zip: ${previewsZip || '(missing — UI will show "Open PDF" only)'}`);
  console.log(`  jti-archive zip:  ${jtiZip || '(missing — JTI monthly export history will be empty)'}`);
  console.log(`  bat-archive zip:  ${batZip || '(missing — BAT supplier dispute replay unavailable)'}`);
  console.log('');

  // Pre-restore: verify the .db is not corrupt.
  const dbSrcPath = path.join(backupsDir, dbFile);
  console.log(`Verifying ${dbFile} integrity...`);
  const integrityOk = await integrityCheck(dbSrcPath);
  if (!integrityOk) {
    bail('PRAGMA integrity_check FAILED on the source .db. Refusing to restore from a corrupt snapshot. Pick an earlier timestamp with --at <TS>.');
  }
  console.log('  integrity_check: ok');
  console.log('');

  if (dryRun) {
    console.log('=== DRY RUN — the following would be done ===');
  } else {
    console.log('=== Applying restore ===');
  }

  // Lay down .db
  const liveDbPath = path.join(targetDir, 'database', 'cardoso.db');
  console.log(`[1/5] DB:           ${dbSrcPath}`);
  console.log(`         →          ${liveDbPath}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(liveDbPath), { recursive: true });
    // Stale WAL/SHM from a previous install would corrupt-look the new DB.
    for (const sidecar of ['cardoso.db-wal', 'cardoso.db-shm']) {
      const p = path.join(targetDir, 'database', sidecar);
      try { fs.unlinkSync(p); } catch {}
    }
    fs.copyFileSync(dbSrcPath, liveDbPath);
  }

  // Lay down .env
  if (envFile && !skipEnv) {
    const envSrc = path.join(backupsDir, envFile);
    const envDest = path.join(targetDir, '.env');
    console.log(`[2/5] .env:         ${envSrc}`);
    console.log(`         →          ${envDest}`);
    if (!dryRun) {
      // Don't silently clobber an existing .env without warning the
      // operator — they may have just edited it for the new install
      // (e.g. updated HUB_URL for a new network). Move aside instead.
      if (fs.existsSync(envDest)) {
        const aside = `${envDest}.before-restore-${Date.now()}`;
        fs.renameSync(envDest, aside);
        console.log(`         (existing .env moved aside to ${aside})`);
      }
      fs.copyFileSync(envSrc, envDest);
      // Best-effort mode 0600 — Windows ignores POSIX bits but
      // chmod() is a no-op rather than an error, so this is safe to
      // call unconditionally.
      try { fs.chmodSync(envDest, 0o600); } catch {}
    }
  } else {
    console.log(`[2/5] .env:         ${skipEnv ? 'SKIPPED (--skip-env)' : 'MISSING — operator must supply manually'}`);
  }

  // Lay down each uploads/ archive.
  const archiveTargets = [
    { label: 'bat-previews', zip: previewsZip, dest: path.join(targetDir, 'uploads', 'bat-previews'), step: '3/5' },
    { label: 'jti-archive',  zip: jtiZip,      dest: path.join(targetDir, 'uploads', 'jti-archive'),  step: '4/5' },
    { label: 'bat-archive',  zip: batZip,      dest: path.join(targetDir, 'uploads', 'bat-archive'),  step: '5/5' },
  ];
  for (const a of archiveTargets) {
    if (!a.zip) {
      console.log(`[${a.step}] ${a.label.padEnd(13)} MISSING — uploads/${a.label}/ left empty`);
      continue;
    }
    const srcPath = path.join(backupsDir, a.zip);
    console.log(`[${a.step}] ${a.label.padEnd(13)} ${srcPath}`);
    console.log(`         →          ${a.dest}/`);
    await unzipInto(srcPath, a.dest, dryRun);
  }

  console.log('');
  if (dryRun) {
    console.log('=== Dry run complete — no files were changed ===');
  } else {
    console.log('=== Restore complete ===');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Verify .env values are correct for this machine (SITE_ID, HUB_URL, ports, paths).');
    console.log('  2. Install/start the Cardoso service (NSSM, or `npm run start` for manual runs).');
    console.log('  3. Open the app and confirm: recent reconciliations show previews, customers load, audit log is intact.');
    console.log('  4. If anything looks wrong, the previous .env (if any) is preserved as .env.before-restore-<ts>.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});

// Allow ESM `node scripts/restore-site-from-hub-backups.mjs` invocation
// to resolve relative paths regardless of cwd. Harmless when imported.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // noop — main() above already runs unconditionally
}
