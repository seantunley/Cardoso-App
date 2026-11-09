// One-off data fix for sites that ran 2026.5.14 before #607.
//
// 2026.5.14 started clearing the balance of customers Sage no longer returns
// (deleted, or rolled into a national account). Collections read that drop as
// money received: it logged "Paid in full (auto-detected from sync)" and marked
// the assignment 'collected'. No money was paid. Closing it was right (Sean's
// call); the label and the payment record were wrong.
//
// How a false one is told apart from a real one: a real payment is seen in a
// sync where Sage returned the customer, so the customer's synced_at is that
// same run, seconds before the payment row. A cleared customer was NOT returned,
// so synced_at stays at the last time Sage returned it: at least one 30-minute
// sync earlier. The 10-minute gap below sits safely between the two. Only rows
// from 2026-11-09 on (the day 5.14 shipped; nothing cleared balances before),
// and only customers still cleared (balance '0' exactly as the clear writes it,
// no open invoices).
//
// Fix, per false payment: the payment row becomes a note (amount removed, before
// and after balances kept), the matching auto-collect row is reworded, and a
// still-'collected' assignment becomes 'closed' with the same reason the sync
// now writes. An assignment someone has since reopened is left as it is.
const REASON = 'Customer no longer in Sage (deleted, or moved into a national account). Balance cleared by the customer sync; not a payment.';

export default {
  version: 111,
  name: 'collections_relabel_sync_cleared_payments',
  up(db) {
    const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('collection_activity') || !has('collection_assignment') || !has('datarecord')) return;

    const falsePayments = db.prepare(`
      SELECT a.id, a.assignment_id, a.at
      FROM collection_activity a
      JOIN datarecord d ON d.id = a.customer_id
      WHERE a.kind = 'payment_received' AND a.source = 'sync'
        AND a.notes = 'Paid in full (auto-detected from sync)'
        AND datetime(a.at) >= datetime('2026-11-09 00:00:00')
        AND d.outstanding_balance = '0'
        AND COALESCE(d.unpaid_invoices, '[]') = '[]'
        AND d.synced_at IS NOT NULL
        AND datetime(d.synced_at) < datetime(a.at, '-10 minutes')
    `).all();
    if (falsePayments.length === 0) return;

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
    db.transaction(() => {
      for (const p of falsePayments) {
        toNote.run(REASON, p.id);
        if (p.assignment_id != null) {
          rewordAutoCollect.run(`active → closed: ${REASON}`, p.assignment_id, p.at);
          relabelled += relabel.run(REASON, p.assignment_id).changes;
        }
      }
    })();
    console.log(`[migration v111] Collections: ${falsePayments.length} "Paid in full" record(s) from customers Sage stopped returning were not payments; changed them to notes and relabelled ${relabelled} assignment(s) from Collected to Closed.`);
  },
};
