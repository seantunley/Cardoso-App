// Centralised audit-log writer. Never throws — audit failures must not break
// the actual operation, just log to console. Resource type is constrained by
// the auditlog schema CHECK to: user | connection | record | rule | system.

import db from '../db/index.js';

const insertAudit = db.prepare(`
  INSERT INTO auditlog (
    action_type, user_email, user_name, resource_type,
    resource_id, resource_name, action_details, changes,
    ip_address, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function extractIp(req) {
  if (!req) return null;
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

export function logAudit({
  req,
  action,
  resourceType,
  resourceId,
  resourceName,
  details,
  changes,
  status = 'success',
  userOverride,
}) {
  try {
    const user = userOverride || req?.currentUser || {};
    insertAudit.run(
      String(action || 'unknown').slice(0, 64),
      user.email || 'system',
      user.full_name || user.email || '',
      resourceType,
      resourceId != null ? String(resourceId).slice(0, 200) : null,
      resourceName ? String(resourceName).slice(0, 200) : null,
      details ? String(details).slice(0, 1000) : null,
      changes ? JSON.stringify(changes).slice(0, 4000) : null,
      extractIp(req),
      status === 'failure' ? 'failure' : 'success',
    );
  } catch (err) {
    console.error('[audit] insert failed:', err.message);
  }
}
