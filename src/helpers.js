// ==================== SHARED HELPERS ====================
// Utility functions used across routes and services.
// This file must NOT import from any route or service file.

export const sanitizeForSqlite = (data) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    sanitized[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return sanitized;
};

export function parseJsonSafely(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stringifyJsonSafely(value, fallback = '{}') {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

// Spread local_fields JSON into the top-level record object so clients can
// access dynamic custom fields as record[field_key] instead of parsing JSON.
export function expandDataRecord(row) {
  if (!row || typeof row !== 'object') return row;
  const localFields = parseJsonSafely(row.local_fields, {});
  const expanded = { ...row, ...localFields };

  // Expand unpaid_invoices JSON array back to flat numbered fields for API compat
  const invoices = parseJsonSafely(row.unpaid_invoices, []);
  if (Array.isArray(invoices)) {
    invoices.forEach((inv, i) => {
      const n = i + 1;
      expanded[`last_unpaid_invoice_${n}`]        = inv.number ?? '';
      expanded[`last_unpaid_invoice_${n}_amount`] = inv.amount ?? '';
      expanded[`last_unpaid_invoice_${n}_date`]   = inv.date   ?? '';
    });
  }

  // Expand receipts JSON array back to flat numbered fields for API compat
  const recs = parseJsonSafely(row.receipts, []);
  if (Array.isArray(recs)) {
    recs.forEach((rec, i) => {
      const n = i + 1;
      expanded[`last_receipt_${n}`]        = rec.number ?? '';
      expanded[`last_receipt_${n}_amount`] = rec.amount ?? '';
      expanded[`last_receipt_${n}_date`]   = rec.date   ?? '';
    });
  }

  return expanded;
}

export function normalizeFieldKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function validateCustomFieldKey(key) {
  return /^[a-z][a-z0-9_]*$/.test(key);
}

export function boolFromRow(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return !!value;
}

export function defaultPermissionsForRole(role) {
  if (role === 'admin') {
    return {
      can_access_customer_search: true,
      can_access_customer_balances: true,
      can_access_collections: true,
      can_access_inventory: true,
      can_access_hub_metrics: true,
      can_access_hub_backups: true,
      can_access_hub_trends: true,
      can_access_hub_audit_log: true,
      can_access_records: true,
      can_access_reports: true,
      can_access_connections: true,
      can_access_settings: true,
      can_manage_users: true,
      can_manage_rules: true,
      can_edit_records: true,
      can_flag_records: true,
    };
  }

  return {
    can_access_customer_search: true,
    can_access_customer_balances: true,
    can_access_collections: true,
    can_access_inventory: true,
    can_access_hub_metrics: false,
    can_access_hub_backups: false,
    can_access_hub_trends: false,
    can_access_hub_audit_log: false,
    can_access_records: false,
    can_access_reports: false,
    can_access_connections: false,
    can_access_settings: false,
    can_manage_users: false,
    can_manage_rules: false,
    can_edit_records: true,
    can_flag_records: true,
  };
}

export function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    theme_preference: user.theme_preference,
    is_active: boolFromRow(user.is_active, true),
    hub_redirect: boolFromRow(user.hub_redirect, false),
    can_access_customer_search: boolFromRow(user.can_access_customer_search, true),
    can_access_customer_balances: boolFromRow(user.can_access_customer_balances, true),
    can_access_collections: boolFromRow(user.can_access_collections, true),
    can_access_inventory: boolFromRow(user.can_access_inventory, true),
    can_access_hub_metrics: boolFromRow(user.can_access_hub_metrics, false),
    can_access_hub_backups: boolFromRow(user.can_access_hub_backups, false),
    can_access_hub_trends: boolFromRow(user.can_access_hub_trends, false),
    can_access_hub_audit_log: boolFromRow(user.can_access_hub_audit_log, false),
    can_access_records: boolFromRow(user.can_access_records, false),
    can_access_reports: boolFromRow(user.can_access_reports, false),
    can_access_connections: boolFromRow(user.can_access_connections, false),
    can_access_settings: boolFromRow(user.can_access_settings, false),
    can_manage_users: boolFromRow(user.can_manage_users, false),
    can_manage_rules: user.role === 'admin' ? true : boolFromRow(user.can_manage_rules, false),
    can_edit_records: boolFromRow(user.can_edit_records, true),
    can_flag_records: boolFromRow(user.can_flag_records, true),
    created_date: user.created_date,
  };
}

export function sanitizeConnection(conn) {
  if (!conn) return null;
  const { encrypted_password, ...safe } = conn;
  return safe;
}
