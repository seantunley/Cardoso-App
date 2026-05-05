export function hasPermission(user, permissionKey) {
  if (!user) return false;
  // Fail-closed on missing/empty key BEFORE the admin branch. The
  // previous version of this check sat AFTER the admin branch, which
  // meant hasPermission(adminUser, undefined) silently returned true —
  // a code path that forgot to pass a key would leak admin-level access
  // to whatever it was protecting. Now applies uniformly across roles.
  if (!permissionKey) return false;
  if (user.role === "admin") {
    // Admins see everything BY DEFAULT, but a permission can be explicitly
    // disabled for them via the User Management UI. The DB column type is
    // INTEGER (0/1); the admin migration sets every existing admin's
    // permissions to 1 so this check only fires when an operator
    // intentionally toggles a module off for a specific admin (e.g. a
    // BAT-only admin who shouldn't see Network Devices).
    if (user[permissionKey] === 0 || user[permissionKey] === false) {
      return false;
    }
    return true;
  }
  return !!user[permissionKey];
}

/**
 * Diagnostic version of hasPermission. Returns the same boolean answer
 * PLUS a human-readable reason explaining how it got there. Backs the
 * GET /api/users/:id/permission-explain endpoint, which the admin UI
 * uses to answer "why is this user blocked from page X?" without anyone
 * having to mentally trace the rule chain.
 *
 * The boolean MUST match what hasPermission returns for the same inputs
 * — that's the contract; if they ever drift the diagnostic lies. Tests
 * pin this with property-style assertions across the matrix.
 *
 * Returns: { allowed, reason, source }
 *   - allowed: same as hasPermission(user, key)
 *   - reason:  short human-readable explanation
 *   - source:  one of 'no_user' | 'no_key' | 'admin_default' |
 *              'admin_explicit_off' | 'user_grant' | 'user_deny'
 */
export function explainPermission(user, permissionKey) {
  if (!user) {
    return { allowed: false, reason: 'No user supplied (not authenticated).', source: 'no_user' };
  }
  if (!permissionKey) {
    return {
      allowed: false,
      reason: 'No permission key was passed to the check (likely a code bug — fail-closed).',
      source: 'no_key',
    };
  }

  const rawValue = user[permissionKey];

  if (user.role === 'admin') {
    if (rawValue === 0 || rawValue === false) {
      return {
        allowed: false,
        reason: `User is admin BUT '${permissionKey}' is explicitly turned off in their User Permissions row (value=0). Admin defaults are bypassed when an operator explicitly disables a permission.`,
        source: 'admin_explicit_off',
      };
    }
    return {
      allowed: true,
      reason: `User is admin (role='admin') and '${permissionKey}' is not explicitly disabled (value=${describeValue(rawValue)}). Admins get every permission by default.`,
      source: 'admin_default',
    };
  }

  if (rawValue === 1 || rawValue === true) {
    return {
      allowed: true,
      reason: `Non-admin user has '${permissionKey}'=1 in their User Permissions row.`,
      source: 'user_grant',
    };
  }

  return {
    allowed: false,
    reason: `Non-admin user has '${permissionKey}'=${describeValue(rawValue)} in their User Permissions row. Non-admins are denied unless the value is exactly 1 or true.`,
    source: 'user_deny',
  };
}

function describeValue(v) {
  if (v === undefined) return 'undefined (column not set)';
  if (v === null) return 'null';
  if (v === '') return 'empty string';
  return JSON.stringify(v);
}
