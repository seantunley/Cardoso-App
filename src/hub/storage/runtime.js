import db from '../../db/index.js';
import { getHubPostgresConfig } from '../../config/hubPostgres.js';
import { createSqliteHubStorageAdapter } from './adapter.js';
import { createHubRepository } from './repository.js';

let runtime = null;

export function initHubStorageRuntime() {
  if (runtime) return runtime;

  const hubPostgresConfig = getHubPostgresConfig();
  const adapter = createSqliteHubStorageAdapter(db, { hubPostgresConfig });

  runtime = {
    hubPostgresConfig,
    adapter,
    repository: createHubRepository(adapter),
    sqliteDb: db,
  };

  return runtime;
}

export function getHubStorageRuntime() {
  return runtime || initHubStorageRuntime();
}
