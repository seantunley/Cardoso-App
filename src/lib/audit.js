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

// Render a permission name into something human: "can_access_customer_search"
// becomes "Customer Search". Falls back to the raw key for unknown shapes.
function humanizeKey(key) {
  if (!key) return '';
  let s = String(key);
  s = s.replace(/^can_(access|manage|edit|flag)_/, '');
  s = s.replace(/_/g, ' ');
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

// "true" / 1 / "1" → "on"; "false" / 0 / "" → "off"; otherwise stringify.
function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '∅';
  if (v === true || v === 1 || v === '1') return 'on';
  if (v === false || v === 0 || v === '0') return 'off';
  if (typeof v === 'object') {
    try { return JSON.stringify(v).slice(0, 60); } catch { return '[object]'; }
  }
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

// Build a "key: old → new; key2: old → new" summary from a {before, after}
// changes payload. Caps at MAX_PARTS so the audit row stays readable.
function summarizeDiff(changes, MAX_PARTS = 6) {
  if (!changes || typeof changes !== 'object') return null;
  const before = changes.before || {};
  const after  = changes.after  || {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const parts = [];
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (b === a) continue;
    parts.push(`${humanizeKey(k)}: ${fmtValue(b)} → ${fmtValue(a)}`);
  }
  if (parts.length === 0) return null;
  if (parts.length <= MAX_PARTS) return parts.join('; ');
  return parts.slice(0, MAX_PARTS).join('; ') + ` (+${parts.length - MAX_PARTS} more)`;
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
    // If caller didn't supply a human details string, derive one from the
    // diff so the audit row tells the reader something at a glance.
    let resolvedDetails = details;
    if (!resolvedDetails && changes && (changes.before || changes.after)) {
      resolvedDetails = summarizeDiff(changes);
    }
    insertAudit.run(
      String(action || 'unknown').slice(0, 64),
      user.email || 'system',
      user.full_name || user.email || '',
      resourceType,
      resourceId != null ? String(resourceId).slice(0, 200) : null,
      resourceName ? String(resourceName).slice(0, 200) : null,
      resolvedDetails ? String(resolvedDetails).slice(0, 1000) : null,
      changes ? JSON.stringify(changes).slice(0, 4000) : null,
      extractIp(req),
      status === 'failure' ? 'failure' : 'success',
    );
  } catch (err) {
    console.error('[audit] insert failed:', err.message);
  }
}

// Re-export so callers can build their own pretty summaries when needed.
export { summarizeDiff };
