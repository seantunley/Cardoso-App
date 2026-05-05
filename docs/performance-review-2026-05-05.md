# Performance Review — May 5, 2026

## Scope reviewed
- `server.js`
- `src/db/index.js`
- `src/routes/records.js`
- `src/components/customer/PaymentHistoryCharts.jsx`

## High-impact opportunities

1. **Enable SQLite WAL + pragmatic tuning at startup**
   - The DB initialization currently opens `better-sqlite3` without runtime pragmas.
   - Recommend setting:
     - `PRAGMA journal_mode = WAL;`
     - `PRAGMA synchronous = NORMAL;`
     - `PRAGMA temp_store = MEMORY;`
     - `PRAGMA mmap_size = 268435456;` (256 MB, tune per device)
   - Why: improves read/write concurrency and reduces fsync overhead for mixed API workloads.
   - Risk: very low; WAL is standard for production SQLite services.

2. **Avoid broad `%needle%` scans for customer invoice lookup**
   - `/api/customer-by-invoice` uses `LIKE '%...%'` and then post-filters in JS with `matchInvoice`.
   - This forces large candidate scans and can become O(n) with table growth even with `LIMIT 500`.
   - Recommend:
     - Add a dedicated normalized invoice lookup table (one row per invoice number + customer key).
     - Index normalized number and optionally trailing-digits key.
     - Query exact/prefix matches first, fallback to suffix-only path only when needed.
   - Why: pushes matching into indexed SQL and removes JS-level filtering bottleneck.

3. **Prepare and reuse frequently executed SQL statements**
   - Several route handlers create statements inline for every request (`db.prepare(...)` inside handlers).
   - Recommend hoisting hot statements to module-level or per-router cached prepared statements.
   - Why: reduces statement compilation overhead and GC churn under concurrent traffic.

## Medium-impact opportunities

4. **Constrain CORS in production to known origin(s)**
   - Production CORS currently accepts all origins via callback.
   - Not primarily a speed issue, but tightening origin checks can reduce unnecessary cross-site traffic and preflight noise.

5. **Add JSON body size limit to reduce parse overhead spikes**
   - `app.use(express.json())` has no explicit limit.
   - Recommend `express.json({ limit: '1mb' })` (or appropriate business limit).
   - Why: protects event loop from huge payload parsing stalls.

6. **Stabilize chart cell keys and avoid index keys**
   - `PaymentHistoryCharts` uses `key={index}` for bars.
   - Recommend keying with a stable data label (e.g., `entry.label`) to reduce unnecessary remount/repaint when data shifts.

## Suggested rollout order
1. SQLite pragmas in `src/db/index.js`.
2. Statement reuse in hottest API routes.
3. Invoice lookup normalization/index strategy.
4. Request-body and CORS hardening.
5. Frontend micro-optimizations.

## Quick validation plan
- Add baseline timing for `/api/customer-by-invoice` (p50/p95 + row counts scanned).
- Re-run after each backend change.
- Confirm no regression on functional matching (alphanumeric and digits-only invoice inputs).
