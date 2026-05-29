// Types for the row shapes returned by /api/* endpoints.
//
// Authored as a TypeScript ambient declaration so apiClient.js can import
// them through JSDoc `@typedef {import('@/types/api-rows').BalanceRow}` —
// no .ts conversion needed, but tsc still catches drift between the
// declared shape and how callers read fields off the result.

export interface User {
  id: number;
  email: string;
  full_name: string | null;
  role: string;
  is_admin?: 0 | 1 | boolean;
  /** ISO-ish timestamp. SQLite stores naive UTC; treat as UTC on parse. */
  created_at?: string;
  last_login?: string | null;
  must_change_password?: 0 | 1 | boolean;
  // Per-user feature permissions. These are individual columns on the
  // `user` table; reading any of them off a User row is type-safe.
  can_access_balances?: 0 | 1 | boolean;
  can_access_inventory?: 0 | 1 | boolean;
  can_access_inventory_movement?: 0 | 1 | boolean;
  can_access_price_list?: 0 | 1 | boolean;
  can_access_records?: 0 | 1 | boolean;
  can_access_reconciliation?: 0 | 1 | boolean;
  can_access_collections?: 0 | 1 | boolean;
  can_access_reports?: 0 | 1 | boolean;
  can_access_jti?: 0 | 1 | boolean;
  can_access_network_devices?: 0 | 1 | boolean;
  can_access_operations?: 0 | 1 | boolean;
  can_access_audit?: 0 | 1 | boolean;
  // Allow forward-compat for permissions added after this file was written.
  [permission: string]: unknown;
}

/** A customer's outstanding-balance row as returned by /api/top-balances. */
export interface BalanceRow {
  id: number;
  customer_number: string;
  customer_name: string;
  sales_rep: string | null;
  account_type: string | null;
  outstanding_balance: string;
  /** Numeric form of outstanding_balance — populated by SQLite trigger. */
  outstanding_balance_num?: number;
  /** Operator-assigned manual flag. */
  flag_color: 'red' | 'yellow' | 'green' | 'orange' | 'none' | null;
  flag_reason: string | null;
  auto_flagged: 0 | 1 | null;
  terms: string | null;
  site_name: string;
  /** Server-computed credit verdict (added 2026-05-28 to skip per-row useMemo). */
  credit_verdict?: 'safe' | 'caution' | 'risky' | 'critical' | 'dormant';
  credit_score?: number | null;
  /** Flat columns expanded from `unpaid_invoices` JSON by expandDataRecord. */
  last_unpaid_invoice_1?: string;
  last_unpaid_invoice_1_amount?: string;
  last_unpaid_invoice_1_date?: string;
  last_receipt_1?: string;
  last_receipt_1_amount?: string;
  last_receipt_1_date?: string;
}

/** An inventory item row as returned by /api/inventory/list etc. */
export interface InventoryRow {
  item_number: string;
  item_description: string;
  qty_on_hand: number | string | null;
  last_cost: number | string | null;
  price: number | string | null;
  price_list: number | string | null;
  stocking_uom: string | null;
  commodity?: string | null;
  inventory_value?: number | string | null;
  /** Only present in hub-mode responses. */
  site_id?: string;
  site_name?: string;
}

/** A collections worklist row. */
export interface Worklist {
  id: number;
  name: string;
  owner_user_id: number;
  owner_name?: string | null;
  created_by_user_id: number;
  created_at: string;
  archived_at: string | null;
  /** Aggregated counts surfaced by GET /api/collections/worklists. */
  active_count?: number;
  total_count?: number;
}

/** An assignment of a customer to a worklist. */
export interface Assignment {
  id: number;
  worklist_id: number;
  customer_id: string;
  status: 'active' | 'completed' | 'removed';
  assigned_by_user_id: number;
  assigned_at: string;
  opening_balance: number | null;
  last_known_balance: number | null;
  next_followup_date: string | null;
  last_sync_at: string | null;
  // Joined display fields from datarecord.
  customer_number?: string;
  customer_name?: string;
  sales_rep?: string | null;
  account_type?: string | null;
  outstanding_balance?: string | null;
  flag_color?: string | null;
  last_invoice_date?: string | null;
  last_receipt_date?: string | null;
}

/** A row in the per-customer collection activity log. */
export interface ActivityItem {
  id: number;
  customer_id: string;
  assignment_id: number | null;
  user_id: number;
  user_name?: string;
  kind:
    | 'note'
    | 'contacted'
    | 'promise_made'
    | 'promise_kept'
    | 'promise_broken'
    | 'payment_received'
    | 'status_changed';
  amount?: number | null;
  promise_date?: string | null;
  body: string | null;
  created_at: string;
}

/** Shape of /api/top-balances response. */
export interface TopBalancesResponse {
  records: BalanceRow[];
  /** Paged total across the whole filter, not just the page. */
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  /** Sum of outstanding_balance_num across the full filter. */
  total_outstanding?: number;
  sales_reps?: string[];
  /** List of distinct site names for the site filter dropdown. */
  sites?: string[];
  /** List of distinct sales rep codes for the sales rep filter dropdown. */
  salesReps?: string[];
  /** Sum of outstanding_balance_num across just this response page. */
  pageTotalOutstanding?: number;
  /** Sum of outstanding_balance_num across the full filtered set. */
  filteredTotalOutstanding?: number;
  /** Operator-configured minimum balance threshold currently in effect. */
  minBalanceThreshold?: number;
}

/** Standard "did the write succeed" response. */
export interface SuccessResponse {
  success: boolean;
  id?: number;
}

/** Shared error response from any endpoint that hits `res.status(N).json`. */
export interface ApiErrorResponse {
  error: string;
  /** Optional contextual identifier (e.g. customer_id, recordId). */
  resourceId?: string | number;
}
