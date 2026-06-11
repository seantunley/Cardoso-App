import { Router } from 'express';
import db from '../db/index.js';
import {
  syncCreditorsFromSage,
  getSyncMeta,
  getSyncSettings,
  setSyncSettings,
  DEFAULT_VENDOR_SQL,
  DEFAULT_AP_INVOICE_SQL,
  DEFAULT_AP_PAYMENT_SQL,
  DEFAULT_AP_UNPOSTED_SQL,
  DEFAULT_AP_UNPOSTED_INVOICE_SQL,
  DEFAULT_PO_HEADER_SQL,
  DEFAULT_PO_LINE_SQL,
} from '../services/creditorSync.js';
import { logError } from '../lib/errorLog.js';
import { ageOpenItems, AP_SCHEME } from '../services/aging.js';

function isHub() { return process.env.HUB_MODE === 'true'; }

// Single permission gates the whole module — applied as middleware on
// every route. Hub mode read-only branches add their own queries.
export function createCreditorRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = Router();
  const guard = [requireAuth, requirePermission('can_access_creditors')];
  // Persisting/executing Sage SQL overrides is privileged — gate those with
  // requireAdmin, not just the module permission, so a non-admin who merely
  // has can_access_creditors can't store and run arbitrary SQL against Sage.
  const adminGuard = [requireAuth, requireAdmin];

  // ===== Sync admin =====
  router.get('/api/creditors/sync-meta', ...guard, (_req, res) => {
    try {
      if (isHub()) return res.json({ hub: true, message: 'Hub pulls creditor data from sites during ETL.' });
      res.json(getSyncMeta());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/creditors/sync', ...adminGuard, async (_req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Hub does not sync from Sage directly — data comes from sites during ETL.' });
    try {
      const summary = await syncCreditorsFromSage();
      res.json({ ok: true, summary });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      logError('routes.creditors.sync', err);
      res.status(isSageDown ? 503 : 500).json({ error: err.message });
    }
  });

  router.get('/api/creditors/sync-settings', ...adminGuard, (_req, res) => {
    try {
      res.json({
        settings: getSyncSettings(),
        defaults: {
          vendor_sql: DEFAULT_VENDOR_SQL,
          ap_invoice_sql: DEFAULT_AP_INVOICE_SQL,
          ap_payment_sql: DEFAULT_AP_PAYMENT_SQL,
          ap_unposted_sql: DEFAULT_AP_UNPOSTED_SQL,
          ap_unposted_invoice_sql: DEFAULT_AP_UNPOSTED_INVOICE_SQL,
          po_header_sql: DEFAULT_PO_HEADER_SQL,
          po_line_sql: DEFAULT_PO_LINE_SQL,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/creditors/sync-settings', ...adminGuard, (req, res) => {
    try {
      const updated = setSyncSettings(req.body || {});
      res.json({ ok: true, settings: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Summary list =====
  // GET /api/creditors — vendor list with YTD spend. YTD = current
  // calendar year. Spend = sum of AP payments + sum of received POs
  // (extended_cost * receive_ratio) — payments are authoritative once
  // we have them, but POs fill the gap for vendors whose invoices haven't
  // been paid yet. Operators can sort by any column on the page.
  router.get('/api/creditors', ...guard, (req, res) => {
    try {
      const year = String(new Date().getFullYear());
      const search = String(req.query.search || '').trim();
      const activeOnly = String(req.query.active_only || 'false') === 'true';
      // Default: hide vendors with zero outstanding balance — the operator
      // wants the summary focused on who they currently owe. Opt-out by
      // passing ?include_zero_balance=true.
      const includeZero = String(req.query.include_zero_balance || 'false') === 'true';

      const where = ['1=1'];
      const params = [];
      if (search) {
        where.push('(c.vendor_code LIKE ? OR c.vendor_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      if (activeOnly) where.push('c.is_active = 1');
      // Zero filter applies to the FULL net outstanding (unposted invoices
      // added, unposted payments subtracted) so a vendor whose true position
      // is settled behaves as settled. Rounded to the cent: an exact `<> 0`
      // let ~6 vendors whose net is float dust (fractions of a cent) through,
      // so the vendor COUNT and totals disagreed with the Aged Creditors view.
      if (!includeZero) where.push('ROUND(COALESCE(ob.outstanding, 0) + COALESCE(uninv.unposted_inv, 0) - COALESCE(unp.unposted, 0), 2) <> 0');

      // outstanding_amount is the TRUE position (operator decision, June
      // 2026): APOBL open items PLUS invoices captured in unposted AP batches
      // (APOBL doesn't list them yet — outstanding was UNDERSTATED, R44.65M
      // at build time) MINUS payments captured but not yet posted (APOBL
      // still shows their invoices open — outstanding was OVERSTATED).
      // outstanding_gross + unposted_invoices + unposted_payments are
      // returned alongside so the UI can mark affected vendors and show the
      // exact breakdown on hover.
      const rows = db.prepare(`
        SELECT
          c.vendor_code,
          c.vendor_name,
          c.terms,
          c.contact,
          c.phone,
          c.email,
          c.is_active,
          c.last_receipt_date,
          c.last_payment_date,
          COALESCE(pay.ytd_paid, 0)        AS ytd_paid,
          COALESCE(po.ytd_po_amount, 0)    AS ytd_po_amount,
          COALESCE(po.ytd_po_count, 0)     AS ytd_po_count,
          COALESCE(rcp.ytd_receipt_count, 0) AS ytd_receipt_count,
          COALESCE(ob.outstanding, 0) + COALESCE(uninv.unposted_inv, 0) - COALESCE(unp.unposted, 0) AS outstanding_amount,
          COALESCE(ob.outstanding, 0)      AS outstanding_gross,
          COALESCE(unp.unposted, 0)        AS unposted_payments,
          COALESCE(uninv.unposted_inv, 0)  AS unposted_invoices
        FROM creditor c
        LEFT JOIN (
          SELECT vendor_code, SUM(amount) AS ytd_paid
          FROM creditor_ap_payment
          WHERE substr(payment_date, 1, 4) = ?
          GROUP BY vendor_code
        ) pay ON pay.vendor_code = c.vendor_code
        LEFT JOIN (
          SELECT vendor_code,
                 SUM(total_amount) AS ytd_po_amount,
                 COUNT(*) AS ytd_po_count
          FROM creditor_po_header
          WHERE substr(po_date, 1, 4) = ?
          GROUP BY vendor_code
        ) po ON po.vendor_code = c.vendor_code
        LEFT JOIN (
          SELECT supplier_code AS vendor_code, COUNT(*) AS ytd_receipt_count
          FROM stock_receipt
          WHERE substr(receipt_date, 1, 4) = ?
          GROUP BY supplier_code
        ) rcp ON rcp.vendor_code = c.vendor_code
        LEFT JOIN (
          SELECT vendor_code, SUM(outstanding_amount) AS outstanding
          FROM creditor_ap_invoice
          GROUP BY vendor_code
        ) ob ON ob.vendor_code = c.vendor_code
        LEFT JOIN (
          SELECT vendor_code, SUM(amount) AS unposted
          FROM creditor_ap_unposted_payment
          GROUP BY vendor_code
        ) unp ON unp.vendor_code = c.vendor_code
        LEFT JOIN (
          SELECT vendor_code, SUM(amount) AS unposted_inv
          FROM creditor_ap_unposted_invoice
          GROUP BY vendor_code
        ) uninv ON uninv.vendor_code = c.vendor_code
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(pay.ytd_paid, 0) + COALESCE(po.ytd_po_amount, 0) DESC, c.vendor_name ASC
      `).all(year, year, year, ...params);

      // A/P aging summary for the on-screen tiles — open-item ledger aged by
      // the SHARED engine with the AP scheme (due date + monthly periods), so
      // the tiles agree with the Aged Creditors report.
      const apDocs = db.prepare(
        "SELECT vendor_code, document_date, due_date, outstanding_amount FROM creditor_ap_invoice WHERE source_table = 'APOBL' AND outstanding_amount <> 0"
      ).all().map((d) => ({
        entityCode: String(d.vendor_code || '').trim(),
        date: d.document_date,
        dueDate: d.due_date,
        outstanding: d.outstanding_amount,
      }));
      const aged = ageOpenItems(apDocs, { scheme: AP_SCHEME });

      // Attach each vendor's monthly buckets to its row so the client can
      // recompute the aging tiles over whatever subset its filters leave —
      // otherwise the tiles would ignore the client-side filters.
      const bucketsByVendor = new Map(aged.entities.map((e) => [e.entityCode, e.bucket_amounts]));
      for (const r of rows) {
        r.aging_buckets = bucketsByVendor.get(String(r.vendor_code || '').trim()) || null;
      }

      res.json({
        year: Number(year),
        count: rows.length,
        records: rows,
        aging: { buckets: aged.buckets, bucket_counts: aged.bucket_counts, total_outstanding: aged.total_outstanding },
      });
    } catch (err) {
      logError('routes.creditors.list', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/creditors/search?q= — typeahead for the CreditorLookup
  // component. Limited to 25 results, simple LIKE on vendor_code +
  // vendor_name. Returns the same shape the Customer search does.
  router.get('/api/creditors/search', ...guard, (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ results: [] });
      const rows = db.prepare(`
        SELECT vendor_code, vendor_name, terms, is_active
        FROM creditor
        WHERE vendor_code LIKE ? OR vendor_name LIKE ?
        ORDER BY (CASE WHEN vendor_code LIKE ? THEN 0 ELSE 1 END), vendor_name ASC
        LIMIT 25
      `).all(`%${q}%`, `%${q}%`, `${q}%`);
      res.json({ results: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/creditors/:code — single vendor detail. Caller uses this to
  // render the header (name, terms, contact) before fetching the tabs.
  router.get('/api/creditors/:code', ...guard, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT vendor_code, vendor_name, terms, contact, phone, email, is_active,
               last_receipt_date, last_payment_date, synced_at
        FROM creditor WHERE vendor_code = ?
      `).get(req.params.code);
      if (!row) return res.status(404).json({ error: 'Vendor not found' });
      // Money summary for the vendor header — same true-position arithmetic
      // as the Creditor Balances list (posted APOBL + unposted invoices −
      // unposted payments), plus the payment-capture cutoff so the header can
      // warn that recent bank payments may not be captured in Sage yet.
      const money = db.prepare(`
        SELECT
          COALESCE((SELECT SUM(outstanding_amount) FROM creditor_ap_invoice WHERE vendor_code = ?), 0) AS outstanding_gross,
          COALESCE((SELECT SUM(amount) FROM creditor_ap_unposted_invoice WHERE vendor_code = ?), 0)    AS unposted_invoices,
          COALESCE((SELECT SUM(amount) FROM creditor_ap_unposted_payment WHERE vendor_code = ?), 0)    AS unposted_payments
      `).get(req.params.code, req.params.code, req.params.code);
      const meta = db.prepare(`
        SELECT last_cb_payment_capture, last_ap_payment_date FROM creditor_sync_meta WHERE id = 1
      `).get() || {};
      res.json({
        ...row,
        ...money,
        outstanding_net: money.outstanding_gross + money.unposted_invoices - money.unposted_payments,
        last_cb_payment_capture: meta.last_cb_payment_capture || null,
        last_ap_payment_date: meta.last_ap_payment_date || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== Drilldown tabs =====
  // GET /api/creditors/:code/receipts — goods receipts joined from the
  // existing stock_receipt table. Matched on TRIM(supplier_code) since
  // both Sage tables can have padded values.
  router.get('/api/creditors/:code/receipts', ...guard, (req, res) => {
    try {
      const code = req.params.code;
      const rows = db.prepare(`
        SELECT sr.receipt_number, sr.supplier_code, sr.supplier_name, sr.receipt_date,
               srl.line_no, srl.item_number, srl.item_description, srl.qty_received,
               srl.uom, srl.unit_cost
        FROM stock_receipt sr
        JOIN stock_receipt_line srl ON srl.receipt_id = sr.id
        WHERE TRIM(sr.supplier_code) = TRIM(?)
        ORDER BY sr.receipt_date DESC, sr.receipt_number, srl.line_no
        LIMIT 500
      `).all(code);
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/creditors/:code/ap-invoices — currently outstanding AP
  // invoices for this vendor. Source is the APOBL pull, which is purged
  // and reloaded every sync (so invoices that have been paid disappear).
  router.get('/api/creditors/:code/ap-invoices', ...guard, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT document_number, document_type, document_date, due_date,
               original_amount, outstanding_amount, reference
        FROM creditor_ap_invoice
        WHERE vendor_code = ?
        ORDER BY document_date DESC
        LIMIT 500
      `).all(req.params.code);
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/creditors/:code/ap-payments — payments made to this vendor
  // within the sync window (default 24 months, configurable on the
  // sync-settings page).
  router.get('/api/creditors/:code/ap-payments', ...guard, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT payment_number, payment_date, payment_method, amount,
               reference, bank_code
        FROM creditor_ap_payment
        WHERE vendor_code = ?
        ORDER BY payment_date DESC
        LIMIT 500
      `).all(req.params.code);
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/creditors/:code/pos — purchase orders + their lines for
  // this vendor within the sync window.
  router.get('/api/creditors/:code/pos', ...guard, (req, res) => {
    try {
      const headers = db.prepare(`
        SELECT id, po_number, po_date, expected_date, status, total_amount
        FROM creditor_po_header
        WHERE vendor_code = ?
        ORDER BY po_date DESC
        LIMIT 200
      `).all(req.params.code);
      if (headers.length === 0) return res.json({ count: 0, records: [] });

      const ids = headers.map(h => h.id);
      const placeholders = ids.map(() => '?').join(',');
      const lines = db.prepare(`
        SELECT po_id, line_no, item_number, item_description,
               qty_ordered, qty_received, unit_cost, extended_cost
        FROM creditor_po_line
        WHERE po_id IN (${placeholders})
        ORDER BY po_id, line_no
      `).all(...ids);

      const byPo = new Map(headers.map(h => [h.id, { ...h, lines: [] }]));
      for (const l of lines) {
        const h = byPo.get(l.po_id);
        if (h) h.lines.push(l);
      }
      const records = headers.map(h => byPo.get(h.id));
      res.json({ count: records.length, records });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
