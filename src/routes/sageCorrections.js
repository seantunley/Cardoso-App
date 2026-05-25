import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { logAudit } from '../lib/audit.js';
import {
  parseDescription,
  queryProblematicLines,
  readCurrentDescription,
  updateSageDescription,
} from '../services/bat/sageCorrections.js';

export function createSageCorrectionsRouter({ requireAuth, requireAdmin }) {
  const router = Router();

  router.get('/api/sage-corrections/lines', requireAuth, requireAdmin, async (req, res) => {
    try {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const lines = await queryProblematicLines(year);
      res.json({ year, count: lines.length, lines });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      res.status(isSageDown ? 503 : 500).json({
        error: isSageDown
          ? 'Sage connection unavailable. Check that the Sage server is running and the connection is configured.'
          : err.message,
      });
    }
  });

  router.post('/api/sage-corrections/preview', requireAuth, requireAdmin, (req, res) => {
    const { newDescription } = req.body || {};
    if (!newDescription || typeof newDescription !== 'string') {
      return res.status(400).json({ error: 'newDescription is required' });
    }
    res.json({ parsed: parseDescription(newDescription) });
  });

  router.post('/api/sage-corrections/apply', requireAuth, requireAdmin, async (req, res) => {
    const { batchNumber, itemNumber, lineNumber, oldDescription, newDescription, password } = req.body || {};

    if (!password) return res.status(400).json({ error: 'Admin password is required.' });
    if (!newDescription || typeof newDescription !== 'string') return res.status(400).json({ error: 'newDescription is required.' });
    if (batchNumber == null || itemNumber == null || lineNumber == null) {
      return res.status(400).json({ error: 'batchNumber, itemNumber, and lineNumber are required.' });
    }

    const parsed = parseDescription(newDescription);
    if (!parsed.isValid) {
      return res.status(400).json({ error: 'Invalid description.', problems: parsed.problems });
    }

    const user = db.prepare('SELECT password_hash FROM "user" WHERE id = ?').get(req.currentUser.id);
    if (!user?.password_hash) return res.status(401).json({ error: 'Unable to verify user.' });
    const validPw = await bcrypt.compare(password, user.password_hash);
    if (!validPw) return res.status(401).json({ error: 'Incorrect password.' });

    try {
      if (oldDescription != null) {
        const current = await readCurrentDescription(batchNumber, itemNumber, lineNumber);
        if (current === null) return res.status(404).json({ error: 'Line not found in Sage.' });
        if (current.trim() !== String(oldDescription).trim()) {
          return res.status(409).json({
            error: 'Description was changed since you loaded this page. Please refresh and try again.',
            currentDescription: current,
          });
        }
      }

      const result = await updateSageDescription({ batchNumber, itemNumber, lineNumber, newDescription });

      logAudit({
        req,
        action: 'sage_correction_apply',
        resourceType: 'sage',
        resourceId: `APIBD:${batchNumber}/${itemNumber}/${lineNumber}`,
        resourceName: `Batch ${batchNumber} Item ${itemNumber} Line ${lineNumber}`,
        details: `Sage TEXTDESC corrected (password-confirmed)`,
        changes: {
          before: { TEXTDESC: oldDescription || '(unknown)' },
          after: { TEXTDESC: newDescription },
        },
      });

      res.json({ ok: true, rowsAffected: result.rowsAffected });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      res.status(isSageDown ? 503 : 500).json({ error: err.message });
    }
  });

  return router;
}
