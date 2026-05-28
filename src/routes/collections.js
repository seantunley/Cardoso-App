import express from 'express';
import db from '../db/index.js';
import { logAudit } from '../lib/audit.js';
import {
  listWorklists, createWorklist, getWorklist, updateWorklist, archiveWorklist,
  listAssignmentsForWorklist, getAssignment, addAssignment, bulkAddAssignments,
  setAssignmentFollowup, setAssignmentStatus,
  addActivity, listActivityForCustomer,
  processCollectionBalanceDelta,
} from '../services/collectionsService.js';

function parseAmount(value) {
  const num = parseFloat(String(value ?? '').replace(/,/g, '').replace(/\s/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function getFlagLabel(color) {
  if (color === 'red') return 'Hold';
  if (color === 'orange') return 'Caution';
  return color || '';
}

export function createCollectionsRouter({ requireAuth, requirePermission }) {
  const router = express.Router();
  const guard = [requireAuth, requirePermission('can_access_collections')];

  // ── Legacy endpoints ──────────────────────────────────────────
  // Kept until the new UI fully replaces the old one. The new UI
  // reads from /api/collections/worklists.

  router.get('/api/collections', ...guard, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT
          d.id, d.id AS customer_id, d.customer_name AS name,
          d.outstanding_balance, d.flag_color, d.flag_reason, d.terms,
          COALESCE(c.status, 'pending') AS status,
          c.contacted_at,
          COALESCE(c.notes, '') AS notes
        FROM datarecord d
        LEFT JOIN collections c ON c.customer_id = d.id
        WHERE d.flag_color IN ('red', 'orange')
        ORDER BY COALESCE(d.outstanding_balance_num, 0) DESC,
                 d.customer_name ASC
      `).all();
      res.json(rows.map((row) => ({
        ...row,
        flag_label: getFlagLabel(row.flag_color),
        outstanding_balance_numeric: parseAmount(row.outstanding_balance),
      })));
    } catch (error) {
      console.error('collections list error:', error);
      res.status(500).json({ error: 'Failed to load collections pipeline' });
    }
  });

  router.put('/api/collections/:customer_id', ...guard, (req, res) => {
    const customerId = String(req.params.customer_id || '').trim();
    const status = String(req.body?.status || 'pending').trim().toLowerCase();
    const notes = String(req.body?.notes || '');
    const validStatuses = new Set(['pending', 'contacted', 'promised', 'resolved']);
    if (!customerId) return res.status(400).json({ error: 'Customer id is required' });
    if (!validStatuses.has(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
      const existingCustomer = db.prepare(`SELECT id FROM datarecord WHERE id = ?`).get(customerId);
      if (!existingCustomer) return res.status(404).json({ error: 'Customer not found' });
      const existing = db.prepare(`SELECT * FROM collections WHERE customer_id = ?`).get(customerId);
      const now = new Date().toISOString();
      const contactedAt = existing?.contacted_at || (status === 'contacted' ? now : null);
      if (existing) {
        db.prepare(`UPDATE collections SET status = ?, notes = ?, contacted_at = ?, updated_at = ? WHERE customer_id = ?`)
          .run(status, notes, contactedAt, now, customerId);
      } else {
        db.prepare(`INSERT INTO collections (customer_id, status, contacted_at, notes, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .run(customerId, status, contactedAt, notes, now);
      }
      const updated = db.prepare(`
        SELECT d.id, d.id AS customer_id, d.customer_name AS name,
               d.outstanding_balance, d.flag_color, d.flag_reason, d.terms,
               c.status, c.contacted_at, COALESCE(c.notes, '') AS notes
        FROM datarecord d
        LEFT JOIN collections c ON c.customer_id = d.id
        WHERE d.id = ?
      `).get(customerId);
      const beforeStatus = existing?.status || 'pending';
      const beforeNotes = existing?.notes || '';
      if (beforeStatus !== status || beforeNotes !== notes) {
        logAudit({
          req, action: 'update_collection', resourceType: 'record',
          resourceId: customerId, resourceName: updated?.name || `Customer ${customerId}`,
          changes: { before: { status: beforeStatus, notes: beforeNotes }, after: { status, notes } },
        });
      }
      res.json({
        ...updated,
        flag_label: getFlagLabel(updated?.flag_color),
        outstanding_balance_numeric: parseAmount(updated?.outstanding_balance),
      });
    } catch (error) {
      console.error('collections update error:', error);
      res.status(500).json({ error: 'Failed to update collections item' });
    }
  });

  // ── Worklists ─────────────────────────────────────────────────

  router.get('/api/collections/worklists', ...guard, (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === 'true' || req.query.includeArchived === '1';
      res.json({ worklists: listWorklists({ includeArchived }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/collections/worklists', ...guard, (req, res) => {
    try {
      const { name, owner_user_id, description } = req.body || {};
      const w = createWorklist({
        name,
        ownerUserId: owner_user_id || null,
        description: description || null,
        createdByUserId: req.currentUser?.id || null,
      });
      logAudit({
        req, action: 'create_worklist', resourceType: 'collection_worklist',
        resourceId: String(w.id), resourceName: w.name,
      });
      res.json({ worklist: w });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/collections/worklists/:id', ...guard, (req, res) => {
    try {
      const w = getWorklist(parseInt(req.params.id, 10));
      if (!w) return res.status(404).json({ error: 'Worklist not found' });
      res.json({ worklist: w });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/collections/worklists/:id', ...guard, (req, res) => {
    try {
      const { name, owner_user_id, description } = req.body || {};
      const w = updateWorklist(parseInt(req.params.id, 10), {
        name, ownerUserId: owner_user_id, description,
      });
      res.json({ worklist: w });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/collections/worklists/:id/archive', ...guard, (req, res) => {
    try {
      const w = archiveWorklist(parseInt(req.params.id, 10));
      res.json({ worklist: w });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Assignments ───────────────────────────────────────────────

  router.get('/api/collections/worklists/:id/assignments', ...guard, (req, res) => {
    try {
      const status = req.query.status || 'active';
      res.json({ assignments: listAssignmentsForWorklist(parseInt(req.params.id, 10), { status }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/collections/worklists/:id/assignments', ...guard, (req, res) => {
    try {
      const worklistId = parseInt(req.params.id, 10);
      const { customer_ids } = req.body || {};
      if (!Array.isArray(customer_ids) || customer_ids.length === 0) {
        return res.status(400).json({ error: 'customer_ids array is required' });
      }
      const result = bulkAddAssignments({
        worklistId,
        customerIds: customer_ids.map(String),
        assignedByUserId: req.currentUser?.id || null,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/api/collections/assignments/:id/status', ...guard, (req, res) => {
    try {
      const { status, reason } = req.body || {};
      const a = setAssignmentStatus(parseInt(req.params.id, 10), {
        status, reason, userId: req.currentUser?.id || null,
      });
      res.json({ assignment: a });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/api/collections/assignments/:id/followup', ...guard, (req, res) => {
    try {
      const { date } = req.body || {};
      const a = setAssignmentFollowup(parseInt(req.params.id, 10), date || null);
      res.json({ assignment: a });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Customer pool (candidates for assignment) ─────────────────
  // Everyone with an outstanding balance who isn't already on an
  // active assignment for the given worklist.

  router.get('/api/collections/candidates', ...guard, (req, res) => {
    try {
      const worklistId = req.query.worklist_id ? parseInt(req.query.worklist_id, 10) : null;
      const search = String(req.query.q || '').trim();
      const minValue = parseFloat(req.query.min_value);
      const salesRep = String(req.query.sales_rep || '').trim();
      const daysOverdue = parseInt(req.query.days_overdue, 10);

      const where = ['d.outstanding_balance_num > 0'];
      const params = [];

      // One-list-at-a-time rule is still enforced (the SELECT below
      // surfaces the blocked-by-worklist info so the operator sees WHY
      // the customer can't be added), but rows aren't hidden — the UI
      // renders them disabled with the owning rep visible.
      if (search) {
        where.push(`(d.customer_name LIKE ? OR d.customer_number LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`);
      }
      if (Number.isFinite(minValue) && minValue > 0) {
        where.push(`d.outstanding_balance_num >= ?`);
        params.push(minValue);
      }
      if (salesRep && salesRep !== 'all') {
        where.push(`TRIM(d.sales_rep) = ?`);
        params.push(salesRep);
      }
      // Days overdue compares against last_unpaid_invoice_1_date in
      // DD/MM/YYYY format. We let SQLite parse via substr() + julianday
      // — slower than indexed columns but fine for the ~hundreds of
      // outstanding customers a depot sees.
      if (Number.isFinite(daysOverdue) && daysOverdue > 0) {
        where.push(`(
          d.last_unpaid_invoice_1_date IS NOT NULL
          AND d.last_unpaid_invoice_1_date != ''
          AND CAST((julianday('now') - julianday(
            substr(d.last_unpaid_invoice_1_date, 7, 4) || '-' ||
            substr(d.last_unpaid_invoice_1_date, 4, 2) || '-' ||
            substr(d.last_unpaid_invoice_1_date, 1, 2)
          )) AS INTEGER) >= ?
        )`);
        params.push(daysOverdue);
      }

      const rows = db.prepare(`
        SELECT d.id, d.customer_number, d.customer_name, d.outstanding_balance,
               d.outstanding_balance_num, d.flag_color, d.flag_reason,
               d.sales_rep, d.account_type, d.terms,
               d.last_unpaid_invoice_1_date AS last_invoice_date,
               -- Surface the worklist this customer is already on (if any)
               -- so the UI can render them as disabled with the owner.
               (SELECT w.id   FROM collection_assignment a
                JOIN collection_worklist w ON w.id = a.worklist_id
                WHERE a.customer_id = d.id AND a.status = 'active'
                LIMIT 1) AS blocked_worklist_id,
               (SELECT w.name FROM collection_assignment a
                JOIN collection_worklist w ON w.id = a.worklist_id
                WHERE a.customer_id = d.id AND a.status = 'active'
                LIMIT 1) AS blocked_worklist_name,
               (SELECT COALESCE(u.full_name, u.email) FROM collection_assignment a
                JOIN collection_worklist w ON w.id = a.worklist_id
                LEFT JOIN "user" u ON u.id = w.owner_user_id
                WHERE a.customer_id = d.id AND a.status = 'active'
                LIMIT 1) AS blocked_worklist_owner
        FROM datarecord d
        WHERE ${where.join(' AND ')}
        ORDER BY (blocked_worklist_id IS NOT NULL) ASC,
                 d.outstanding_balance_num DESC,
                 d.customer_name COLLATE NOCASE
        LIMIT 500
      `).all(...params);
      res.json({ candidates: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Map of customer_id -> { worklist_id, worklist_name, owner_name }
  // for every customer currently active on any worklist. Used by
  // Customer Balances to show an "Assigned to <rep>" chip per row.
  router.get('/api/collections/customer-assignments', ...guard, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT a.customer_id,
               a.worklist_id,
               w.name AS worklist_name,
               COALESCE(u.full_name, u.email) AS owner_name,
               w.owner_user_id
        FROM collection_assignment a
        JOIN collection_worklist w ON w.id = a.worklist_id
        LEFT JOIN "user" u ON u.id = w.owner_user_id
        WHERE a.status = 'active'
      `).all();
      const map = {};
      for (const r of rows) map[r.customer_id] = r;
      res.json({ assignments: map });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sales reps available for the candidates filter
  router.get('/api/collections/candidate-reps', ...guard, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT DISTINCT TRIM(sales_rep) AS sales_rep
        FROM datarecord
        WHERE outstanding_balance_num > 0
          AND sales_rep IS NOT NULL
          AND TRIM(sales_rep) != ''
        ORDER BY 1
      `).all();
      res.json({ reps: rows.map(r => r.sales_rep) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Activity log ──────────────────────────────────────────────

  router.get('/api/collections/customers/:customer_id/activity', ...guard, (req, res) => {
    try {
      res.json({ activity: listActivityForCustomer(String(req.params.customer_id)) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/collections/customers/:customer_id/activity', ...guard, (req, res) => {
    try {
      const customerId = String(req.params.customer_id);
      const { assignment_id, kind, amount, promise_date, notes } = req.body || {};
      const entry = addActivity({
        customerId, assignmentId: assignment_id || null,
        userId: req.currentUser?.id || null,
        kind, amount: amount != null ? Number(amount) : null,
        promiseDate: promise_date || null,
        notes: notes || null,
        source: 'manual',
      });
      res.json({ activity: entry });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Manual delta scan trigger (debug/recovery) ────────────────

  router.post('/api/collections/sync-deltas', ...guard, (req, res) => {
    try {
      const result = processCollectionBalanceDelta();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Users (for owner assignment dropdown) ─────────────────────

  router.get('/api/collections/assignable-users', ...guard, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT id, email, full_name, role
        FROM "user"
        WHERE is_active = 1
          AND (can_access_collections = 1 OR role = 'admin')
        ORDER BY full_name COLLATE NOCASE, email COLLATE NOCASE
      `).all();
      res.json({ users: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
