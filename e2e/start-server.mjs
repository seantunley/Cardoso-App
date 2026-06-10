// E2E server bootstrap: fresh scratch DB → migrate → start the real server.
//
// Why not let server.js handle a fresh DB itself: several modules
// (src/db/statements.js via syncEngine, src/lib/errorLog.js, …) prepare
// statements at module load, and ESM hoists static imports — so on a
// completely empty database the import graph crashes before server.js's own
// initSchema/runMigrations lines execute. Real sites always carry an existing
// DB; the e2e scratch DB starts empty. Running the DDL here and THEN
// dynamically importing server.js sidesteps the hoisting: by the time the
// server's import graph loads, every table exists — the same world a real
// site boots into. (Playwright launches webServer commands before
// globalSetup, so this must live in the server command itself.)
//
// DB_PATH/PORT/HUB_MODE come from the playwright.config.js webServer command.
import fs from 'fs';
import path from 'path';

const base = path.resolve(process.env.DB_PATH || './database/e2e-cardoso.db');
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(base + suffix, { force: true });
}

// Same sequence + ordering as server.js (BAT schema before main migrations).
const { default: db } = await import('../src/db/index.js');
const { initBatSchema } = await import('../src/db/batSchema.js');
const { initSchema } = await import('../src/db/schema.js');
const { runMigrations } = await import('../src/db/migrations.js');
initBatSchema(db);
initSchema(db);
runMigrations(db);
console.log('[e2e] scratch DB migrated — starting server');

await import('../server.js');
