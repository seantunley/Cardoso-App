// Alert engine — central place to fire, resolve, and list operator alerts.
//
// Today the only delivery channel is `console.error` + a row in the
// `alerts` table (migration v61). Email comes later when SMTP_* env
// vars are added — the rule + dedup logic doesn't change, only the
// channel. Wiring an additional channel is one new function in this
// file plus an opt-in env check.
//
// Dedup is the load-bearing piece. Without it, a 1-minute scheduler
// tick that finds Sage down would write a new row every minute for
// hours. With it, the first detection writes one row; subsequent ticks
// see the active row (resolved_at IS NULL) for the same dedup_key and
// skip. When the condition clears, `resolveAlerts(dedupKey)` flips
// resolved_at and the next firing of the same condition starts fresh.

import db from '../db/index.js';

// Lazy statement cache — same reasoning as src/lib/jobRunner.js: the
// `alerts` table doesn't exist until migration v61 runs, but module
// imports happen earlier. Prepare on first use.
let _stmts = null;
function stmts() {
  if (_stmts) return _stmts;
  _stmts = {
    findActive: db.prepare(`
      SELECT id, fired_at FROM alerts
      WHERE dedup_key = ? AND resolved_at IS NULL
      LIMIT 1
    `),
    insert: db.prepare(`
      INSERT INTO alerts (rule_name, severity, message, context, dedup_key, fired_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    resolveByKey: db.prepare(`
      UPDATE alerts
      SET resolved_at = ?, resolved_by = ?
      WHERE dedup_key = ? AND resolved_at IS NULL
    `),
    resolveById: db.prepare(`
      UPDATE alerts
      SET resolved_at = ?, resolved_by = ?
      WHERE id = ? AND resolved_at IS NULL
    `),
    updateActiveByKey: db.prepare(`
      UPDATE alerts
      SET message = ?, context = ?
      WHERE dedup_key = ? AND resolved_at IS NULL
    `),
    listActive: db.prepare(`
      SELECT id, rule_name, severity, message, context, dedup_key, fired_at
      FROM alerts
      WHERE resolved_at IS NULL
      ORDER BY fired_at DESC
    `),
    listAll: db.prepare(`
      SELECT id, rule_name, severity, message, context, dedup_key, fired_at, resolved_at, resolved_by
      FROM alerts
      WHERE fired_at >= ?
      ORDER BY fired_at DESC
      LIMIT ?
    `),
    pruneOld: db.prepare(`
      DELETE FROM alerts
      WHERE resolved_at IS NOT NULL AND resolved_at < ?
    `),
  };
  return _stmts;
}

const VALID_SEVERITY = new Set(['critical', 'warning', 'info']);

/**
 * Fire an alert. Idempotent on dedup_key: if an active alert with the
 * same dedup_key already exists, this is a no-op (and returns the
 * existing alert's id). Otherwise inserts a new row and console.error's
 * the message so it's also visible in service logs.
 *
 * @param {object} a
 * @param {string} a.ruleName    — short stable identifier (e.g. 'sage-down')
 * @param {string} a.severity    — 'critical' | 'warning' | 'info'
 * @param {string} a.message     — human-readable summary
 * @param {object} [a.context]   — small JSON payload (offending values, links)
 * @param {string} a.dedupKey    — collapses repeat firings of the same condition
 * @returns {{ id, deduped: boolean }}
 */
export function fireAlert({ ruleName, severity, message, context, dedupKey }) {
  if (!VALID_SEVERITY.has(severity)) {
    throw new Error(`Invalid alert severity: ${severity}`);
  }
  if (!dedupKey) {
    throw new Error(`fireAlert called without dedupKey for rule '${ruleName}'`);
  }

  const s = stmts();
  const existing = s.findActive.get(dedupKey);
  if (existing) {
    return { id: existing.id, deduped: true };
  }

  const ctxJson = context == null ? null : JSON.stringify(context);
  const firedAt = new Date().toISOString();
  const info = s.insert.run(ruleName, severity, message, ctxJson, dedupKey, firedAt);

  // Loud-log so the alert is also visible in the service log even on
  // installs without an admin checking the UI.
  const logFn = severity === 'critical' ? console.error : console.warn;
  logFn(`[alert:${severity}] ${ruleName}: ${message}`);

  return { id: info.lastInsertRowid, deduped: false };
}

/**
 * Mark all active alerts matching `dedupKey` as resolved. Called when a
 * rule re-evaluates and finds the condition has cleared. `by` is
 * 'auto' for engine-driven resolution and 'admin' for manual ack via
 * the API.
 *
 * @returns {number} number of rows updated
 */
export function resolveAlerts(dedupKey, by = 'auto') {
  const info = stmts().resolveByKey.run(new Date().toISOString(), by, dedupKey);
  return info.changes;
}

/**
 * Refresh the message + context of the currently-active alert for a dedup_key,
 * WITHOUT resetting fired_at. For a rule whose condition persists but whose
 * detail changes over time — e.g. the JTI missing-export reason moving from "no
 * attempt yet" to "pool_unavailable" once the boot catch-up runs — this keeps
 * the single active row reflecting the LATEST state. fireAlert dedups on the key
 * and never updates, so without this the message freezes at the first-observed
 * value. No-op when no active alert exists for the key.
 *
 * @param {string} dedupKey
 * @param {{ message: string, context?: object }} fields
 * @returns {number} rows updated (0 or 1)
 */
export function updateActiveAlert(dedupKey, { message, context } = {}) {
  const ctxJson = context == null ? null : JSON.stringify(context);
  return stmts().updateActiveByKey.run(message, ctxJson, dedupKey).changes;
}

/** Mark a single alert resolved by id. Used by the admin acknowledge endpoint. */
export function acknowledgeAlert(id, by = 'admin') {
  const info = stmts().resolveById.run(new Date().toISOString(), by, id);
  return info.changes;
}

/** Currently-active alerts, newest first. Backs the admin banner / list. */
export function getActiveAlerts() {
  return stmts().listActive.all().map(parseRow);
}

/**
 * Recent alerts including resolved. For the admin history view.
 * Default window: last 7 days, max 200 rows.
 */
export function getAllAlerts({ since, limit = 200 } = {}) {
  const sinceTs = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return stmts().listAll.all(sinceTs, limit).map(parseRow);
}

/**
 * Drop resolved alerts older than `keepDays` days. Called by the
 * scheduler so the table doesn't grow unbounded.
 */
export function pruneResolvedAlerts(keepDays = 30) {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
  const info = stmts().pruneOld.run(cutoff);
  if (info.changes > 0) {
    console.log(`[alertEngine] Pruned ${info.changes} resolved alert(s) older than ${keepDays} days`);
  }
  return info.changes;
}

function parseRow(r) {
  return {
    ...r,
    context: r.context ? safeJsonParse(r.context) : null,
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
