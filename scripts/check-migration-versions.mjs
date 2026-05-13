// scripts/check-migration-versions.mjs
//
// CI gate that asserts every committed migration in src/db/migrations.js
// has a contiguous version number, no gaps and no duplicates.
//
// Why: between 2026-05-08 and 2026-05-12 the project hit a class of
// "merge-loss" bug where two parallel feature PRs each added a
// migration with the same version, the conflict resolution dropped
// one half, and the runtime contract broke in production. The
// missing v62 only surfaced when a downstream operation hit the
// schema gap. Catching this at PR-open time is a half-hour of CI;
// catching it after deploy is a controlled incident plus a rollback.
//
// Logic:
//   1. Import buildMigrations(db) with a no-op stub db (we only need
//      the version numbers — the up() functions don't run at array
//      build time).
//   2. Extract versions, sort, assert:
//        - first version === 1
//        - no duplicates
//        - max(version) === array length (i.e. contiguous from 1..N)
//   3. Exit 0 on success, non-zero with a diagnostic on failure.
//
// Documented in docs/plans/tech-debt.md ("CI guard for migration
// version contiguity").

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dynamic import() on Windows rejects raw paths — must be a file:// URL.
const migrationsPath = pathToFileURL(resolve(__dirname, '..', 'src/db/migrations.js')).href;

// Stub satisfies the ensureColumn/ensureTable helper signatures without
// actually touching SQLite. buildMigrations only stores db as a closure
// for the up() functions — it doesn't call db at array-build time, so
// these stubs never fire. Safe even if a future version's array-build
// reaches for db (the stub gracefully returns empty results).
const stubDb = {
  prepare: () => ({
    all: () => [],
    get: () => null,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
  }),
  exec: () => {},
  transaction: (fn) => fn,
};

const { buildMigrations } = await import(migrationsPath);
const migrations = buildMigrations(stubDb);

const versions = migrations.map((m, i) => {
  if (typeof m?.version !== 'number') {
    console.error(`[check-migration-versions] FAIL: migration #${i} has no numeric version field (got ${JSON.stringify(m?.version)})`);
    process.exit(1);
  }
  return m.version;
});

if (versions.length === 0) {
  console.error('[check-migration-versions] FAIL: buildMigrations returned an empty array');
  process.exit(1);
}

const sorted = [...versions].sort((a, b) => a - b);
const unique = new Set(versions);
const max = sorted[sorted.length - 1];

if (unique.size !== versions.length) {
  // Find which version(s) are duplicated for an actionable message.
  const counts = new Map();
  for (const v of versions) counts.set(v, (counts.get(v) || 0) + 1);
  const dups = [...counts.entries()].filter(([, c]) => c > 1).map(([v]) => v);
  console.error(`[check-migration-versions] FAIL: duplicate migration version(s): ${dups.join(', ')}`);
  console.error('  Two PRs likely each added a migration with the same number. Renumber one and retry.');
  process.exit(1);
}

if (sorted[0] !== 1) {
  console.error(`[check-migration-versions] FAIL: first migration version is ${sorted[0]}, expected 1`);
  process.exit(1);
}

if (max !== versions.length) {
  // Find which version(s) are missing in the sequence.
  const missing = [];
  for (let v = 1; v <= max; v++) {
    if (!unique.has(v)) missing.push(v);
  }
  console.error(`[check-migration-versions] FAIL: migration version sequence is not contiguous (length=${versions.length}, max=${max})`);
  console.error(`  Missing version(s): ${missing.join(', ')}`);
  console.error('  A parallel merge likely dropped a version. Add the missing migration(s) back.');
  process.exit(1);
}

console.log(`[check-migration-versions] OK — ${versions.length} migrations, versions 1..${max} contiguous and unique`);
