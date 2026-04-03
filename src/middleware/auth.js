/**
 * Auth middleware — extracted from server.js (US-003).
 *
 * Exports a factory so the caller can inject getUserById and sanitizeUser
 * (which depend on prepared statements built after db init).
 */

export function createAuthMiddleware({ getUserById, sanitizeUser }) {

  function requireAuth(req, res, next) {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = getUserById(req.session.userId);
    if (!user || !user.is_active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Session expired' });
    }

    req.currentUser = sanitizeUser(user);
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.currentUser || req.currentUser.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  }

  function requirePermission(...permissionKeys) {
    return (req, res, next) => {
      if (!req.currentUser) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      if (req.currentUser.role === 'admin') {
        return next();
      }

      // Deny access if no permission key was specified (fail-closed)
      if (!permissionKeys.length) {
        return res.status(403).json({ error: 'Permission denied' });
      }

      // Allow if user has ANY of the specified permissions (OR logic)
      if (!permissionKeys.some(key => req.currentUser[key])) {
        return res.status(403).json({ error: 'Permission denied' });
      }

      next();
    };
  }

  function requireSelfOrAdmin(req, res, next) {
    const targetId = parseInt(req.params.id, 10);
    if (req.currentUser?.role === 'admin' || req.currentUser?.id === targetId) {
      return next();
    }
    return res.status(403).json({ error: 'Permission denied' });
  }

  function checkTableAccess(req, table, method) {
    const user = req.currentUser;
    if (!user) return { ok: false, status: 401, error: 'Not authenticated' };

    if (user.role === 'admin') return { ok: true };

    const readOnly = method === 'GET';

    switch (table) {
      case 'datarecord':
        // can_access_customer_search grants read access (used by CustomerSearch page)
        // can_access_records grants full read + edit access (Records management page)
        if (!user.can_access_records && !user.can_access_customer_search) {
          return { ok: false, status: 403, error: 'No access to records' };
        }
        if (!readOnly && !user.can_edit_records) {
          return { ok: false, status: 403, error: 'No permission to edit records' };
        }
        return { ok: true };

      case 'databaseconnection':
        // All authenticated users can read connections (sync status is global)
        // Only users with can_access_connections can create/edit/delete
        if (!readOnly && !user.can_access_connections) {
          return { ok: false, status: 403, error: 'No permission to modify connections' };
        }
        return { ok: true };

      case 'autoflagrule':
      case 'customfieldconfig':
        if (!user.can_access_settings && !user.can_manage_rules) {
          return { ok: false, status: 403, error: 'No access to settings' };
        }
        return { ok: true };

      case 'auditlog':
      case 'user':
      case 'syncrun':
        return { ok: false, status: 403, error: 'Restricted table' };

      default:
        return { ok: true };
    }
  }

  return { requireAuth, requireAdmin, requirePermission, requireSelfOrAdmin, checkTableAccess };
}
