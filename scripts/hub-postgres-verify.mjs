import { verifyHubPostgresSchema } from '../src/hubPostgres/verify.js';

try {
  const result = await verifyHubPostgresSchema();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
} catch (error) {
  console.error('[hub-postgres] verification failed:', error.message);
  process.exit(1);
}
