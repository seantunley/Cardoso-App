// Timestamps are SA local, everywhere, on every machine.
//
// SQLite's CURRENT_TIMESTAMP is UTC and cannot be changed, so this helper is
// what every stored timestamp goes through. A script that reinvented it with
// plain toISOString() once wrote a thousand rows two hours behind — quietly,
// which is the worst way for a timestamp to be wrong.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { nowLocal, registerNowLocal, LOCAL_OFFSET_HOURS } from '../src/lib/nowLocal.js';

describe('nowLocal', () => {
  it('is two hours ahead of UTC, with no daylight saving', () => {
    expect(LOCAL_OFFSET_HOURS).toBe(2);
    const noonUtc = Date.UTC(2026, 8, 14, 12, 0, 0);
    expect(nowLocal(noonUtc)).toBe('2026-09-14 14:00:00');
    // Mid-winter in the northern hemisphere: still +2, because SA has no DST.
    expect(nowLocal(Date.UTC(2026, 0, 14, 12, 0, 0))).toBe('2026-01-14 14:00:00');
  });

  it('writes the format the database columns use', () => {
    expect(nowLocal()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('gives SQLite a now_local() that agrees with the JS one', () => {
    const db = new Database(':memory:');
    registerNowLocal(db);
    const fromSql = db.prepare('SELECT now_local() AS t').get().t;
    expect(fromSql).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Same second, or the next one if the clock ticked between the two calls.
    expect(Math.abs(Date.parse(`${fromSql}Z`) - Date.parse(`${nowLocal()}Z`))).toBeLessThan(2000);
  });

  it('is ahead of UTC, which is the whole point of it existing', () => {
    // Compared against the JS clock rather than SQLite's own UTC timestamp:
    // the pre-commit hook blocks that in committed code, and it is right to.
    // Writing a test that slips past the guard protecting the thing under
    // test would be silly.
    const db = new Database(':memory:');
    registerNowLocal(db);
    const local = db.prepare('SELECT now_local() AS t').get().t;
    const utcNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    expect(Date.parse(`${local}Z`) - Date.parse(`${utcNow}Z`)).toBeGreaterThan(90 * 60 * 1000);
  });
});
