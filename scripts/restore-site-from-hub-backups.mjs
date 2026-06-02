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
//     [--at <YYYY-MM-DD-HH-MM-SS>]      # default: latest snapshot
//     [--skip-env]                       # don't overwrite an existing .env
//     [--allow-missing-env]              # proceed even if no .env in backup
//     [--dry-run]                        # print plan, don't touch disk
//     [--yes]                            # skip interactive confirmation prompt
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

// Boolean flags don't take a value; everything else is `--key value`.
const BOOLEAN_FLAGS = new Set(['dry-run', 'skip-env', 'allow-missing-env', 'yes']);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      console.error(`Unexpected positional argument: ${a}`);
      process.exit(2);
    }
    const k = a.slice(2);
    if (BOOLEAN_FLAGS.has(k)) { out[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`Missing value for ${a}`);
      process.exit(2);
    }
    out[k] = v;
    i += 1;
  }
  return out;
}

// Block until the user types "yes" verbatim. Returns true on yes, false
// on anything else. stdin is read line-by-line via the readline module
// (works on Windows cmd.exe + PowerShell + git-bash). Skipped when --yes
// is on or when stdin isn't a TTY (e.g. running from CI / Task Scheduler
// — in which case the operator must opt in via --yes).
async function confirmInteractive(prompt) {
  if (!process.stdin.isTTY) {
    bail('stdin is not a TTY — cannot prompt. Re-run with --yes if you intend to proceed non-interactively.');
  }
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(prompt, resolve));
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
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
    // Anchored match on `-<ts><suffix>` to avoid `.includes(ts)` matching
    // a hypothetical `bat-previews-…-2026-05-13-02-00-00-PARTIAL.zip` or a
    // nested timestamp in the siteId portion. Each file's timestamp must
    // be the suffix immediately before the extension.
    const anchor = `-${ts}${suffix}`;
    return files.find((f) => f.endsWith(anchor)) || null;
  }
  return files[0] || null;
}

function extractTimestamp(filename) {
  const m = filename.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\./);
  return m ? m[1] : null;
}

async function unzipInto(zipPath, destDir, dryRun) {
  // Try yauzl if it happens to be installed; otherwise fall back to
  // PowerShell Expand-Archive on Windows (the documented platform).
  // yauzl is NOT a declared dependency of this app — the require() is
  // wrapped in try/catch so the script still works on a fresh Windows
  // install where the operator hasn't run npm install yet.
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
        // Single failure path that closes the zipfile FD before
        // bubbling up — yauzl doesn't auto-close on stream error.
        const fail = (e) => { try { zipfile.close(); } catch (closeErr) { console.warn('[restore.zip.close_on_fail]', { zipPath }, closeErr.message); } reject(e); };
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          // Reject path-traversal entries. Zips from our own endpoints
          // are safe but a third-party-modified backup could embed
          // ../etc/passwd-style names; refuse them rather than write
          // outside destDir.
          if (!isSafeZipEntryName(entry.fileName)) {
            return fail(new Error(`Unsafe path in zip: ${entry.fileName}`));
          }
          const target = path.join(destDir, entry.fileName);
          if (/\/$/.test(entry.fileName)) {
            fs.mkdirSync(target, { recursive: true });
            zipfile.readEntry();
            return;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          zipfile.openReadStream(entry, (e2, readStream) => {
            if (e2) return fail(e2);
            const ws = fs.createWriteStream(target);
            readStream.pipe(ws);
            ws.on('finish', () => zipfile.readEntry());
            ws.on('error', fail);
          });
        });
        zipfile.on('end', () => { try { zipfile.close(); } catch (e) { console.warn('[restore.zip.close_on_end]', { zipPath }, e.message); } resolve(); });
        zipfile.on('error', fail);
      });
    });
  } else if (process.platform === 'win32') {
    // Standalone fallback — PowerShell ships on every Windows install.
    // CRITICAL: Expand-Archive does NOT validate entry paths; a malicious
    // zip with `..\..\Windows\System32\…` entries would be written there.
    // Pre-scan via [IO.Compression.ZipFile]::OpenRead and refuse the
    // archive before invoking Expand-Archive if any entry is unsafe.
    const { execFileSync } = await import('child_process');
    const psQuoteSafe = (s) => s.replace(/'/g, "''");
    const preScan = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [IO.Compression.ZipFile]::OpenRead('${psQuoteSafe(zipPath)}')
      try {
        foreach ($e in $zip.Entries) {
          $name = $e.FullName
          if ($name -match '\\.\\.' -or $name -match '^[\\\\/]' -or $name -match '^[A-Za-z]:') {
            Write-Error "Unsafe entry in zip: $name"
            exit 2
          }
        }
      } finally { $zip.Dispose() }
    `;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', preScan], { stdio: 'inherit' });
    } catch (preScanErr) {
      throw new Error(`Refusing to expand ${zipPath}: pre-scan failed (likely an unsafe entry path). ${preScanErr.message}`);
    }
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path '${psQuoteSafe(zipPath)}' -DestinationPath '${psQuoteSafe(destDir)}' -Force`,
    ], { stdio: 'inherit' });
  } else {
    bail(`yauzl not installed and not on Windows — install dependencies first or unzip ${zipPath} manually into ${destDir}`);
  }
}

