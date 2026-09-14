// The counter's outbox. If this drops a scan, stock goes missing on paper and
// nobody knows why — so the queue only lets go of a scan the server has
// actually accounted for.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { enqueue, dequeue, pending, applyResult, loadQueue, saveQueue, makeClientId } from '../src/lib/stocktakeQueue.js';

describe('the outbox', () => {
  it('stamps every scan with an id, so a resend is recognised', () => {
    const q = enqueue([], { session_id: 1, zone_id: 2, qty: 5 });
    expect(q[0].client_id).toBeTruthy();
    expect(q[0].queued_at).toBeTruthy();
    expect(makeClientId()).not.toBe(makeClientId());
  });

  it('keeps one zone separate from another', () => {
    let q = enqueue([], { session_id: 1, zone_id: 2, qty: 5 });
    q = enqueue(q, { session_id: 1, zone_id: 3, qty: 7 });
    expect(pending(q, 1, 2)).toHaveLength(1);
    expect(pending(q, 1, 3)).toHaveLength(1);
    expect(pending(q, 2, 2)).toHaveLength(0);
  });

  it('lets a counter take back a scan that has not been sent', () => {
    const q = enqueue([], { client_id: 'a', session_id: 1, zone_id: 2, qty: 5 });
    expect(dequeue(q, 'a')).toHaveLength(0);
  });

  it('drops what the server took, and what it already had', () => {
    let q = enqueue([], { client_id: 'a', session_id: 1, zone_id: 2, qty: 1 });
    q = enqueue(q, { client_id: 'b', session_id: 1, zone_id: 2, qty: 2 });
    q = enqueue(q, { client_id: 'c', session_id: 1, zone_id: 2, qty: 3 });
    const left = applyResult(q, { accepted: ['a'], duplicates: ['b'], rejected: [{ client_id: 'c', reason: 'no' }] });
    expect(left).toHaveLength(0);
  });

  it('keeps everything when the send failed outright', () => {
    let q = enqueue([], { client_id: 'a', session_id: 1, zone_id: 2, qty: 1 });
    q = enqueue(q, { client_id: 'b', session_id: 1, zone_id: 2, qty: 2 });
    // No response at all — a dropped connection. Nothing may be discarded.
    expect(applyResult(q, undefined)).toHaveLength(2);
  });
});

describe('when the browser will not store anything', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
    });
  });

  it('reports the failure instead of pretending the scan was saved', () => {
    expect(loadQueue()).toEqual([]);
    expect(saveQueue([{ client_id: 'a' }])).toBe(false);
  });
});
