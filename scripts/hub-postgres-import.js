#!/usr/bin/env node
/**
 * scripts/hub-postgres-import.js
 *
 * Ralph-loop Day 3 Slice 1: SQLite → Postgres backfill export script.
 *
 * Reads Hub's local SQLite hub_records table, exports records as JSONLines
 * to a staging file compatible with the Postgres schema from Day 2 (Forge).
 *
 * Usage:
 *   node scripts/hub-postgres-import.js                    # export all sites
 *   node scripts/hub-postgres-import.js --site=ermelo-001  # export single site
 *   node scripts/hub-postgres-import.js --dry-run          # preview without writing
 *
 * Output: tmp/hub-export-<YYYYMMDD>-<site>.jsonl
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TMP = resolve(ROOT, 'tmp');

// ── Config ──────────────────────────────────────────────────────────────────
const DB_PATH = process.env.CARDOSO_DB_PATH
  || resolve(ROOT, 'data', 'cardoso-hub.db');

const FLAG_COLORS = new Set(['none', 'red', 'orange', 'green']);

// ── Helpers ─────────────────────────────────────────────────────────────────
function parseAmount(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

function safeJson(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); }
  catch { return null; }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const SITE_FILTER = process.argv.includes('--dry-run') ? null : process.argv
  .find(a => a.startsWith('--site='))?.split('=')[1] ?? null;

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

async function main() {
  // Dynamically import better-sqlite3
  let db;
  try {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    db = new BetterSqlite3(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`[hub-postgres-import] Failed to open SQLite DB at "${DB_PATH}": ${err.message}`);
    console.error('Set CARDOSO_DB_PATH env var to point to the Hub SQLite database.');
    process.exit(1);
  }

  // ── Pull site registry ─────────────────────────────────────────────────────
  const siteRows = db.prepare(`
    SELECT id, slug, name, url, token, status FROM hub_sites
    ${SITE_FILTER ? 'WHERE id = ? OR slug = ?' : ''}
  `).all(...SITE_FILTER ? [SITE_FILTER, SITE_FILTER] : []);

  if (siteRows.length === 0) {
    if (SITE_FILTER) {
      console.warn(`[hub-postgres-import] No site found matching "${SITE_FILTER}"`);
    } else {
      console.warn('[hub-postgres-import] No sites in hub_sites — nothing to export');
    }
    db.close();
    process.exit(0);
  }

  console.log(`[hub-postgres-import] Found ${siteRows.length} site(s)`);

  // ── Export each site ───────────────────────────────────────────────────────
  mkdirSync(TMP, { recursive: true });
  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const results = [];

  for (const site of siteRows) {
    const { id: siteId, slug, name } = site;
    console.log(`\n  Exporting ${name} (${slug})…`);

    if (DRY_RUN) {
      const count = db.prepare('SELECT COUNT(*) as n FROM hub_records WHERE site_id = ?').get(siteId)?.n ?? 0;
      console.log(`    [dry-run] would export ${count} records`);
      results.push({ site, status: 'dry-run', count });
      continue;
    }

    const outFile = resolve(TMP, `hub-export-${dateTag}-${slug}.jsonl`);
    const stmt = db.prepare(`
      SELECT
        site_id, record_id, customer_number, customer_name,
        flag_color, flag_reason, flag_created_by,
        outstanding_balance, unpaid_invoices, receipts,
        updated_date, synced_at, auto_flagged, terms
      FROM hub_records
      WHERE site_id = ?
      ORDER BY updated_date DESC
    `);

    const records = stmt.all(siteId);
    let written = 0;

    const validRecords = [];
    const errors = [];

    for (const row of records) {
      const rec = {
        site_id: row.site_id,
        record_id: row.record_id,
        customer_number: row.customer_number,
        customer_name: row.customer_name,
        flag_color: FLAG_COLORS.has(row.flag_color) ? row.flag_color : 'none',
        flag_reason: row.flag_reason ?? null,
        flag_created_by: row.flag_created_by ?? null,
        outstanding_balance: parseAmount(row.outstanding_balance),
        unpaid_invoices: safeJson(row.unpaid_invoices) ?? [],
        receipts: safeJson(row.receipts) ?? [],
        auto_flagged: row.auto_flagged === 1,
        terms: row.terms ?? null,
        source_updated_date: row.updated_date,
        source_synced_at: row.synced_at,
      };
      validRecords.push(rec);
    }

    // Write in batches
    const chunks = chunkArray(validRecords, BATCH_SIZE);
    const fh = writeFileSync(outFile, ''); // truncate
    for (const chunk of chunks) {
      const lines = chunk.map(r => JSON.stringify(r)).join('\n') + '\n';
      writeFileSync(outFile, lines, { flag: 'a' });
      written += chunk.length;
    }

    console.log(`    exported ${written} records → ${outFile}`);
    results.push({ site, status: 'ok', count: written, outFile });
  }

  db.close();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n[hub-postgres-import] Done.');
  for (const r of results) {
    const label = `${r.site.slug} (${r.site.name})`;
    if (r.status === 'dry-run') {
      console.log(`  ${label}: ${r.count} records (dry-run)`);
    } else {
      console.log(`  ${label}: ${r.count} records → ${r.outFile}`);
    }
  }
}

main().catch(err => {
  console.error('[hub-postgres-import] Unexpected error:', err);
  process.exit(1);
});