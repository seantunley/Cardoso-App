import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sanitizeUser, defaultPermissionsForRole } from '../helpers.js';
import { explainPermission } from '../lib/permissions.js';
import { logAudit } from '../lib/audit.js';
import { logError } from '../lib/errorLog.js';

// Pull the absolute session expiry off the current request and attach
// it to the user payload as session_expires_at (ISO). The frontend
// SessionExpiryWatcher uses this to start the 5-minute warning
// countdown — every endpoint that returns the *currently authenticated
// user* MUST route the payload through this helper, otherwise the
// watcher stays dormant on that flow and the operator gets silently
// logged out at cookie expiry, which is the exact failure this feature
// exists to prevent. Specifically: /api/auth/login, /api/auth/me,
// /api/auth/hub-token-login, /api/auth/set-initial-password — anywhere
// the response sets a session AND returns a user object the client
// stores into AuthContext.user.
function withSessionExpiry(req, userObj) {
  if (!userObj) return userObj;
  const session_expires_at = req.session?.cookie?.expires
    ? new Date(req.session.cookie.expires).toISOString()
    : null;
  return { ...userObj, session_expires_at };
}

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

    // Tracks which step blew up if we hit the generic catch below — turns
    // a vague "Login failed" into "Login failed during bcrypt verify" so
    // the System Log row points at the actual layer (DB lookup, hash
    // verify, session write, jwt sign, etc.).
    let phase = 'lookup';
    try {
      const user = stmts.getUserByEmail.get(email);

      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      if (!user.is_active) {
        return res.status(403).json({ error: 'User is inactive' });
      }

      phase = 'verify';
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      phase = 'session';
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
        phase = 'hub_redirect';
        const hubUrl = process.env.HUB_REDIRECT_URL || process.env.HUB_SYNC_URL || null;
        const hubTokenSecret = process.env.HUB_TOKEN_SECRET;
        if (hubUrl && hubTokenSecret) {
          // Generate a short-lived JWT for silent Hub login
          const token = jwt.sign(
            { email: user.email, name: user.full_name, role: user.role },
            hubTokenSecret,
            { expiresIn: '5m' }
          );
          const redirectUrl = `${hubUrl}/api/auth/hub-token-login?token=${encodeURIComponent(token)}`;
          // Don't create a session on this site — just redirect
          req.session.destroy(() => {});
          return res.json({ success: true, hub_redirect: redirectUrl });
        } else if (hubUrl) {
          console.warn('[auth] hub_redirect=1 but HUB_TOKEN_SECRET is not set — falling through to local login');
        } else {
          console.warn('[auth] hub_redirect=1 but neither HUB_REDIRECT_URL nor HUB_SYNC_URL is set — falling through to local login');
        }
      }

      res.json({
        success: true,
        user: withSessionExpiry(req, sanitizeUser(user)),
      });
    } catch (error) {
      console.error(`Login error (phase=${phase}):`, error);
      try { logError('auth.login', error, { email: req.body?.email, phase }); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
      res.status(500).json({ error: `Login failed during ${phase}` });
    }
  });

  // Hub silent login: receives a JWT from a site, validates it, auto-logs the user in
  // This enables hub_redirect users to log in at the Hub without a second password entry
  router.post('/api/auth/hub-token-login', async (req, res) => {
    const { token } = req.body || {};
    const hubTokenSecret = process.env.HUB_TOKEN_SECRET;

    if (!hubTokenSecret) {
      return res.status(500).json({ error: 'HUB_TOKEN_SECRET not configured on this Hub' });
    }
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    let payload;
    try {
      // Pin the algorithm explicitly. jsonwebtoken@9 already defaults to HS256
      // when given a string secret and rejects `alg: none`, so this is purely
      // defense-in-depth + intent documentation — closes the door on a future
      // version-bump or refactor accidentally relaxing the algorithm check.
      payload = jwt.verify(token, hubTokenSecret, { algorithms: ['HS256'] });
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired — please log in at the site again' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { email, name, role } = payload;
    if (!email) {
      return res.status(400).json({ error: 'Invalid token: missing email' });
    }

    try {
      // Find or create user on this Hub
      let user = stmts.getUserByEmail.get(email);
      if (!user) {
        // Auto-provision: create user with the details from the token
        // Default to 'user' role if not specified; Hub admin can elevate later
        const roleToUse = role && ['admin', 'user', 'viewer'].includes(role) ? role : 'user';
        const defaultPermissions = defaultPermissionsForRole(roleToUse);
        db.prepare(
          `INSERT INTO "user" (email, full_name, role, permissions, password_hash, is_active, created_at)
           VALUES (?, ?, ?, ?, 'HUB_TOKEN_AUTO', 1, datetime('now'))`
        ).run(email, name || email.split('@')[0], roleToUse, JSON.stringify(defaultPermissions));
        user = stmts.getUserByEmail.get(email);
      }

      if (!user || !user.is_active) {
        return res.status(403).json({ error: 'User account is inactive' });
      }

      // Create session
      req.session.userId = user.id;

      // Return success with sanitized user (Hub will redirect to dashboard).
      // withSessionExpiry attaches session_expires_at so the SessionExpiry
      // watcher engages on hub-token logins (a JWT-issued auto-login still
      // sets a 12h cookie like a regular login).
      res.json({ success: true, user: withSessionExpiry(req, sanitizeUser(user)) });
    } catch (err) {
      console.error('[hub-token-login] error:', err);
      try { logError('auth.hub_token_login', err); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
      res.status(500).json({ error: 'Hub login failed' });
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
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      stmts.updateUserPassword.run(hash, userId);

      // Upgrade session to full login
      const user = db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(userId);
      req.session.pendingUserId = null;
      req.session.userId = userId;

      logAudit({
        req, action: 'set_initial_password', resourceType: 'user',
        resourceId: user.id, resourceName: user.email,
        details: 'First-time password set; must_change_password cleared',
        userOverride: user,
      });

      // Hub redirect check
      if (user.hub_redirect) {
        const hubUrl = process.env.HUB_REDIRECT_URL || process.env.HUB_SYNC_URL || null;
        const hubTokenSecret = process.env.HUB_TOKEN_SECRET;
        if (hubUrl && hubTokenSecret) {
          const token = jwt.sign(
            { email: user.email, name: user.full_name, role: user.role },
            hubTokenSecret,
            { expiresIn: '5m' }
          );
          const redirectUrl = `${hubUrl}/api/auth/hub-token-login?token=${encodeURIComponent(token)}`;
          req.session.destroy(() => {});
          return res.json({ success: true, hub_redirect: redirectUrl });
        } else if (hubUrl) {
          console.warn('[auth] hub_redirect=1 but HUB_TOKEN_SECRET is not set — falling through to local login');
        }
      }

      res.json({ success: true, user: withSessionExpiry(req, sanitizeUser(user)) });
    } catch (err) {
      console.error('set-initial-password error:', err);
      res.status(500).json({ error: 'Failed to set password' });
    }
  });

  router.get('/api/auth/me', requireAuth, (req, res) => {
    res.json(withSessionExpiry(req, req.currentUser));
  });

  // Session extension — bumps the cookie's maxAge so the absolute expiry
  // moves forward by the original window. Called by the client when the
  // operator clicks "Continue" on the about-to-expire warning. With
  // resave: false, mutating cookie.maxAge marks the session dirty so it's
  // persisted to SqliteStore and the Set-Cookie header is rewritten with
  // the new expires.
  router.post('/api/auth/extend-session', requireAuth, (req, res) => {
    try {
      // Mirror the original cookie maxAge (12h, defined in server.js).
      // Reading process.env here keeps the source of truth in one place
      // if we ever make this configurable; for now the literal matches.
      const MAX_AGE_MS = 1000 * 60 * 60 * 12;
      req.session.cookie.maxAge = MAX_AGE_MS;
      req.session.save((err) => {
        if (err) {
          try { logError('auth.extend_session', err, { user_id: req.currentUser?.id }); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
          return res.status(500).json({ error: 'Failed to extend session' });
        }
        const expires = req.session?.cookie?.expires
          ? new Date(req.session.cookie.expires).toISOString()
          : null;
        res.json({ success: true, session_expires_at: expires });
      });
    } catch (err) {
      try { logError('auth.extend_session', err, { user_id: req.currentUser?.id }); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
      res.status(500).json({ error: 'Failed to extend session' });
    }
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
          can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory, can_access_inventory_movement, can_access_price_list, can_access_network_devices,
          can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends,
          can_access_records, can_access_reports, can_access_connections, can_access_reconciliation, can_access_hub_reconciliation, can_access_settings,
          can_access_jti, can_access_stock_receipt_expiry, can_access_creditors, can_access_commission,
          can_manage_users, can_manage_rules, can_edit_records, can_flag_records
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        defaults.can_access_inventory_movement ? 1 : 0,
        defaults.can_access_price_list ? 1 : 0,
        defaults.can_access_network_devices ? 1 : 0,
        defaults.can_access_hub_metrics ? 1 : 0,
        defaults.can_access_hub_backups ? 1 : 0,
        defaults.can_access_hub_trends ? 1 : 0,
        defaults.can_access_records ? 1 : 0,
        defaults.can_access_reports ? 1 : 0,
        defaults.can_access_connections ? 1 : 0,
        defaults.can_access_reconciliation ? 1 : 0,
        defaults.can_access_hub_reconciliation ? 1 : 0,
        defaults.can_access_settings ? 1 : 0,
        defaults.can_access_jti ? 1 : 0,
        defaults.can_access_stock_receipt_expiry ? 1 : 0,
        defaults.can_access_creditors ? 1 : 0,
        defaults.can_access_commission ? 1 : 0,
        defaults.can_manage_users ? 1 : 0,
        defaults.can_manage_rules ? 1 : 0,
        defaults.can_edit_records ? 1 : 0,
        defaults.can_flag_records ? 1 : 0
      );

      const newUser = getUserById(info.lastInsertRowid);
      logAudit({
        req, action: 'create_user', resourceType: 'user',
        resourceId: newUser.id, resourceName: newUser.email,
        details: `Role: ${role}${mustChange ? ' (must change password on first login)' : ''}`,
      });
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
      'can_access_inventory_movement',
      'can_access_price_list',
      'can_access_network_devices',
      'can_access_hub_metrics',
      'can_access_hub_backups',
      'can_access_hub_trends',
      'can_access_records',
      'can_access_reports',
      'can_access_connections',
      'can_access_reconciliation',
      'can_access_hub_reconciliation',
      'can_access_settings',
      'can_access_jti',
      'can_access_stock_receipt_expiry',
      'can_access_creditors',
      'can_access_commission',
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

      // Role change — accepted alongside the boolean permission flags so
      // the same modal can demote admin → user. Three safety guards:
      //   1. Role must be 'admin' or 'user' (matches the CHECK constraint
      //      on the user table).
      //   2. Operator can't demote themselves (would lock them out of
      //      this very endpoint immediately).
      //   3. Can't demote the LAST remaining admin (system would have
      //      no admins to manage users with).
      if (typeof incoming.role === 'string' && incoming.role !== existing.role) {
        const newRole = incoming.role.trim();
        if (newRole !== 'admin' && newRole !== 'user') {
          return res.status(400).json({ error: 'role must be "admin" or "user".' });
        }
        if (existing.role === 'admin' && newRole === 'user') {
          if (req.currentUser?.id === existing.id) {
            return res.status(400).json({
              error: 'You cannot demote yourself. Ask another admin to do it.',
            });
          }
          const adminCount = db.prepare(
            `SELECT COUNT(*) AS c FROM "user" WHERE role = 'admin' AND is_active = 1`
          ).get()?.c ?? 0;
          if (adminCount <= 1) {
            return res.status(400).json({
              error: 'Cannot demote the last remaining admin — promote someone else to admin first.',
            });
          }
        }
        updates.role = newRole;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid permission updates provided' });
      }

      const sets = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
      db.prepare(`UPDATE "user" SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);

      const updated = getUserById(id);
      // Only audit the permissions that ACTUALLY changed (UI typically sends
      // every permission key on every save, even untouched ones).
      const realChangesBefore = {};
      const realChangesAfter = {};
      for (const k of Object.keys(updates)) {
        if (existing[k] !== updates[k]) {
          realChangesBefore[k] = existing[k];
          realChangesAfter[k]  = updates[k];
        }
      }
      const changedCount = Object.keys(realChangesAfter).length;
      if (changedCount > 0) {
        logAudit({
          req, action: 'update_user_permissions', resourceType: 'user',
          resourceId: updated.id, resourceName: updated.email,
          // Let logAudit auto-summarise the before→after diff in action_details.
          changes: { before: realChangesBefore, after: realChangesAfter },
        });
      }
      res.json({
        success: true,
        user: sanitizeUser(updated),
      });
    } catch (error) {
      console.error('Update permissions error:', error);
      res.status(500).json({ error: 'Failed to update permissions' });
    }
  });

  // GET /api/users/:id/permission-explain[?key=can_access_X]
  //
  // Diagnostic endpoint that explains how a user's effective permissions
  // are derived. Backs the "Why denied?" admin tool — when an operator
  // can't figure out why a user can't see a page, they hit this and see
  // exactly which rule produced the answer (admin default, explicit
  // user grant, explicit deny, etc.).
  //
  // Same allowed list as PUT /api/users/:id/permissions — keeps the
  // diagnostic in lockstep with what's actually settable.
  router.get('/api/users/:id/permission-explain', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const target = getUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    const sanitized = sanitizeUser(target);

    const allowed = [
      'can_access_customer_search',
      'can_access_customer_balances',
      'can_access_collections',
      'can_access_inventory',
      'can_access_inventory_movement',
      'can_access_price_list',
      'can_access_network_devices',
      'can_access_hub_metrics',
      'can_access_hub_backups',
      'can_access_hub_trends',
      'can_access_records',
      'can_access_reports',
      'can_access_connections',
      'can_access_reconciliation',
      'can_access_hub_reconciliation',
      'can_access_settings',
      'can_access_jti',
      'can_access_stock_receipt_expiry',
      'can_access_creditors',
      'can_access_commission',
      'can_manage_users',
      'can_manage_rules',
      'can_edit_records',
      'can_flag_records',
      // hub_redirect is editable in UserPermissionsModal so the diagnostic
      // must explain it too. Initially missed; PR review caught it. The
      // explainPermission logic handles non-perm boolean columns the same
      // way as perms (read user[key], compare to 1/true) — semantics for
      // hub_redirect are slightly different (controls login redirect, not
      // page access) but the "is this value 1?" answer is still useful.
      'hub_redirect',
    ];

    const requestedKey = typeof req.query.key === 'string' ? req.query.key : null;
    if (requestedKey) {
      if (!allowed.includes(requestedKey)) {
        return res.status(400).json({ error: `Unknown permission key: ${requestedKey}` });
      }
      return res.json({
        user: { id: sanitized.id, email: sanitized.email, role: sanitized.role },
        permissions: { [requestedKey]: explainPermission(sanitized, requestedKey) },
      });
    }

    const explanations = {};
    for (const key of allowed) {
      explanations[key] = explainPermission(sanitized, key);
    }

    res.json({
      user: { id: sanitized.id, email: sanitized.email, role: sanitized.role },
      permissions: explanations,
    });
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
      logAudit({
        req, action: 'update_user_profile', resourceType: 'user',
        resourceId: updated.id, resourceName: updated.email,
        changes: {
          before: { email: existing.email, full_name: existing.full_name },
          after:  { email: updated.email,  full_name: updated.full_name },
        },
      });
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

      logAudit({
        req, action: 'update_user_password', resourceType: 'user',
        resourceId: existing.id, resourceName: existing.email,
        details: parseInt(id, 10) === req.currentUser.id ? 'Self-service password change' : 'Admin password reset',
      });
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

      logAudit({
        req, action: 'delete_user', resourceType: 'user',
        resourceId: existing.id, resourceName: existing.email,
        details: `Role: ${existing.role}`,
      });
      res.json({ success: true });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  return router;
}
