// One-off data fix for sites that ran 2026.5.14 before #607.
//
// 2026.5.14 started clearing the balance of customers Sage no longer returns
// (deleted, or rolled into a national account). Collections read that drop as
// money received: it logged "Paid in full (auto-detected from sync)" and marked
// the assignment 'collected'. No money was paid. Closing it was right (Sean's
// call); the label and the payment record were wrong.
//
// This changes payment history, so a record is corrected ONLY with positive
// evidence that the customer's balance was zeroed by that clear. Timing alone
// can't tell (syncs can run minutes apart; the Collections button can find a
// real payment long after the sync that saw it). All four must hold:
//
//  1. Fingerprint. The customer row still holds exactly what the clear writes:
//     balance, current/7/14/21-day buckets all '0', empty age_analysis, no open
//     invoices. On a real site's data, 0 of 7,110 Sage-returned customers look
//     like this (zero balances come through as '' or with other bucket values).
//  2. Not from Sage. synced_at is older than updated_date. Any row Sage returns
//     and changes gets both stamped with the same time; the clear only moves
//     updated_date.
//  3. A clear happened then. A completed sync run reported "no longer in Sage
//     (balances cleared)", and the row's updated_date falls inside that run.
//  4. Order. The payment was recorded at or after that clear.
//
// Proven records: the payment row becomes a note (amount removed, before and
// after balances kept), the matching auto-collect row is reworded, and a
// still-'collected' assignment becomes 'closed' with the reason the sync now
// writes. An assignment someone has since reopened keeps its status.
//
// Records that look partly like a clear (1 or 2 holds) but can't be proven are
// left exactly as they are and listed in the System Log for a person to check.
const REASON = 'Customer no longer in Sage (deleted, or moved into a national account). Balance cleared by the customer sync; not a payment.';

export default {
  version: 111,
  name: 'collections_relabel_sync_cleared_payments',
  up(db) {
    const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('collection_activity') || !has('collection_assignment') || !has('datarecord') || !has('syncrun')) return;

    const candidates = db.prepare(`
      SELECT a.id, a.assignment_id, a.at, a.amount, a.customer_id, d.customer_number, d.customer_name,
        (d.outstanding_balance = '0' AND d.age_current = '0' AND d.age_7_days = '0' AND d.age_14_days = '0'
          AND d.age_21_days = '0' AND COALESCE(d.age_analysis, '') = '' AND COALESCE(d.unpaid_invoices, '[]') = '[]') AS fingerprint,
        (d.synced_at IS NOT NULL AND d.updated_date IS NOT NULL
          AND datetime(d.synced_at) < datetime(d.updated_date)) AS not_from_sage,
        EXISTS (
          SELECT 1 FROM syncrun s
          WHERE s.status = 'completed' AND s.message LIKE '%no longer in Sage (balances cleared)%'
            AND datetime(d.updated_date) BETWEEN datetime(s.started_at) AND datetime(s.completed_at)
        ) AS clear_run,
        (datetime(a.at) >= datetime(d.updated_date)) AS after_clear
      FROM collection_activity a
      JOIN datarecord d ON d.id = a.customer_id
      WHERE a.kind = 'payment_received' AND a.source = 'sync'
        AND a.notes = 'Paid in full (auto-detected from sync)'
        AND datetime(a.at) >= datetime('2026-11-09 00:00:00')
    `).all();

    const proven = candidates.filter((c) => c.fingerprint && c.not_from_sage && c.clear_run && c.after_clear);
    const unsure = candidates.filter((c) => !proven.includes(c) && (c.fingerprint || c.not_from_sage));

    const toNote = db.prepare(`
      UPDATE collection_activity
      SET kind = 'note', amount = NULL,
          notes = 'Corrected by an app update: this was recorded as "Paid in full", but no payment was made. ' || ?
      WHERE id = ?
    `);
    const rewordAutoCollect = db.prepare(`
      UPDATE collection_activity SET notes = ?
      WHERE assignment_id = ? AND kind = 'status_changed' AND source = 'sync'
        AND notes = 'Auto-collected — balance reached zero'
        AND ABS(strftime('%s', at) - strftime('%s', ?)) <= 60
    `);
    const relabel = db.prepare(`
      UPDATE collection_assignment SET status = 'closed', closed_reason = ?
      WHERE id = ? AND status = 'collected'
    `);

    let relabelled = 0;
    for (const p of proven) {
      toNote.run(REASON, p.id);
      if (p.assignment_id != null) {
        rewordAutoCollect.run(`active → closed: ${REASON}`, p.assignment_id, p.at);
        relabelled += relabel.run(REASON, p.assignment_id).changes;
      }
    }
    if (proven.length) {
      console.log(`[migration v111] Collections: ${proven.length} "Paid in full" record(s) were from customers the sync cleared because Sage stopped returning them, not payments. Changed them to notes and relabelled ${relabelled} assignment(s) from Collected to Closed.`);
    }

    if (unsure.length) {
      const list = unsure.map((c) => `${c.customer_number || c.customer_id} ${c.customer_name || ''} (R${c.amount}, ${c.at})`.replace(/\s+/g, ' ').trim());
      const msg = `Collections check after an app update: ${unsure.length} "Paid in full" record(s) might come from customers the sync cleared because Sage stopped returning them, rather than real payments, but there wasn't enough evidence to change them automatically, so they were left as they are. Please check each one in Collections and Sage: ${list.join('; ')}. If no payment was made, reopen the assignment and close it with a note.`;
      console.warn(`[migration v111] ${msg}`);
      if (has('error_log')) {
        db.prepare("INSERT INTO error_log (source, level, message, context) VALUES ('migration.v111.collections_review', 'warn', ?, ?)")
          .run(msg, JSON.stringify(unsure.map((c) => ({
            activity_id: c.id, assignment_id: c.assignment_id, customer_number: c.customer_number, amount: c.amount, at: c.at,
            fingerprint: !!c.fingerprint, not_from_sage: !!c.not_from_sage, clear_run: !!c.clear_run, after_clear: !!c.after_clear,
          }))));
      }
    }
  },
};
