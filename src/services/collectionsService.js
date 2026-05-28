// Collections rebuild — Phase 2 service layer.
//
// Three concerns live here:
//   1. Worklist CRUD + assignment management (manual lifecycle).
//   2. Activity log writes (append-only event stream).
//   3. The sync-time auto-detection hook that compares each active
//      assignment's last-known balance to the customer's current
//      balance, writes payment_received events for any drop, and
//      auto-collects assignments that have hit zero.
//
// Routes are thin wrappers around these functions — see
// src/routes/collections.js.

import db from '../db/index.js';

function parseAmount(value) {
  const n = parseFloat(String(value ?? '').replace(/,/g, '').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function nowIso() { return new Date().toISOString(); }

// ── Worklists ────────────────────────────────────────────────────

export function listWorklists({ includeArchived = false } = {}) {
  const rows = db.prepare(`
    SELECT w.id, w.name, w.description, w.owner_user_id,
           u.email AS owner_email, u.full_name AS owner_name,
           w.created_at, w.archived_at,
           (
             SELECT COUNT(*) FROM collection_assignment a
             WHERE a.worklist_id = w.id AND a.status = 'active'
           ) AS active_count,
           (
             SELECT COUNT(*) FROM collection_assignment a
             WHERE a.worklist_id = w.id AND a.status = 'collected'
           ) AS collected_count
    FROM collection_worklist w
    LEFT JOIN "user" u ON u.id = w.owner_user_id
    WHERE ${includeArchived ? '1=1' : 'w.archived_at IS NULL'}
    ORDER BY w.archived_at IS NOT NULL, w.name COLLATE NOCASE
  `).all();
  return rows;
}

export function createWorklist({ name, ownerUserId, description, createdByUserId }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Worklist name is required');
  if (cleanName.length > 80) throw new Error('Worklist name must be 80 characters or less');
  const info = db.prepare(`
    INSERT INTO collection_worklist (name, owner_user_id, description, created_by_user_id)
    VALUES (?, ?, ?, ?)
  `).run(cleanName, ownerUserId || null, description || null, createdByUserId || null);
  return getWorklist(info.lastInsertRowid);
}

export function getWorklist(id) {
  return db.prepare(`
    SELECT w.*, u.email AS owner_email, u.full_name AS owner_name
    FROM collection_worklist w
    LEFT JOIN "user" u ON u.id = w.owner_user_id
    WHERE w.id = ?
  `).get(id);
}

export function updateWorklist(id, { name, ownerUserId, description }) {
  const fields = [];
  const params = [];
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) throw new Error('Worklist name cannot be blank');
    fields.push('name = ?'); params.push(cleanName);
  }
  if (ownerUserId !== undefined) { fields.push('owner_user_id = ?'); params.push(ownerUserId || null); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description || null); }
  if (!fields.length) return getWorklist(id);
  params.push(id);
  db.prepare(`UPDATE collection_worklist SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getWorklist(id);
}

export function archiveWorklist(id) {
  db.prepare(`UPDATE collection_worklist SET archived_at = ? WHERE id = ?`).run(nowIso(), id);
  return getWorklist(id);
}

// ── Assignments ──────────────────────────────────────────────────

export function listAssignmentsForWorklist(worklistId, { status = 'active' } = {}) {
  const statusClause = status === 'all' ? '' : 'AND a.status = ?';
  const params = status === 'all' ? [worklistId] : [worklistId, status];
  return db.prepare(`
    SELECT
      a.id, a.worklist_id, a.customer_id, a.status,
      a.assigned_at, a.assigned_by_user_id, a.closed_at, a.closed_reason,
      a.next_followup_date, a.opening_balance, a.last_known_balance,
      d.customer_number, d.customer_name,
      d.outstanding_balance, d.outstanding_balance_num,
      d.flag_color, d.flag_reason, d.terms, d.sales_rep, d.account_type,
      d.last_unpaid_invoice_1_date AS last_invoice_date,
      d.last_receipt_1_date AS last_receipt_date,
      (
        SELECT COUNT(*) FROM collection_activity ca
        WHERE ca.assignment_id = a.id
      ) AS activity_count,
      (
        SELECT MAX(ca.at) FROM collection_activity ca
        WHERE ca.assignment_id = a.id AND ca.kind IN ('contacted','note','promise_made')
      ) AS last_action_at
    FROM collection_assignment a
    LEFT JOIN datarecord d ON d.id = a.customer_id
    WHERE a.worklist_id = ? ${statusClause}
    ORDER BY a.status = 'active' DESC,
             COALESCE(d.outstanding_balance_num, 0) DESC,
             d.customer_name COLLATE NOCASE
  `).all(...params);
}

export function getAssignment(id) {
  return db.prepare(`
    SELECT a.*, d.customer_number, d.customer_name, d.outstanding_balance,
           d.outstanding_balance_num, d.flag_color, d.flag_reason
    FROM collection_assignment a
    LEFT JOIN datarecord d ON d.id = a.customer_id
    WHERE a.id = ?
  `).get(id);
}

export function getAssignmentForCustomer(customerId, worklistId) {
  return db.prepare(`
    SELECT * FROM collection_assignment
    WHERE customer_id = ? AND worklist_id = ?
  `).get(customerId, worklistId);
}

// Add a single customer to a worklist. Enforces the "one list at a
// time" rule — a customer can only be active on ONE worklist; if
// already active elsewhere, the call returns { busy: true, ... }
// rather than creating a new assignment. Closed/collected assignments
// on the SAME list are re-opened (history preserved).
export function addAssignment({ worklistId, customerId, assignedByUserId }) {
  const customer = db.prepare(`SELECT id, outstanding_balance_num FROM datarecord WHERE id = ?`).get(customerId);
  if (!customer) throw new Error(`Customer ${customerId} not found`);
  const opening = customer.outstanding_balance_num ?? 0;

  // Check if this customer is already active on any OTHER worklist —
  // returning busy=true so the caller can surface a clear message.
  const elsewhere = db.prepare(`
    SELECT a.id, a.worklist_id, w.name AS worklist_name
    FROM collection_assignment a
    JOIN collection_worklist w ON w.id = a.worklist_id
    WHERE a.customer_id = ?
      AND a.status = 'active'
      AND a.worklist_id != ?
  `).get(customerId, worklistId);
  if (elsewhere) {
    return {
      busy: true, created: false, reopened: false,
      busy_on_worklist_id: elsewhere.worklist_id,
      busy_on_worklist_name: elsewhere.worklist_name,
    };
  }

  const existing = getAssignmentForCustomer(customerId, worklistId);
  if (existing) {
    if (existing.status === 'active') {
      return { assignment: existing, reopened: false, created: false };
    }
    // Re-open a previously closed/collected assignment.
    db.prepare(`
      UPDATE collection_assignment
      SET status = 'active', closed_at = NULL, closed_reason = NULL,
          last_known_balance = ?, last_sync_at = ?
      WHERE id = ?
    `).run(opening, nowIso(), existing.id);
    addActivity({
      customerId, assignmentId: existing.id, userId: assignedByUserId,
      kind: 'status_changed', notes: 'Reopened', source: 'manual',
    });
    return { assignment: getAssignment(existing.id), reopened: true, created: false };
  }

  const info = db.prepare(`
    INSERT INTO collection_assignment
      (worklist_id, customer_id, status, assigned_by_user_id, opening_balance, last_known_balance, last_sync_at)
    VALUES (?, ?, 'active', ?, ?, ?, ?)
  `).run(worklistId, customerId, assignedByUserId || null, opening, opening, nowIso());
  return { assignment: getAssignment(info.lastInsertRowid), reopened: false, created: true };
}

export function bulkAddAssignments({ worklistId, customerIds, assignedByUserId }) {
  const result = { added: 0, reopened: 0, alreadyActive: 0, missing: [], busy: [] };
  const txn = db.transaction(() => {
    for (const id of customerIds) {
      try {
        const r = addAssignment({ worklistId, customerId: id, assignedByUserId });
        if (r.created) result.added++;
        else if (r.reopened) result.reopened++;
        else if (r.busy) result.busy.push({ id, worklist: r.busy_on_worklist_name });
        else result.alreadyActive++;
      } catch (err) {
        if (/not found/i.test(err.message)) result.missing.push(id);
        else throw err;
      }
    }
  });
  txn();
  return result;
}

export function setAssignmentFollowup(id, dateOrNull) {
  db.prepare(`UPDATE collection_assignment SET next_followup_date = ? WHERE id = ?`).run(dateOrNull || null, id);
  return getAssignment(id);
}

export function setAssignmentStatus(id, { status, reason, userId }) {
  const valid = new Set(['active', 'collected', 'escalated', 'written_off', 'closed']);
  if (!valid.has(status)) throw new Error(`Invalid status: ${status}`);
  const existing = getAssignment(id);
  if (!existing) throw new Error('Assignment not found');
  const closedAt = status === 'active' ? null : nowIso();
  db.prepare(`
    UPDATE collection_assignment
    SET status = ?, closed_at = ?, closed_reason = ?
    WHERE id = ?
  `).run(status, closedAt, reason || null, id);
  addActivity({
    customerId: existing.customer_id, assignmentId: id, userId,
    kind: 'status_changed',
    notes: `${existing.status} → ${status}${reason ? `: ${reason}` : ''}`,
    source: 'manual',
  });
  return getAssignment(id);
}

// ── Activity log ─────────────────────────────────────────────────

const VALID_KINDS = new Set([
  'note', 'contacted', 'promise_made', 'promise_kept', 'promise_broken',
  'payment_received', 'status_changed',
]);

export function addActivity({
  customerId, assignmentId = null, userId = null,
  kind, amount = null, promiseDate = null,
  previousBalance = null, newBalance = null,
  notes = null, source = 'manual',
}) {
  if (!VALID_KINDS.has(kind)) throw new Error(`Invalid activity kind: ${kind}`);
  if (!customerId) throw new Error('customerId is required');
  const info = db.prepare(`
    INSERT INTO collection_activity
      (customer_id, assignment_id, user_id, kind, amount, promise_date,
       previous_balance, new_balance, notes, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customerId, assignmentId, userId, kind, amount, promiseDate, previousBalance, newBalance, notes, source);
  return getActivity(info.lastInsertRowid);
}

