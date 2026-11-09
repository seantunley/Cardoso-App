// One-off check for sites that ran 2026.5.14 before #607. REPORTS ONLY — it
// changes no Collections records.
//
// 2026.5.14 started clearing the balance of customers Sage no longer returns
// (deleted, or rolled into a national account). Collections read that drop as
// money received: it logged "Paid in full (auto-detected from sync)" and marked
// the assignment 'collected', though no money was paid.
//
// Why nothing is corrected automatically: 5.14 never recorded WHICH customers it
// cleared, only how many per sync run. Every remaining clue (the cleared values,
// synced_at vs updated_date, a run that cleared someone) can also be true of a
// real payment, e.g. a customer who really paid, whose auto-flag later changed
// in a run that cleared a different customer. Payment history is not rewritten
// on a guess, so suspect records go to the System Log for a person to check
// against Sage. (Since #607 the sync records these correctly as they happen.)
//
// Listed, in two groups:
//  - "likely": the row still holds exactly what the clear writes (balance and
//    the four age buckets '0', empty age_analysis, no open invoices), synced_at
//    is older than updated_date, a completed run that cleared customers covers
//    updated_date, and the payment came after it.
//  - "possible": only some of that holds.
// Real payments matching none of it are not listed.

export default {
  version: 111,
  name: 'collections_review_sync_cleared_payments',
  up(db) {
    const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('collection_activity') || !has('datarecord') || !has('error_log')) return;
    const runs = has('syncrun');

    const candidates = db.prepare(`
      SELECT a.id, a.assignment_id, a.at, a.amount, a.customer_id, d.customer_number, d.customer_name,
        (d.outstanding_balance = '0' AND d.age_current = '0' AND d.age_7_days = '0' AND d.age_14_days = '0'
          AND d.age_21_days = '0' AND COALESCE(d.age_analysis, '') = '' AND COALESCE(d.unpaid_invoices, '[]') = '[]') AS fingerprint,
        (d.synced_at IS NOT NULL AND d.updated_date IS NOT NULL
          AND datetime(d.synced_at) < datetime(d.updated_date)) AS not_from_sage,
        ${runs ? `EXISTS (
          SELECT 1 FROM syncrun s
          WHERE s.status = 'completed' AND s.message LIKE '%no longer in Sage (balances cleared)%'
            AND datetime(d.updated_date) BETWEEN datetime(s.started_at) AND datetime(s.completed_at)
        )` : '0'} AS clear_run,
        (datetime(a.at) >= datetime(d.updated_date)) AS after_clear
      FROM collection_activity a
      JOIN datarecord d ON d.id = a.customer_id
      WHERE a.kind = 'payment_received' AND a.source = 'sync'
        AND a.notes = 'Paid in full (auto-detected from sync)'
        AND datetime(a.at) >= datetime('2026-11-09 00:00:00')
    `).all();

    const likely = candidates.filter((c) => c.fingerprint && c.not_from_sage && c.clear_run && c.after_clear);
    const possible = candidates.filter((c) => !likely.includes(c) && (c.fingerprint || c.not_from_sage));
    if (likely.length + possible.length === 0) return;

    const line = (c) => `${c.customer_number || c.customer_id} ${c.customer_name || ''} (R${c.amount}, ${c.at})`.replace(/\s+/g, ' ').trim();
    const parts = [];
    if (likely.length) parts.push(`Likely not payments (${likely.length}): ${likely.map(line).join('; ')}.`);
    if (possible.length) parts.push(`Possibly not payments (${possible.length}): ${possible.map(line).join('; ')}.`);
    const msg = `Collections check after an app update: version 2026.5.14 could record "Paid in full" when the customer sync cleared the balance of a customer Sage no longer returns (deleted, or moved into a national account), even though no money was paid. These records may be affected. Nothing was changed automatically, because that version didn't record which customers it cleared. ${parts.join(' ')} For each one, check Sage: if the customer is no longer there and nothing was paid, reopen the assignment in Collections, add a note, and close it.`;
    console.warn(`[migration v111] ${msg}`);
    const ctx = (group) => (c) => ({
      group, activity_id: c.id, assignment_id: c.assignment_id, customer_number: c.customer_number, amount: c.amount, at: c.at,
      fingerprint: !!c.fingerprint, not_from_sage: !!c.not_from_sage, clear_run: !!c.clear_run, after_clear: !!c.after_clear,
    });
    db.prepare("INSERT INTO error_log (source, level, message, context) VALUES ('migration.v111.collections_review', 'warn', ?, ?)")
      .run(msg, JSON.stringify([...likely.map(ctx('likely')), ...possible.map(ctx('possible'))]));
  },
};
