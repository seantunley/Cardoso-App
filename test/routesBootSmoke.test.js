// Boot-time smoke test for every route module under src/routes/.
//
// Why this exists: the route modules are eagerly imported at the top
// of server.js. Any top-level import-resolution failure inside one
// of them — a CJS-only package imported as default ESM (the archiver
// bug that crashed prod 2026-05-10 and previously after PR #210/#211),
// a missing module, a syntax error in shared lib code — kills the
// entire service before it can listen. The installer reports
// "service won't start" with a stack buried in the Windows event
// log and the operator is dead in the water.
//
// CI catches none of that today: lint sees individual files; vitest
// only exercises modules its other tests already import (jobRunner,
// env, alertRules, etc.). The route modules themselves had zero
// direct import coverage until this file.
//
// Why a subprocess: vitest runs imports through Vite's transform
// pipeline, which has its own ESM/CJS interop layer that is more
// permissive than Node's native loader. A `import archiver from 'archiver'`
// that THROWS at boot under `node server.js` (the production path)
// resolves cleanly under vitest and the bug slips through. To exercise
// the real boot path we spawn `node --input-type=module -e "import(...)"`
// for each route file and assert exit status.
//
// What we accept vs reject: the goal is to catch import-resolution
// failures (SyntaxError on ESM/CJS interop, ERR_MODULE_NOT_FOUND for
// missing deps, syntax errors in transitively imported source). We
// explicitly accept side-effect-time errors (SqliteError "no such
// table", missing-env-var assertions, etc.) — those happen after
// the module has loaded and are out of scope for an import smoke
// test. They have their own per-feature tests.
//
// If you add a new route module under src/routes/, no change is
// needed here — the test discovers files via fs.readdirSync.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(REPO_ROOT, 'src', 'routes');

// Real schema-loaded temp DB. Without this, several lib modules
// (audit.js, statements.js via syncEngine.js) call db.prepare at
// top level with table names that wouldn't exist in a blank file,
// so the static ESM import phase rejects with a SqliteError BEFORE
// the route module body ever runs. That would mask import-time
// bugs further down the file (e.g. a broken createRequire on
// line N appearing after a healthy import on line 1) — Codex
// review caught the smoke runner falling through to the accepted-
// side-effect arm in exactly this scenario.
//
// We hand-roll the minimum CREATE TABLE statements the lib import
// chain touches (audit.js → auditlog; statements.js → user,
// datarecord, syncrun, databaseconnection, autoflagrule;
// hub-mode-only refs → hub_settings, hub_sites). Importing the
// real schema.js → runMigrations chain is brittle here: migration
// replay against a blank file hits ordering bugs unrelated to
// what we're testing.
// Column shapes mirror src/db/schema.js so better-sqlite3's prepare-time
// column validation is satisfied. If a future PR widens audit.js or
// statements.js to reference a new column, this block needs the same
// addition. (Better than chasing the live schema.js: importing schema.js
// drags in runMigrations, whose replay against a blank file hits
// ordering bugs unrelated to this test.)
const SMOKE_SCHEMA = `
  CREATE TABLE "user" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    full_name TEXT,
    password_hash TEXT,
    role TEXT,
    theme_preference TEXT,
    created_date TEXT
  );
  CREATE TABLE auditlog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT,
    user_email TEXT,
    user_name TEXT,
    resource_type TEXT,
    resource_id TEXT,
    resource_name TEXT,
    action_details TEXT,
    changes TEXT,
    ip_address TEXT,
    status TEXT,
    created_date TEXT
  );
  CREATE TABLE datarecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_color TEXT,
    flag_reason TEXT,
    auto_flagged INTEGER,
    flag_source TEXT,
    outstanding_balance TEXT
  );
  CREATE TABLE syncrun (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER,
    status TEXT,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE TABLE databaseconnection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT
  );
  CREATE TABLE autoflagrule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    is_active INTEGER,
    priority INTEGER
  );
  CREATE TABLE hub_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE hub_sites (
    id TEXT PRIMARY KEY,
    name TEXT,
    url TEXT,
    token TEXT
  );
`;

let TEMP_DB_PATH = '';

