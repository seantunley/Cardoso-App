// Shared error-description helpers.
//
// Backstory: every fetch / SQL / SQLite boundary in this codebase used to
// pass `err.message` straight through to logError / toast.error / job
// error_message. For undici fetch that's always "fetch failed" (real cause
// on err.cause). For mssql/tedious it's often a raw code like ELOGIN. For
// better-sqlite3 it's "SqliteError: SQLITE_CONSTRAINT_FOREIGNKEY: …". The
// operator sees opaque jargon and Googles instead of reading.
//
// These helpers translate at the boundary — turning machine messages into
// readable English while preserving the raw text for the System Log
// context payload.

/** @typedef {{ code?: string, message?: string }} ErrorCauseLike */
/** @typedef {{ code?: string, message?: string, cause?: ErrorCauseLike, originalError?: ErrorCauseLike }} ErrorLike */
/** @typedef {{ host?: string, database?: string, op?: string }} SqlErrorContext */

// ── Fetch ────────────────────────────────────────────────────────────────────

// Format an undici / Node fetch failure into a string that says what went
// wrong AND where we were trying to reach. The real cause lives on
// error.cause for any network-level failure (TLS, DNS, ECONNREFUSED,
// ECONNRESET, etc.); error.message itself is just "fetch failed".
/**
 * @param {ErrorLike | null | undefined} error
 * @param {string | URL | null | undefined} [url]
 * @returns {string}
 */
export function describeFetchError(error, url) {
  const parts = [];
  if (error?.message) parts.push(error.message);
  const cause = error?.cause;
  if (cause?.code && cause?.message) {
    parts.push(`cause=${cause.code}: ${cause.message}`);
  } else if (cause?.code) {
    parts.push(`cause=${cause.code}`);
  } else if (cause?.message) {
    parts.push(`cause: ${cause.message}`);
  }
  if (url) parts.push(`url=${url}`);
  return parts.join(" — ");
}

// ── MSSQL / Tedious ──────────────────────────────────────────────────────────

// Translate the most common Sage / customer DB connection codes the
// `mssql` + `tedious` stack throws. We keep the raw err.message available
// in the context payload — this only changes the user-facing string.
//
// Codes documented at
//   https://github.com/tediousjs/tedious/blob/master/src/errors.ts
// and the mssql README. Anything not in the map falls through to the raw
// message.
/** @type {Record<string, string>} */
const MSSQL_CODE_MESSAGES = {
  ELOGIN:       "Login failed (wrong username or password)",
  ESOCKET:      "Network error reaching the SQL Server (socket dropped)",
  ETIMEOUT:     "SQL Server didn't respond in time",
  EREQUEST:     "SQL Server rejected the query",
  EALREADYCONNECTED: "Connection is already open",
  EALREADYCONNECTING: "Connection is already opening",
  ENOTOPEN:     "Connection is not open",
  ECONNCLOSED:  "Connection was closed",
  ENOTFOUND:    "SQL Server hostname could not be resolved (DNS)",
  ECONNREFUSED: "SQL Server refused the connection (wrong port or service down)",
  ECONNRESET:   "SQL Server reset the connection mid-query",
  EHOSTUNREACH: "Host unreachable — check network / Tailscale",
  EPIPE:        "SQL Server pipe broke mid-query",
  EINSTLOOKUP:  "Could not look up the SQL Server instance via SQL Browser",
};

/**
 * @param {ErrorLike | null | undefined} error
 * @param {SqlErrorContext} [context]
 * @returns {string}
 */
export function describeSqlError(error, { host, database, op } = {}) {
  if (!error) return "Unknown SQL error";
  const code = error.code || error.originalError?.code;
  const friendly = code && MSSQL_CODE_MESSAGES[code];
  const head = friendly || error.message || String(error);

  const where = [];
  if (op)       where.push(op);
  if (host)     where.push(host);
  if (database) where.push(database);
  const wherePart = where.length ? ` (${where.join(" → ")})` : "";

  // If we found a friendly mapping but the raw code is informative, append
  // it in brackets so the operator can still grep / search for it.
  const codeSuffix = friendly && code ? ` [${code}]` : "";

  return `${head}${codeSuffix}${wherePart}`;
}

// ── better-sqlite3 ───────────────────────────────────────────────────────────

// Translate the most common SQLite codes. better-sqlite3 raises
// `SqliteError` with a `code` like `SQLITE_CONSTRAINT_FOREIGNKEY`.
/** @type {Record<string, string>} */
const SQLITE_CODE_MESSAGES = {
  SQLITE_CONSTRAINT_PRIMARYKEY: "Database constraint violation: primary key conflict",
  SQLITE_CONSTRAINT_UNIQUE:     "Database constraint violation: unique value already exists",
  SQLITE_CONSTRAINT_FOREIGNKEY: "Database constraint violation: referenced row missing",
  SQLITE_CONSTRAINT_NOTNULL:    "Database constraint violation: required field is missing",
  SQLITE_CONSTRAINT_CHECK:      "Database constraint violation: value rejected by CHECK rule",
  SQLITE_CONSTRAINT:            "Database constraint violation",
  SQLITE_BUSY:                  "Database is locked by another writer",
  SQLITE_LOCKED:                "Database is locked by a transaction",
  SQLITE_READONLY:              "Database is read-only",
  SQLITE_FULL:                  "Disk is full — database can't grow",
  SQLITE_CORRUPT:               "Database file is corrupted",
  SQLITE_NOTFOUND:              "Database table or column not found",
  SQLITE_IOERR:                 "Disk I/O error reading or writing the database",
};

/**
 * @param {ErrorLike | null | undefined} error
 * @returns {string}
 */
export function describeSqliteError(error) {
  if (!error) return "Unknown database error";
  const code = error.code;
  const friendly = code && SQLITE_CODE_MESSAGES[code];
  if (friendly && code) return `${friendly} [${code}]`;
  return error.message || String(error);
}
