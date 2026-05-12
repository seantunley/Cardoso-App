// Contract tests for src/services/jti/jtiSettings.js — the DB-backed
// defaults helpers. Uses an in-memory SQLite with the migration v69
// table shape so we don't need to stand up the full schema.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getJtiSettings, setJtiSettings } from '../src/services/jti/jtiSettings.js';

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jti_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

describe('getJtiSettings', () => {
  it('returns empty strings for all four fields when nothing is stored', () => {
    expect(getJtiSettings({ db })).toEqual({
      townCity: '', region: '', country: '', siteLabel: '',
    });
  });

  it('returns stored values when present', () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES (?, ?)`).run('town_city', 'ERMELO');
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES (?, ?)`).run('region', 'MPUMALANGA');
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES (?, ?)`).run('country', 'SOUTH AFRICA');
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES (?, ?)`).run('site_label', 'Ermelo');
    expect(getJtiSettings({ db })).toEqual({
      townCity: 'ERMELO',
      region: 'MPUMALANGA',
      country: 'SOUTH AFRICA',
      siteLabel: 'Ermelo',
    });
  });

  it('returns empty string for missing individual keys (partial state)', () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES (?, ?)`).run('town_city', 'ERMELO');
    expect(getJtiSettings({ db })).toEqual({
      townCity: 'ERMELO', region: '', country: '', siteLabel: '',
    });
  });

  it('throws TypeError when db is missing', () => {
    expect(() => getJtiSettings({})).toThrow(TypeError);
  });
});

describe('setJtiSettings', () => {
  it('inserts new keys', () => {
    const result = setJtiSettings({
      db, townCity: 'ERMELO', region: 'MPUMALANGA', country: 'SOUTH AFRICA', siteLabel: 'Ermelo',
    });
    expect(result).toEqual({
      townCity: 'ERMELO', region: 'MPUMALANGA', country: 'SOUTH AFRICA', siteLabel: 'Ermelo',
    });
    // Persisted in DB
    const stored = db.prepare(`SELECT key, value FROM jti_settings ORDER BY key`).all();
    expect(stored).toEqual([
      { key: 'country',    value: 'SOUTH AFRICA' },
      { key: 'region',     value: 'MPUMALANGA' },
      { key: 'site_label', value: 'Ermelo' },
      { key: 'town_city',  value: 'ERMELO' },
    ]);
  });

  it('updates existing keys (ON CONFLICT path)', () => {
    setJtiSettings({ db, townCity: 'OLD' });
    setJtiSettings({ db, townCity: 'NEW' });
    expect(getJtiSettings({ db }).townCity).toBe('NEW');
  });

  it('only touches keys present in the input (partial updates leave others alone)', () => {
    setJtiSettings({ db, townCity: 'ERMELO', region: 'MPUMALANGA' });
    setJtiSettings({ db, country: 'SOUTH AFRICA' });
    expect(getJtiSettings({ db })).toEqual({
      townCity: 'ERMELO',
      region: 'MPUMALANGA',
      country: 'SOUTH AFRICA',
      siteLabel: '',
    });
  });

  it('treats explicit empty string as "clear this value", not "leave alone"', () => {
    setJtiSettings({ db, townCity: 'ERMELO' });
    setJtiSettings({ db, townCity: '' });
    expect(getJtiSettings({ db }).townCity).toBe('');
  });

  it('coerces non-string values to strings (defensive)', () => {
    setJtiSettings({ db, townCity: 123 });
    expect(getJtiSettings({ db }).townCity).toBe('123');
  });

  it('returns the post-upsert state of all four fields', () => {
    setJtiSettings({ db, townCity: 'A' });
    const result = setJtiSettings({ db, region: 'B' });
    expect(result).toEqual({ townCity: 'A', region: 'B', country: '', siteLabel: '' });
  });

  it('updates atomically — if the transaction fails mid-way, none of the changes apply', () => {
    setJtiSettings({ db, townCity: 'ORIGINAL', region: 'ORIGINAL_REGION' });
    // Force a mid-transaction failure with an object whose toString()
    // throws. The first upsert (townCity:'X') runs successfully, the
    // second upsert (region) blows up during String() coercion. If
    // the transaction is real, the first upsert MUST be rolled back.
    const explosive = { toString() { throw new Error('boom'); } };
    expect(() => setJtiSettings({ db, townCity: 'X', region: explosive }))
      .toThrow(/boom/);
    expect(getJtiSettings({ db })).toEqual({
      townCity: 'ORIGINAL', region: 'ORIGINAL_REGION', country: '', siteLabel: '',
    });
  });

  it('throws TypeError when db is missing', () => {
    expect(() => setJtiSettings({})).toThrow(TypeError);
  });
});
