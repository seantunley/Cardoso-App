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
  // Let real DB columns win over local_fields so stale custom-field keys
  // cannot blank out built-in columns like sales_rep/account_type.
  const expanded = { ...localFields, ...row };

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

export function normalizeLooseFieldKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export const SALES_REP_ALIASES = [
  'sales_rep', 'sale_rep', 'SalesRep', 'SALEREP', 'SalesRepCode', 'salesrep', 'sales_rep_code',
  'SalesPerson', 'SalesPersonCode', 'salespersoncode', 'salesperson_code', 'Sales Rep', 'Sales Rep Code',
  'SalesRepName', 'SalesPersonName', 'salesperson_name', 'sales_rep_name',
  'Salesman', 'SalesmanCode', 'SalesmanName', 'salesman_code', 'salesman_name',
  'Rep', 'RepCode', 'RepName', 'rep_code', 'rep_name', 'SLSREP', 'SLSMAN'
];

export const ACCOUNT_TYPE_ALIASES = [
  'account_type', 'AccountType', 'ACCOUNT_TYPE', 'accounttype', 'account_type_code',
  'acct_type', 'accttype', 'acc_type', 'Type', 'TypeCode',
  'CUSTOMER_TYPE', 'CustomerType', 'customer_type', 'Customer Type',
  'Class', 'CustomerClass', 'customer_class', 'Account Type', 'Account Class', 'account_class'
];

function isLikelySalesRepKey(key) {
  const normalized = normalizeLooseFieldKey(key);
  if (!normalized) return false;
  return (
    normalized.includes('salesrep') ||
    normalized.includes('salerep') ||
    normalized.includes('salesperson') ||
    normalized.includes('salesman') ||
    normalized.includes('slsrep') ||
    normalized.includes('slsman') ||
    (normalized.includes('rep') && normalized.includes('sales'))
  );
}

function isLikelyAccountTypeKey(key) {
  const normalized = normalizeLooseFieldKey(key);
  if (!normalized) return false;
  return (
    normalized.includes('accounttype') ||
    normalized.includes('customertype') ||
    normalized.includes('customerclass') ||
    normalized.includes('accountclass') ||
    normalized.includes('accttype') ||
    normalized.includes('acctype') ||
    (normalized.includes('type') && (normalized.includes('account') || normalized.includes('customer') || normalized.includes('acct'))) ||
    (normalized.includes('class') && (normalized.includes('account') || normalized.includes('customer')))
  );
}

export function getFirstNonEmptyObjectValue(source, aliases = []) {
  if (!source || typeof source !== 'object') return '';

  for (const key of aliases) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  const entries = Object.entries(source);
  const normalizedSourceEntries = new Map(
    entries.map(([key, value]) => [normalizeLooseFieldKey(key), value])
  );

  for (const key of aliases) {
    const value = normalizedSourceEntries.get(normalizeLooseFieldKey(key));
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  const aliasSet = new Set(aliases.map(normalizeLooseFieldKey));
  const useSalesRepHeuristic = SALES_REP_ALIASES.some((key) => aliasSet.has(normalizeLooseFieldKey(key)));
  const useAccountTypeHeuristic = ACCOUNT_TYPE_ALIASES.some((key) => aliasSet.has(normalizeLooseFieldKey(key)));

  if (useSalesRepHeuristic) {
    for (const [key, value] of entries) {
      if (isLikelySalesRepKey(key) && value !== undefined && value !== null && String(value).trim() !== '') {
        return value;
      }
    }
  }

  if (useAccountTypeHeuristic) {
    for (const [key, value] of entries) {
      if (isLikelyAccountTypeKey(key) && value !== undefined && value !== null && String(value).trim() !== '') {
        return value;
      }
    }
  }

  return '';
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
      can_access_network_devices: true,
      can_access_hub_metrics: true,
      can_access_hub_backups: true,
      can_access_hub_trends: true,
      can_access_records: true,
      can_access_reports: true,
      can_access_connections: true,
      can_access_reconciliation: true,
      can_access_hub_reconciliation: true,
      can_access_settings: true,
      can_access_jti: true,
      can_access_stock_receipt_expiry: true,
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
    can_access_network_devices: false,
    can_access_hub_metrics: false,
    can_access_hub_backups: false,
    can_access_hub_trends: false,
    can_access_records: false,
    can_access_reports: false,
    can_access_connections: false,
    can_access_reconciliation: false,
    can_access_hub_reconciliation: false,
    can_access_settings: false,
    can_access_jti: false,
    can_access_stock_receipt_expiry: false,
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
    can_access_network_devices: boolFromRow(user.can_access_network_devices, false),
    can_access_hub_metrics: boolFromRow(user.can_access_hub_metrics, false),
    can_access_hub_backups: boolFromRow(user.can_access_hub_backups, false),
    can_access_hub_trends: boolFromRow(user.can_access_hub_trends, false),
    can_access_records: boolFromRow(user.can_access_records, false),
    can_access_reports: boolFromRow(user.can_access_reports, false),
    can_access_connections: boolFromRow(user.can_access_connections, false),
    can_access_reconciliation: boolFromRow(user.can_access_reconciliation, false),
    can_access_hub_reconciliation: boolFromRow(user.can_access_hub_reconciliation, false),
    can_access_settings: boolFromRow(user.can_access_settings, false),
    can_access_jti: boolFromRow(user.can_access_jti, false),
    can_access_stock_receipt_expiry: boolFromRow(user.can_access_stock_receipt_expiry, false),
    can_manage_users: boolFromRow(user.can_manage_users, false),
    // Used to be `user.role === 'admin' ? true : boolFromRow(...)` which made
    // admins ALWAYS get can_manage_rules regardless of the DB. That broke the
    // new "turn off modules for specific admins" feature: an operator could
    // toggle off Rule Management for an admin and the value was correctly
    // saved to DB, but sanitizeUser kept reporting it as true so the admin
    // still saw the rules editor. Now respects the DB value uniformly; the
    // admin bypass for module visibility lives in lib/permissions.js where
    // it can be overridden cleanly.
    can_manage_rules: boolFromRow(user.can_manage_rules, false),
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
