// Local time, in one place.
//
// SQLite's CURRENT_TIMESTAMP is UTC and cannot be changed, so every timestamp
// this app stores goes through now_local() instead. That worked fine inside
// the app — but any script that opened the database directly had to reinvent
// the offset, and one that used toISOString() on its own silently wrote every
// row two hours behind. Stamps that are quietly wrong are worse than missing
// ones: nobody queries them, they just mislead later.
//
// So the offset lives here, and both the app and any script take it from here.

/** Hours ahead of UTC. South Africa is +2 all year — no daylight saving. */
export const LOCAL_OFFSET_HOURS = 2;
const LOCAL_OFFSET_MS = LOCAL_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * Local time as 'YYYY-MM-DD HH:MM:SS' — the format every timestamp column in
 * this database uses.
 *
 * @param {Date | number} [at] a moment to convert; defaults to now
 */
export function nowLocal(at) {
  const ms = at instanceof Date ? at.getTime() : (typeof at === 'number' ? at : Date.now());
  return new Date(ms + LOCAL_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Register now_local() on a better-sqlite3 connection.
 *
 * Any script that opens cardoso.db itself must call this, or its INSERTs fail
 * on an unknown function — which is the loud failure we want, rather than a
 * script quietly defining its own UTC version.
 *
 * @param {any} db a better-sqlite3 Database
 */
export function registerNowLocal(db) {
  db.function('now_local', () => nowLocal());
  return db;
}
