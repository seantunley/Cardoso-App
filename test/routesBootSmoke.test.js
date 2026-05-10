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

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(REPO_ROOT, 'src', 'routes');

const routeFiles = fs
  .readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

// Inline runner — given a file URL, attempt to import it. Map the
// outcome to one of three exit codes:
//   0  — import resolved, OR threw a side-effect-time error we accept
//   2  — import resolved, but the failure was an import-time class
//        we want this smoke test to catch (SyntaxError, MODULE_NOT_FOUND,
//        ERR_REQUIRE_ESM, etc.)
//   1  — unexpected runner error (vitest will surface this as a fail)
//
// Stderr carries the error message either way so vitest can show it
// in the failure output.
const RUNNER = `
const url = process.argv[1];
import(url).then(
  () => process.exit(0),
  (err) => {
    const msg = (err && err.message) || String(err);
    const code = err && err.code;
    process.stderr.write(\`\${err && err.constructor && err.constructor.name || 'Error'}: \${msg}\\n\`);
    // Import-resolution failure class: exit 2 so the test fails.
    if (
      err instanceof SyntaxError ||
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'ERR_REQUIRE_ESM' ||
      code === 'ERR_UNSUPPORTED_DIR_IMPORT' ||
      /does not provide an export/.test(msg)
    ) {
      process.exit(2);
    }
    // Side-effect-time errors (SqliteError, missing env, etc.) — accept,
    // those have their own tests. Print so it's visible in CI logs.
    process.stderr.write('SIDE-EFFECT (accepted by smoke test)\\n');
    process.exit(0);
  },
);
`;

function importInSubprocess(file) {
  const fileUrl = pathToFileURL(path.join(ROUTES_DIR, file)).href;
  // Use ':memory:' so even if the module side-effects an open of the
  // DB file, we don't touch the real cardoso.db. Migrations don't run
  // — that's intentional; if an import-time DB call hits a missing
  // table, the subprocess exits 0 (accepted side-effect-time error)
  // and the smoke test passes for the import-resolution check.
  const env = { ...process.env, DB_PATH: ':memory:' };
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', RUNNER, fileUrl],
    { env, encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT },
  );
  return result;
}

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