const routeFiles = fs
  .readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

// Inline runner — given a file URL, attempt to import it. Map the
// outcome to one of three exit codes:
//   0  — import resolved cleanly, OR threw a recognised side-effect-
//        time error that is out of scope for this smoke test
//   2  — import-time failure we WANT the test to catch (any
//        error that isn't on the side-effect allowlist)
//   1  — unexpected runner error (vitest will surface this as a fail)
//
// Default-fail polarity is load-bearing: Codex review caught an
// earlier version that used a small allowlist of failure codes
// and treated everything else as side-effect — that let new Node
// loader codes silently slip through (e.g. ERR_PACKAGE_PATH_NOT_EXPORTED
// from a non-exported subpath import). Inverting the polarity
// means any future loader/parse error class is caught by default,
// and only explicitly-recognised evaluation-time errors pass.
//
// What we accept (the allowlist):
//   - better-sqlite3 errors raised when a route's lib chain calls
//     db.prepare/run/etc. at top level against the slim test schema.
//     These are NOT import-resolution issues — they live in the
//     module body, AFTER import resolution succeeded. Identified
//     by constructor name (SqliteError) and/or code prefix
//     (SQLITE_*). Per-feature tests cover query behaviour; this
//     test only cares about reaching the body in the first place.
//
// Everything else — SyntaxError, every ERR_* loader code (known
// and yet-to-be-added), MODULE_NOT_FOUND from CJS createRequire,
// "does not provide an export" messages, any unrecognised import
// failure — exits 2 and fails the test with the original error
// message visible in stderr.
//
// Stderr carries the error message either way so vitest can show
// it in the failure output.
const RUNNER = `
const url = process.argv[1];
import(url).then(
  () => process.exit(0),
  (err) => {
    const msg = (err && err.message) || String(err);
    const code = err && err.code;
    const name = err && err.constructor && err.constructor.name;
    process.stderr.write(\`\${name || 'Error'}: \${msg}\\n\`);
    if (code) process.stderr.write(\`code=\${code}\\n\`);

    // Side-effect allowlist — better-sqlite3 errors raised inside a
    // transitively-imported module's body. Anything else is treated
    // as an import-time failure.
    const isSqliteSideEffect =
      name === 'SqliteError' ||
      (typeof code === 'string' && code.startsWith('SQLITE_'));

    if (isSqliteSideEffect) {
      process.stderr.write('SIDE-EFFECT (accepted by smoke test)\\n');
      process.exit(0);
    }

    process.exit(2);
  },
);
`;

function importInSubprocess(file) {
  const fileUrl = pathToFileURL(path.join(ROUTES_DIR, file)).href;
  // Point at the schema-loaded temp DB created in beforeAll so the
  // import graph completes — see the TEMP_DB_PATH comment above.
  const env = { ...process.env, DB_PATH: TEMP_DB_PATH };
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', RUNNER, fileUrl],
    { env, encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT },
  );
  return result;
}

beforeAll(() => {
  TEMP_DB_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cardoso-smoke-')),
    'schema.db',
  );
  const db = new Database(TEMP_DB_PATH);
  db.exec(SMOKE_SCHEMA);
  db.close();
});

afterAll(() => {
  if (TEMP_DB_PATH && fs.existsSync(TEMP_DB_PATH)) {
    try {
      fs.rmSync(path.dirname(TEMP_DB_PATH), { recursive: true, force: true });
    } catch {
      // best-effort cleanup; tempdir gets reaped by the OS eventually
    }
  }
});

describe('src/routes/* — boot-time import smoke test', () => {
  it('discovers at least one route module (sanity check)', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  for (const file of routeFiles) {
    it(`imports ${file} without an import-resolution failure`, () => {
      const r = importInSubprocess(file);
      // Exit 2 from the runner = caught the bug class we care about.
      // Anything other than 0/2 is a runner failure or a timeout.
      if (r.status === 2) {
        throw new Error(
          `${file} failed import-time resolution under Node:\n${r.stderr}`,
        );
      }
      if (r.status !== 0) {
        throw new Error(
          `Unexpected subprocess exit ${r.status} importing ${file}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      }
    });
  }
});
