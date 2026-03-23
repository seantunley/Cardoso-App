export function hasPermission(user, permissionKey) {
  if (!user) return false;
  if (user.role === "admin") return true;
  // Bug fix: a missing/empty permissionKey must NOT grant permission.
  // Previously `if (!permissionKey) return true` allowed any unauthenticated
  // code path that forgot to pass a key to silently succeed.
  if (!permissionKey) return false;
  return !!user[permissionKey];
}
