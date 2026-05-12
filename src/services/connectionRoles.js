// Per-module connection routing. Each "role" is a module that needs a single
// SQL Server connection; rows in connection_role pin a role to a specific
// databaseconnection.id. When a role is unset, the consuming module falls back
// to its legacy auto-pick logic so existing installs keep working until an
// operator configures the routing in Settings → Connections.

import db from '../db/index.js';

// Whitelist of known roles. Add a new entry here when wiring a new module.
export const KNOWN_ROLES = [
  { id: 'customer_lookup',  label: 'Customer module — live customer/AR queries' },
  { id: 'inventory_lookup', label: 'Inventory module — live stock/pricing queries' },
  { id: 'bat_sage',         label: 'BAT reconciliation — Sage 300' },
  { id: 'jti_export',       label: 'JTI export — Sage 300 (OE Shipment History)' },
];

const VALID_ROLE_IDS = new Set(KNOWN_ROLES.map(r => r.id));

export function getRoleConnectionId(role) {
  try {
    const row = db.prepare('SELECT connection_id FROM connection_role WHERE role = ?').get(role);
    return row?.connection_id ?? null;
  } catch {
    // Table may not exist yet on a brand-new install before migrations run
    return null;
  }
}

export function listConnectionRoles() {
  try {
    return db.prepare('SELECT role, connection_id FROM connection_role').all();
  } catch {
    return [];
  }
}

export function setRoleConnection(role, connectionId) {
  if (!VALID_ROLE_IDS.has(role)) {
    throw new Error(`Unknown role: ${role}`);
  }
  if (connectionId == null) {
    db.prepare('DELETE FROM connection_role WHERE role = ?').run(role);
    return;
  }
  const exists = db.prepare('SELECT 1 FROM databaseconnection WHERE id = ?').get(connectionId);
  if (!exists) throw new Error(`Connection ${connectionId} not found`);
  db.prepare(`
    INSERT INTO connection_role (role, connection_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(role) DO UPDATE SET
      connection_id = excluded.connection_id,
      updated_at = excluded.updated_at
  `).run(role, connectionId);
}
