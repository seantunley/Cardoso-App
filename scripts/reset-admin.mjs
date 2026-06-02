import bcrypt from 'bcryptjs';
import db from '../src/db/index.js';

const hash = await bcrypt.hash('admin123', 12);
const info = db.prepare(`
  UPDATE "user"
  SET password_hash = ?, must_change_password = 1
  WHERE email = 'admin@example.com'
`).run(hash);

console.log(`[reset-admin] rows updated: ${info.changes}`);
const u = db.prepare(`SELECT id, email, must_change_password FROM "user" WHERE email = 'admin@example.com'`).get();
console.log('[reset-admin] admin row:', u);
