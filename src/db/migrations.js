/**
 * Database migrations — versioned schema changes.
 *
 * Each migration lives in its own file under ./migrations/vNNN_<name>.js
 * and is registered in ./migrations/index.js. Migrations run in version
 * order, exactly once per database; schema_migrations tracks which
 * versions have been applied.
 *
 * To add a new migration:
 *   1. Create ./migrations/vNNN_short_name.js exporting { version, name, up(db) {} }
 *   2. Add the import + array entry to ./migrations/index.js
 *   3. Bump version by 1 over the highest existing one
 */
import migrations from './migrations/index.js';
import { ensureColumn, ensureTable } from './migrations/_helpers.js';

function buildMigrations(db) {
  // Returns the migrations array with up() pre-bound to db so callers can
  // invoke `migration.up()` without passing db each time (preserves the
  // pre-split call signature used elsewhere). New code should prefer
  // `migration.up(db)` directly via the underlying module.
  return migrations.map((m) => ({
    version: m.version,
    name: m.name,
    up: () => m.up(db),
  }));
}

function runMigrations(db) {
  for (const migration of migrations) {
    const already = db.prepare('SELECT id FROM schema_migrations WHERE version = ?').get(migration.version);
    if (already) continue;
    const run = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
    });
    try {
      run();
      console.log(`[migration] Applied v${migration.version}: ${migration.name}`);
    } catch (err) {
      console.error(`[migration] Failed v${migration.version} (${migration.name}):`, err.message);
      throw err;
    }
  }
}

export { ensureColumn, ensureTable, buildMigrations, runMigrations };
