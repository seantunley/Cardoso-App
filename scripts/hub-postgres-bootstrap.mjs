import { runHubPostgresMigrations } from '../src/hubPostgres/migrate.js';

const dryRun = process.argv.includes('--dry-run');

try {
  const result = await runHubPostgresMigrations({ dryRun });
  if (dryRun) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[hub-postgres] schema=${result.schema}`);
    for (const row of result.completed) {
      console.log(`- ${row.status}: ${row.file}`);
    }
  }
} catch (error) {
  console.error('[hub-postgres] bootstrap failed:', error.message);
  process.exit(1);
}
