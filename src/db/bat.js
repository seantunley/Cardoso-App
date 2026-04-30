/**
 * Separate SQLite database for the BAT Supplier Reconciliation module.
 * Isolated from the main Cardoso DB so reconciliation data doesn't bloat the
 * primary schema and so it can be backed up / purged independently.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const mainDbPath = process.env.DB_PATH || './database/cardoso.db';
const batDbPath = process.env.BAT_DB_PATH || path.join(path.dirname(mainDbPath), 'bat.db');

const dir = path.dirname(batDbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const batDb = new Database(batDbPath);
console.log(`✅ BAT SQLite database ready → ${batDbPath}`);

export default batDb;
