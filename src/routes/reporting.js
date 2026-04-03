import express from 'express';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');
import db from '../db/index.js';
import { buildStatements } from '../db/statements.js';
import { expandDataRecord } from '../helpers.js';

const SITE_ID = process.env.SITE_ID || 'local';
const SITE_SLUG = process.env.SITE_SLUG || 'local';
const SITE_NAME = process.env.SITE_NAME || 'Local';

function requireReportingToken(req, res, next) {
  const token = process.env.REPORTING_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Reporting API not configured' });
  }
  if (req.headers['x-reporting-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function createReportingRouter({ requireAuth }) {
  const stmts = buildStatements(db);
  const router = express.Router();

  // GET /api/kpis
  router.get('/api/kpis', requireAuth, (req, res) => {
    try {
      const total = stmts.kpiTotalRecords.get();
      const byFlag = stmts.kpiFlagCounts.all();
      const lastSync = stmts.kpiLastSync.get();
      const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
      for (const row of byFlag) {
        if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
      }
      res.json({
        total_records: total.count,
        records_by_flag: flagCounts,
        last_sync_at: lastSync?.completed_at || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/top-balances?limit=30
  router.get('/api/top-balances', requireAuth, (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const isHub = process.env.HUB_MODE === 'true';

    const balanceWhere = `outstanding_balance IS NOT NULL
            AND outstanding_balance != ''
            AND outstanding_balance != '0'
            AND CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) > 0`;

    try {
      let rows, total;
      if (isHub) {
        total = db.prepare(`SELECT COUNT(*) AS count FROM hub_records r WHERE r.${balanceWhere}`).get().count;
        const stmt = db.prepare(`
          SELECT
            r.customer_number,
            r.customer_name,
            r.outstanding_balance,
            r.unpaid_invoices,
            r.receipts,
            r.flag_color,
            r.flag_reason,
            r.auto_flagged,
            COALESCE(s.name, r.site_id) AS site_name
          FROM hub_records r
          LEFT JOIN hub_sites s ON s.id = r.site_id
          WHERE r.${balanceWhere}
          ORDER BY CAST(REPLACE(REPLACE(r.outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
          LIMIT ? OFFSET ?
        `);
        rows = stmt.all(limit, offset).map(expandDataRecord);
      } else {
        total = db.prepare(`SELECT COUNT(*) AS count FROM datarecord WHERE ${balanceWhere}`).get().count;
        const stmt = db.prepare(`
          SELECT
            customer_number,
            customer_name,
            outstanding_balance,
            unpaid_invoices,
            receipts,
            flag_color,
            flag_reason,
            auto_flagged,
            ? AS site_name
          FROM datarecord
          WHERE ${balanceWhere}
          ORDER BY CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
          LIMIT ? OFFSET ?
        `);
        rows = stmt.all(SITE_NAME, limit, offset).map(expandDataRecord);
      }
      const totalPages = Math.ceil(total / limit);
      res.json({ records: rows, total, page, totalPages });
    } catch (err) {
      console.error('top-balances error', err);
      res.status(500).json({ error: 'Failed to fetch top balances' });
    }
  });

  // GET /api/inventory?search=&commodity=&limit=
  router.get('/api/inventory', requireAuth, (req, res) => {
    const search = (req.query.search || '').trim();
    const commodity = (req.query.commodity || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100000, 100000);
    const isHub = process.env.HUB_MODE === 'true';
    try {
      const conditions = [];
      const params = [];
      if (search) {
        conditions.push('(item_number LIKE ? OR item_description LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      if (commodity) {
        conditions.push('CAST(commodity AS TEXT) = ?');
        params.push(commodity);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      let rows;
      if (isHub) {
        const hubWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        rows = db.prepare(
          `SELECT i.id, i.site_id, COALESCE(s.name, i.site_id) AS site_name,
                  i.item_number, i.item_description, i.qty_on_hand, i.last_cost,
                  i.price_list, i.price, i.stocking_uom, i.commodity, i.inventory_value, i.terms, i.synced_at
           FROM hub_inventory i
           LEFT JOIN hub_sites s ON s.id = i.site_id
           ${hubWhere} ORDER BY i.item_number ASC LIMIT ?`
        ).all(...params);
      } else {
        rows = db.prepare(
          `SELECT * FROM inventoryrecord ${where} ORDER BY item_number ASC LIMIT ?`
        ).all(...params);
      }
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      console.error('inventory error', err);
      res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  });

  // ==================== MULTI-SITE REPORTING API ====================

  // GET /api/reporting/site-info
  router.get('/api/reporting/site-info', requireReportingToken, (req, res) => {
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      site_name: SITE_NAME,
      app_version: APP_VERSION,
      schema_version: 1,
      reporting_at: new Date().toISOString(),
    });
  });

  // GET /api/reporting/kpis
  router.get('/api/reporting/kpis', requireReportingToken, (req, res) => {
    const total = stmts.kpiTotalRecords.get();
    const byFlag = stmts.kpiFlagCounts.all();
    const lastSync = stmts.kpiLastSync.get();
    const activeConns = stmts.kpiActiveConns.get();

    const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
    for (const row of byFlag) {
      if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
    }

    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      total_records: total.count,
      records_by_flag: flagCounts,
      last_sync_at: lastSync?.completed_at || null,
      active_connections: activeConns.count,
      generated_at: new Date().toISOString(),
    });
  });

  // GET /api/reporting/records?since=ISO_DATE&offset=0&limit=1000
  router.get('/api/reporting/records', requireReportingToken, (req, res) => {
    const since = req.query.since;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
    const offset = parseInt(req.query.offset) || 0;
    let rows;
    if (since) {
      rows = db.prepare(
        `SELECT id, customer_number, customer_name, flag_color, flag_reason,
                outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
                updated_date, synced_at, source_table, source_id
         FROM datarecord WHERE updated_date > ? ORDER BY updated_date ASC LIMIT ? OFFSET ?`
      ).all(since, limit, offset);
    } else {
      rows = db.prepare(
        `SELECT id, customer_number, customer_name, flag_color, flag_reason,
                outstanding_balance, unpaid_invoices, receipts, auto_flagged, terms,
                updated_date, synced_at, source_table, source_id
         FROM datarecord ORDER BY updated_date ASC LIMIT ? OFFSET ?`
      ).all(limit, offset);
    }
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      since: since || null,
      offset,
      limit,
      count: rows.length,
      has_more: rows.length === limit,
      records: rows,
    });
  });

  // GET /api/reporting/health
  router.get('/api/reporting/health', requireReportingToken, (req, res) => {
    const total = stmts.kpiTotalRecords.get();
    const lastRun = stmts.kpiLastRun.get();
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      status: 'ok',
      db_record_count: total.count,
      last_sync_status: lastRun?.status || null,
      last_sync_at: lastRun?.completed_at || null,
      uptime_seconds: Math.floor(process.uptime()),
      checked_at: new Date().toISOString(),
    });
  });

  // GET /api/reporting/inventory?offset=0&limit=1000
  router.get('/api/reporting/inventory', requireReportingToken, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const rows = db.prepare(
      `SELECT id, source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, updated_date
       FROM inventoryrecord ORDER BY item_number ASC LIMIT ? OFFSET ?`
    ).all(limit, offset);
    res.json({
      site_id: SITE_ID,
      site_slug: SITE_SLUG,
      offset,
      limit,
      count: rows.length,
      has_more: rows.length === limit,
      records: rows,
    });
  });

  return router;
}


