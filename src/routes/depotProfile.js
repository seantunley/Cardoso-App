import { Router } from 'express';
import { logAudit } from '../lib/audit.js';
import { logError } from '../lib/errorLog.js';

const FIELDS = [
  'name', 'address_line1', 'address_line2', 'city', 'postal_code',
  'phone', 'email', 'vat_number', 'registration_number',
];

export function createDepotProfileRouter({ db, requireAuth, requireAdmin }) {
  const router = Router();

  // Anyone authenticated can read the profile — it's letterhead data
  // used in customer-facing documents (price lists, statements). Only
  // admins can edit. Public READ keeps the price list page lightweight
  // for non-admin sales reps.
  router.get('/api/depot-profile', requireAuth, (_req, res) => {
    try {
      const row = db.prepare('SELECT * FROM depot_profile WHERE id = 1').get();
      res.json({ profile: row || {} });
    } catch (err) {
      logError('depotProfile.get', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/depot-profile', requireAuth, requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      const before = db.prepare('SELECT * FROM depot_profile WHERE id = 1').get() || {};
      const updates = [];
      const params = [];
      const afterFields = {};
      const beforeFields = {};
      for (const f of FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          updates.push(`${f} = ?`);
          // Empty strings stored as NULL — letterhead skips falsy lines.
          const val = body[f] === '' ? null : String(body[f]).trim();
          params.push(val);
          afterFields[f] = val;
          beforeFields[f] = before[f] ?? null;
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
      updates.push("updated_at = CURRENT_TIMESTAMP");
      params.push(1);
      db.prepare(`UPDATE depot_profile SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      const row = db.prepare('SELECT * FROM depot_profile WHERE id = 1').get();
      logAudit({
        req,
        action: 'depotProfile.update',
        resourceType: 'depot_profile',
        resourceId: '1',
        resourceName: row?.name || 'Depot profile',
        details: `Updated ${Object.keys(afterFields).join(', ')}`,
        changes: { before: beforeFields, after: afterFields },
      });
      res.json({ profile: row });
    } catch (err) {
      logError('depotProfile.update', err, { fields: Object.keys(req.body || {}) });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
