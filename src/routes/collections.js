import express from 'express';
import db from '../db/index.js';

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

  router.get(
    '/api/collections',
    requireAuth,
    requirePermission('can_access_customer_balances'),
    (req, res) => {
      try {
        const rows = db.prepare(`
          SELECT
            d.id,
            d.id AS customer_id,
            d.customer_name AS name,
            d.outstanding_balance,
            d.flag_color,
            d.flag_reason,
            d.terms,
            COALESCE(c.status, 'pending') AS status,
            c.contacted_at,
            COALESCE(c.notes, '') AS notes
          FROM datarecord d
          LEFT JOIN collections c ON c.customer_id = d.id
          WHERE d.flag_color IN ('red', 'orange')
          ORDER BY CAST(REPLACE(REPLACE(COALESCE(d.outstanding_balance, '0'), ',', ''), ' ', '') AS REAL) DESC,
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
    }
  );

  router.put(
    '/api/collections/:customer_id',
    requireAuth,
    requirePermission('can_access_customer_balances'),
    (req, res) => {
      const customerId = String(req.params.customer_id || '').trim();
      const status = String(req.body?.status || 'pending').trim().toLowerCase();
      const notes = String(req.body?.notes || '');
      const validStatuses = new Set(['pending', 'contacted', 'promised', 'resolved']);

      if (!customerId) {
        return res.status(400).json({ error: 'Customer id is required' });
      }
      if (!validStatuses.has(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      try {
        const existingCustomer = db.prepare(`SELECT id FROM datarecord WHERE id = ?`).get(customerId);
        if (!existingCustomer) {
          return res.status(404).json({ error: 'Customer not found' });
        }

        const existing = db.prepare(`SELECT * FROM collections WHERE customer_id = ?`).get(customerId);
        const now = new Date().toISOString();
        const contactedAt = existing?.contacted_at || (status === 'contacted' ? now : null);

        if (existing) {
          db.prepare(`
            UPDATE collections
            SET status = ?, notes = ?, contacted_at = ?, updated_at = ?
            WHERE customer_id = ?
          `).run(status, notes, contactedAt, now, customerId);
        } else {
          db.prepare(`
            INSERT INTO collections (customer_id, status, contacted_at, notes, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(customerId, status, contactedAt, notes, now);
        }

        const updated = db.prepare(`
          SELECT
            d.id,
            d.id AS customer_id,
            d.customer_name AS name,
            d.outstanding_balance,
            d.flag_color,
            d.flag_reason,
            d.terms,
            c.status,
            c.contacted_at,
            COALESCE(c.notes, '') AS notes
          FROM datarecord d
          LEFT JOIN collections c ON c.customer_id = d.id
          WHERE d.id = ?
        `).get(customerId);

        res.json({
          ...updated,
          flag_label: getFlagLabel(updated?.flag_color),
          outstanding_balance_numeric: parseAmount(updated?.outstanding_balance),
        });
      } catch (error) {
        console.error('collections update error:', error);
        res.status(500).json({ error: 'Failed to update collections item' });
      }
    }
  );

  return router;
}
