import db from '../src/db/index.js';
import { initSchema } from '../src/db/schema.js';
import { initBatSchema } from '../src/db/batSchema.js';

console.log('[bootstrap] initBatSchema...');
initBatSchema(db);
console.log('[bootstrap] initSchema (runs migrations)...');
initSchema(db);
console.log('[bootstrap] done.');
