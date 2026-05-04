export function hasPermission(user, permissionKey) {
  if (!user) return false;
  if (user.role === "admin") {
    // Admins see everything BY DEFAULT, but a permission can be explicitly
    // disabled for them via the User Management UI. The DB column type is
    // INTEGER (0/1); the admin migration sets every existing admin's
    // permissions to 1 so this check only fires when an operator
    // intentionally toggles a module off for a specific admin (e.g. a
    // BAT-only admin who shouldn't see Network Devices).
    if (permissionKey && (user[permissionKey] === 0 || user[permissionKey] === false)) {
      return false;
    }
    return true;
  }
  // Bug fix: a missing/empty permissionKey must NOT grant permission.
  // Previously `if (!permissionKey) return true` allowed any unauthenticated
  // code path that forgot to pass a key to silently succeed.
  if (!permissionKey) return false;
  return !!user[permissionKey];
}