export function getActivity(id) {
  return db.prepare(`
    SELECT ca.*, u.email AS user_email, u.full_name AS user_name
    FROM collection_activity ca
    LEFT JOIN "user" u ON u.id = ca.user_id
    WHERE ca.id = ?
  `).get(id);
}

export function listActivityForCustomer(customerId) {
  return db.prepare(`
    SELECT ca.*, u.email AS user_email, u.full_name AS user_name
    FROM collection_activity ca
    LEFT JOIN "user" u ON u.id = ca.user_id
    WHERE ca.customer_id = ?
    ORDER BY ca.at DESC, ca.id DESC
  `).all(customerId);
}

// ── Sync hook: auto-payment detection ────────────────────────────
//
// Called once per sync round (after datarecord has been updated).
// Walks every active assignment, compares the stored last_known_balance
// to the customer's current outstanding_balance_num, and:
//   - On any decrease: writes a payment_received event with the
//     before/after values and the amount paid.
//   - On a zero balance: transitions the assignment to 'collected'
//     and writes a status_changed event.
// last_known_balance is then refreshed so subsequent sync rounds
// only act on new drops.
//
// Idempotent — calling it twice in a row writes no extra events.
export function processCollectionBalanceDelta() {
  const rows = db.prepare(`
    SELECT a.id AS assignment_id, a.customer_id, a.last_known_balance,
           d.outstanding_balance_num
    FROM collection_assignment a
    JOIN datarecord d ON d.id = a.customer_id
    WHERE a.status = 'active'
  `).all();

  let payments = 0;
  let autoCollected = 0;
  const txn = db.transaction(() => {
    const updateBalance = db.prepare(`
      UPDATE collection_assignment
      SET last_known_balance = ?, last_sync_at = ?
      WHERE id = ?
    `);
    const autoCollect = db.prepare(`
      UPDATE collection_assignment
      SET status = 'collected', closed_at = ?
      WHERE id = ?
    `);
    for (const r of rows) {
      const prev = parseAmount(r.last_known_balance);
      const curr = parseAmount(r.outstanding_balance_num);
      if (curr < prev - 0.005) {
        // Balance dropped — record the payment as an event.
        const paid = Number((prev - curr).toFixed(2));
        addActivity({
          customerId: r.customer_id,
          assignmentId: r.assignment_id,
          kind: 'payment_received',
          amount: paid,
          previousBalance: prev,
          newBalance: curr,
          source: 'sync',
          notes: curr <= 0.005 ? 'Paid in full (auto-detected from sync)' : 'Partial payment (auto-detected from sync)',
        });
        payments++;
      }
      // Always refresh, even if it ticked UP (avoids spurious future
      // events when a balance recovers from a sync correction).
      updateBalance.run(curr, nowIso(), r.assignment_id);
      if (curr <= 0.005 && prev > 0.005) {
        autoCollect.run(nowIso(), r.assignment_id);
        addActivity({
          customerId: r.customer_id,
          assignmentId: r.assignment_id,
          kind: 'status_changed',
          notes: 'Auto-collected — balance reached zero',
          source: 'sync',
        });
        autoCollected++;
      }
    }
  });
  txn();
  if (payments || autoCollected) {
    console.log(`[collections-sync] payments=${payments} auto-collected=${autoCollected}`);
  }
  return { payments, autoCollected };
}
