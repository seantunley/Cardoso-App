import express from 'express';
import bcrypt from 'bcryptjs';
import { sanitizeUser, defaultPermissionsForRole } from '../helpers.js';

/**
 * Creates the auth and user routes router.
 * @param {{ db, stmts, getUserById, requireAuth, requireAdmin, requireSelfOrAdmin, loginLimiter }} deps
 */
export function createAuthRouter({ db, stmts, getUserById, requireAuth, requireAdmin, requireSelfOrAdmin, loginLimiter }) {
  const router = express.Router();

  // ==================== AUTH ROUTES ====================

  router.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
      const user = stmts.getUserByEmail.get(email);

      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      if (!user.is_active) {
        return res.status(403).json({ error: 'User is inactive' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      req.session.userId = user.id;

      try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
        db.prepare(`INSERT INTO login_log (user_email, user_name, ip_address, logged_in_at) VALUES (?, ?, ?, datetime('now'))`).run(
          user.email,
          user.full_name || null,
          ip
        );
      } catch (logErr) {
        console.error('Failed to write login log:', logErr);
      }

      // Force password change on first login
      if (user.must_change_password) {
        // Create a temporary session token so the client can call set-initial-password
        req.session.pendingUserId = user.id;
        req.session.userId = null;
        return res.json({ success: false, force_password_change: true });
      }

      // Hub redirect: if user is flagged as a hub user, send them to head office
      if (user.hub_redirect) {
        const hubUrl = process.env.HUB_REDIRECT_URL || null;
        if (hubUrl) {
          // Don't create a session on this site — just redirect
          req.session.destroy(() => {});
          return res.json({ success: true, hub_redirect: hubUrl });
        }
      }

      res.json({
        success: true,
        user: sanitizeUser(user),
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  router.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  router.post('/api/auth/set-initial-password', async (req, res) => {
    const userId = req.session.pendingUserId;
    if (!userId) return res.status(401).json({ error: 'No pending session' });

    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      stmts.updateUserPassword.run(hash, userId);

      // Upgrade session to full login
      const user = db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(userId);
      req.session.pendingUserId = null;
      req.session.userId = userId;

      // Hub redirect check
      if (user.hub_redirect) {
        const hubUrl = process.env.HUB_REDIRECT_URL || null;
        if (hubUrl) {
          req.session.destroy(() => {});
          return res.json({ success: true, hub_redirect: hubUrl });
        }
      }

      res.json({ success: true, user: sanitizeUser(user) });
    } catch (err) {
      console.error('set-initial-password error:', err);
      res.status(500).json({ error: 'Failed to set password' });
    }
  });

  router.get('/api/auth/me', requireAuth, (req, res) => {
    res.json(req.currentUser);
  });

  router.put('/api/auth/me', requireAuth, async (req, res) => {
    const { theme_preference } = req.body || {};
    const allowedThemes = ['light', 'dark'];

    if (theme_preference !== undefined && !allowedThemes.includes(theme_preference)) {
      return res.status(400).json({ error: 'Invalid theme preference' });
    }

    try {
      if (theme_preference !== undefined) {
        db.prepare(`UPDATE "user" SET theme_preference = ? WHERE id = ?`)
          .run(theme_preference, req.currentUser.id);
      }

      const updated = getUserById(req.currentUser.id);
      res.json(sanitizeUser(updated));
    } catch (error) {
      console.error('Update me error:', error);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  // ==================== LOGIN LOG ROUTE ====================
  router.get('/api/login-logs', requireAuth, requireAdmin, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT id, user_email, user_name, ip_address, logged_in_at
        FROM login_log
        ORDER BY logged_in_at DESC
        LIMIT 500
      `).all();
      res.json(rows);
    } catch (error) {
      console.error('Login log error:', error);
      res.status(500).json({ error: 'Failed to load login logs' });
    }
  });

  // ==================== USER ROUTES ====================
  router.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const users = db.prepare(`SELECT * FROM "user" ORDER BY created_date DESC`).all();
      res.json(users.map(sanitizeUser));
    } catch (error) {
      console.error('List users error:', error);
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  router.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const {
      email,
      full_name = '',
      role = 'user',
      password,
    } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    try {
      const existing = db.prepare(`SELECT id FROM "user" WHERE lower(email) = lower(?)`).get(email);
      if (existing) {
        return res.status(400).json({ error: 'A user with this username already exists' });
      }

      const defaults = defaultPermissionsForRole(role);
      const defaultPassword = process.env.DEFAULT_USER_PASSWORD || `Cardoso@${new Date().getFullYear()}`;
      const finalPassword = password || defaultPassword;
      const mustChange = password ? 0 : 1;
      const passwordHash = await bcrypt.hash(finalPassword, 12);

      const info = db.prepare(`
        INSERT INTO "user" (
          email, full_name, role, password_hash, is_active, must_change_password,
          can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory,
          can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
          can_access_records, can_access_reports, can_access_connections, can_access_settings,
          can_manage_users, can_manage_rules, can_edit_records, can_flag_records
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        email.trim().toLowerCase(),
        full_name,
        role,
        passwordHash,
        1,
        mustChange,
        defaults.can_access_customer_search ? 1 : 0,
        defaults.can_access_customer_balances !== false ? 1 : 0,
        defaults.can_access_collections !== false ? 1 : 0,
        defaults.can_access_inventory !== false ? 1 : 0,
        defaults.can_access_hub_metrics ? 1 : 0,
        defaults.can_access_hub_backups ? 1 : 0,
        defaults.can_access_hub_trends ? 1 : 0,
        defaults.can_access_hub_audit_log ? 1 : 0,
        defaults.can_access_records ? 1 : 0,
        defaults.can_access_reports ? 1 : 0,
        defaults.can_access_connections ? 1 : 0,
        defaults.can_access_settings ? 1 : 0,
        defaults.can_manage_users ? 1 : 0,
        defaults.can_manage_rules ? 1 : 0,
        defaults.can_edit_records ? 1 : 0,
        defaults.can_flag_records ? 1 : 0
      );

      const newUser = getUserById(info.lastInsertRowid);
      res.json({
        success: true,
        user: sanitizeUser(newUser),
      });
    } catch (error) {
      console.error('Create user error:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  router.put('/api/users/:id/permissions', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const incoming = req.body || {};

    const allowed = [
      'can_access_customer_search',
      'can_access_customer_balances',
      'can_access_collections',
      'can_access_inventory',
      'can_access_hub_metrics',
      'can_access_hub_backups',
      'can_access_hub_trends',
      'can_access_hub_audit_log',
      'can_access_records',
      'can_access_reports',
      'can_access_connections',
      'can_access_settings',
      'can_manage_users',
      'can_manage_rules',
      'can_edit_records',
      'can_flag_records',
      'hub_redirect',
      'is_active',
    ];

    try {
      const existing = getUserById(id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updates = {};
      for (const key of allowed) {
        if (incoming[key] !== undefined) {
          updates[key] = incoming[key] ? 1 : 0;
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid permission updates provided' });
      }

      const sets = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
      db.prepare(`UPDATE "user" SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);

      const updated = getUserById(id);
      res.json({
        success: true,
        user: sanitizeUser(updated),
      });
    } catch (error) {
      console.error('Update permissions error:', error);
      res.status(500).json({ error: 'Failed to update permissions' });
    }
  });

  router.put('/api/users/:id/profile', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { full_name, email } = req.body;

      if (!email || !email.trim()) {
        return res.status(400).json({ error: 'Username is required' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      const existing = getUserById(id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check username not already taken by another user
      const emailTaken = db.prepare('SELECT id FROM "user" WHERE lower(email) = ? AND id != ?').get(normalizedEmail, id);
      if (emailTaken) {
        return res.status(409).json({ error: 'Username already in use by another account' });
      }

      db.prepare('UPDATE "user" SET email = ?, full_name = ? WHERE id = ?')
        .run(normalizedEmail, (full_name || '').trim(), id);

      const updated = getUserById(id);
      res.json(sanitizeUser(updated));
    } catch (err) {
      console.error('Update profile error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/users/:id/password', requireAuth, requireSelfOrAdmin, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body || {};

    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      const existing = getUserById(id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(passwordHash, id);

      res.json({ success: true });
    } catch (error) {
      console.error('Update password error:', error);
      res.status(500).json({ error: 'Failed to update password' });
    }
  });

  router.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const targetId = parseInt(id, 10);

    try {
      const existing = getUserById(targetId);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (targetId === req.currentUser.id) {
        return res.status(400).json({ error: 'You cannot delete your own account' });
      }

      db.prepare(`DELETE FROM "user" WHERE id = ?`).run(targetId);

      res.json({ success: true });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  return router;
}
