// Shared migration helpers — extracted from src/db/migrations.js so each
// per-version file can import them directly. Behaviour is identical to
// the original closures.
export function ensureColumn(db, tableName, columnName, definition) {
  const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all();
  const exists = cols.some((c) => c.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE "${tableName}" ADD COLUMN ${columnName} ${definition}`);
  }
}

export function ensureTable(db, tableName, definition) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${definition})`);
  } catch (e) {
    console.error('[migrations.ensureTable] CREATE TABLE failed', { table: tableName }, e.message);
  }
}