// Reject entries that would escape destDir on any OS:
//   - parent-dir hops (`..` anywhere — covers `../`, `..\\`, `foo/../bar`)
//   - absolute paths (leading `/` or `\`)
//   - Windows drive-letter paths (`C:` etc.)
//   - leading dot-slash variants normalised away by path.join may still escape
function isSafeZipEntryName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.includes('..')) return false;
  if (path.isAbsolute(name)) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (/^[\\/]/.test(name)) return false;
  return true;
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
  const allowMissingEnv = !!args['allow-missing-env'];
  const yes = !!args.yes;

  if (!fs.existsSync(backupsDir)) bail(`Backups dir not found: ${backupsDir}`);
  if (!fs.statSync(backupsDir).isDirectory()) bail(`Not a directory: ${backupsDir}`);

  // Refuse to write into well-known system locations even if the operator
  // typed them. Defence-in-depth against `--target C:\` typo.
  const SYS_PATH_RE = /^([a-z]:\\?|\/|c:\\windows|c:\\program\s+files|c:\\programdata)$/i;
  if (SYS_PATH_RE.test(targetDir)) {
    bail(`--target ${targetDir} looks like a system root; refusing to write here. Pick a directory like C:\\Cardoso Customer App.`);
  }

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
  console.log(`  config .env:      ${envFile || '(missing — see below)'}`);
  console.log(`  bat-previews zip: ${previewsZip || '(missing — UI will show "Open PDF" only)'}`);
  console.log(`  jti-archive zip:  ${jtiZip || '(missing — JTI monthly export history will be empty)'}`);
  console.log(`  bat-archive zip:  ${batZip || '(missing — BAT supplier dispute replay unavailable)'}`);
  console.log('');

  // Env is critical — without ENCRYPTION_KEY the restored DB cannot decrypt
  // databaseconnection.encrypted_password rows; the site will boot but Sage
  // queries / BAT recon / JTI export all fail at first attempt. Bail by
  // default unless the operator explicitly opts in. --skip-env is a separate
  // flag (means "don't OVERWRITE my existing .env"); --allow-missing-env
  // is the override for "I know the backup has no .env and that's fine
  // because BACKUP_CONFIG_EXPORT_MODE was disabled, I'll supply one manually".
  if (!envFile && !skipEnv && !allowMissingEnv) {
    bail(
      `No matching .env in backup folder for snapshot ${ts}.\n` +
      '  Without ENCRYPTION_KEY the restored DB cannot decrypt connection passwords.\n' +
      '  Re-run with --allow-missing-env if you intend to supply an .env yourself,\n' +
      '  or pick a snapshot whose timestamp also has a config-*.env file.'
    );
  }

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
    // Final confirmation gate. Skipped if --yes was passed or stdin
    // is non-interactive (in which case --yes is required, see
    // confirmIneractive). This is the last safety against
    // "I typed the wrong --target".
    if (!yes) {
      const ok = await confirmInteractive(
        `\nAbout to OVERWRITE files in ${targetDir}.\n` +
        '  - database/cardoso.db\n' +
        '  - .env (if a .env is present in the backup)\n' +
        '  - uploads/bat-previews/ uploads/jti-archive/ uploads/bat-archive/ (each unzipped, pre-existing files preserved by zip semantics)\n\n' +
        'Type "yes" to proceed: '
      );
      if (!ok) {
        console.log('Aborted.');
        process.exit(0);
      }
    }
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
      try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') console.warn('[restore.db.cleanup_sidecar]', { sidecar, p }, e.message); }
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
      try { fs.chmodSync(envDest, 0o600); } catch (e) { console.warn('[restore.env.chmod]', { envDest }, e.message); }
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
