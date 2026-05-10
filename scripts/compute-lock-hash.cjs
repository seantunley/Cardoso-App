// Compute the lock_hash used by the in-app delta updater.
//
// See .github/workflows/build-windows.yml for the wider context. The hash
// determines whether the next release ships only the small app zip
// (lock_hash matches the installed marker → delta path) or forces the
// full NSIS installer (lock_hash differs → dependencies changed).
//
// We hash a NORMALIZED view of `packages` — sorted by key, root entry
// stripped of its `version` field — instead of the raw package-lock.json
// SHA. Hashing the raw file made `npm version` flip the hash on every
// release because the root `packages[""].version` field is rewritten by
// npm in lockstep with package.json. That kept the delta path effectively
// dead for any release that bumped the version, even when no dependencies
// changed.
//
// Implemented in CommonJS so this script can be invoked directly via
// `node scripts/compute-lock-hash.cjs` without ESM loader gymnastics —
// the rest of the app is ESM but a one-shot build helper doesn't justify
// the overhead, and it has to run before npm install / dist build steps
// where the ESM tooling may not yet be ready.
//
// Initial implementation tried to do this in PowerShell. Windows
// PowerShell 5.1's ConvertFrom-Json rejects package-lock.json's root
// empty-string key (`packages[""]`) as an invalid PSCustomObject property
// name, so the pipeline failed at parse time. Node has no such
// restriction.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const lockPath = path.resolve(process.cwd(), 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

if (!lock || typeof lock.packages !== 'object' || lock.packages === null) {
  console.error('compute-lock-hash: package-lock.json has no `packages` object — refusing to compute hash on a malformed lockfile.');
  process.exit(1);
}

const normalized = {};
for (const key of Object.keys(lock.packages).sort()) {
  let value = lock.packages[key];
  if (key === '') {
    // Root entry mirrors package.json — drop fields that change with a
    // version bump but have no effect on installed node_modules. Only
    // `version` qualifies today; `name` and other root metadata are
    // stable, but we use destructuring rather than a delete-from-copy so
    // future fields with the same property are easy to add.
    const { version: _ignored, ...rest } = value;
    value = rest;
  }
  normalized[key] = value;
}

const hash = crypto
  .createHash('sha256')
  .update(JSON.stringify(normalized))
  .digest('hex');

// Append to GITHUB_OUTPUT when running under Actions; always log to
// stdout so a local invocation surfaces the value too.
console.log(`lock_hash=${hash}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `lock_hash=${hash}\n`);
}
