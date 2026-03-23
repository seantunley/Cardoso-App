export function hasPermission(user, permissionKey) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (!permissionKey) return true;
  return !!user[permissionKey];
}