// Entity quick-search — GET /api/search/entities?q=<text>
//
// Backend for the command palette's "type a customer/vendor name, jump to
// them" feature (and any future global search box). Returns the top matching
// customers and vendors for a short query, cheap enough to call on every
// keystroke (debounced client-side): two indexed-ish LIKE scans with LIMIT,
// prefix matches ranked above contains matches.
//
// Permission model mirrors the sidebar: the CUSTOMERS group is returned only
// when the caller could open a customer screen (customer search / balances),
// the VENDORS group only with creditor access; admins get both. A group the
// caller can't see is omitted entirely — same contract as visibleNavItems,
// so the palette can render whatever comes back without re-gating.
//
// Mode-aware like the rest of the app: site installs search the local
// datarecord/creditor tables; hub installs search the ETL mirrors
// (hub_records/hub_creditor), collapsing a customer that exists on several
// sites into one row with a `sites` count.

import { Router } from 'express';

function isHub() { return process.env.HUB_MODE === 'true'; }

const MAX_QUERY_LEN = 64;
const GROUP_LIMIT = 8;

// Escape LIKE metacharacters so a literal % or _ in the operator's query
// can't blow the match wide open. Paired with ESCAPE '\' in the SQL.
function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function can(user, ...keys) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return keys.some((k) => Boolean(user[k]));
}

/**
 * Pure search core — exported for tests.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ q: string, wantCustomers: boolean, wantVendors: boolean, hub: boolean }} args
 * @returns {{ customers?: object[], vendors?: object[] }}
 */
export function searchEntities(db, { q, wantCustomers, wantVendors, hub }) {
  const esc = likeEscape(q);
  const contains = `%${esc}%`;
  const prefix = `${esc}%`;
  const out = {};

  if (wantCustomers) {
    out.customers = hub
      ? db.prepare(`
          SELECT customer_number, customer_name,
                 COUNT(DISTINCT site_id) AS sites
          FROM hub_records
          WHERE (customer_name LIKE ? ESCAPE '\\' OR customer_number LIKE ? ESCAPE '\\')
          GROUP BY customer_number, customer_name
          ORDER BY CASE WHEN customer_name LIKE ? ESCAPE '\\' THEN 0
                        WHEN customer_number LIKE ? ESCAPE '\\' THEN 1
                        ELSE 2 END,
                   customer_name
          LIMIT ${GROUP_LIMIT}
        `).all(contains, contains, prefix, prefix)
      : db.prepare(`
          SELECT customer_number, customer_name, outstanding_balance
          FROM datarecord
          WHERE (customer_name LIKE ? ESCAPE '\\' OR customer_number LIKE ? ESCAPE '\\')
          ORDER BY CASE WHEN customer_name LIKE ? ESCAPE '\\' THEN 0
                        WHEN customer_number LIKE ? ESCAPE '\\' THEN 1
                        ELSE 2 END,
                   customer_name
          LIMIT ${GROUP_LIMIT}
        `).all(contains, contains, prefix, prefix);
  }

  if (wantVendors) {
    const table = hub ? 'hub_creditor' : 'creditor';
    out.vendors = db.prepare(`
      SELECT ${hub ? 'DISTINCT ' : ''}vendor_code, vendor_name
      FROM ${table}
      WHERE COALESCE(is_active, 1) = 1
        AND (vendor_name LIKE ? ESCAPE '\\' OR vendor_code LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN vendor_name LIKE ? ESCAPE '\\' THEN 0
                    WHEN vendor_code LIKE ? ESCAPE '\\' THEN 1
                    ELSE 2 END,
               vendor_name
      LIMIT ${GROUP_LIMIT}
    `).all(contains, contains, prefix, prefix);
  }

  return out;
}

// Handler factory — exported separately so tests can drive it with mock
// req/res and an in-memory db (same contract-test pattern as routes/jti.js).
export function handleEntitySearch({ db }) {
  return (req, res) => {
    try {
      const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      // Sub-2-char queries would match half the ledger — return the empty
      // shape rather than an error so the palette can call unconditionally.
      if (raw.length < 2) return res.json({ q: raw, customers: [], vendors: [] });
      const q = raw.slice(0, MAX_QUERY_LEN);

      const user = req.currentUser;
      const wantCustomers = can(user, 'can_access_customer_search', 'can_access_customer_balances');
      const wantVendors = can(user, 'can_access_creditors');
      if (!wantCustomers && !wantVendors) {
        // Authenticated but no entity-bearing permission — nothing to search.
        return res.json({ q, customers: [], vendors: [] });
      }

      const result = searchEntities(db, { q, wantCustomers, wantVendors, hub: isHub() });
      res.json({ q, customers: result.customers ?? [], vendors: result.vendors ?? [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

export function createSearchRouter({ db, requireAuth }) {
  const router = Router();
  router.get('/api/search/entities', requireAuth, handleEntitySearch({ db }));
  return router;
}
