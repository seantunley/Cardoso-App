CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

CREATE TABLE IF NOT EXISTS __SCHEMA__.sites (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT,
  token TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'online', 'offline', 'error', 'unreachable', 'warning', 'stale')),
  last_seen TIMESTAMPTZ,
  last_kpis JSONB,
  logic_version INTEGER,
  logic_sync_status TEXT NOT NULL DEFAULT 'never_synced',
  logic_last_error TEXT,
  logic_last_synced_at TIMESTAMPTZ,
  logic_status_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS __SCHEMA__.customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES __SCHEMA__.sites(id) ON DELETE RESTRICT,
  source_record_id TEXT NOT NULL,
  customer_number TEXT NOT NULL,
  customer_name TEXT,
  sales_rep TEXT,
  account_type TEXT,
  terms TEXT,
  source_payload JSONB,
  site_updated_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customers_site_record_unique UNIQUE (site_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS __SCHEMA__.customer_balances (
  customer_id BIGINT PRIMARY KEY REFERENCES __SCHEMA__.customers(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES __SCHEMA__.sites(id) ON DELETE RESTRICT,
  outstanding_balance_text TEXT,
  unpaid_invoices JSONB NOT NULL DEFAULT '[]'::jsonb,
  receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
  flag_color TEXT NOT NULL DEFAULT 'none' CHECK (flag_color IN ('none', 'red', 'orange', 'green')),
  flag_reason TEXT,
  flag_created_by TEXT,
  flag_source TEXT,
  auto_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  balance_updated_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS __SCHEMA__.flag_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES __SCHEMA__.sites(id) ON DELETE RESTRICT,
  customer_id BIGINT REFERENCES __SCHEMA__.customers(id) ON DELETE CASCADE,
  source_record_id TEXT,
  customer_number TEXT,
  event_type TEXT NOT NULL DEFAULT 'flag_snapshot' CHECK (event_type IN ('flag_snapshot', 'flag_change', 'manual_override', 'sync_observation')),
  flag_color TEXT CHECK (flag_color IN ('none', 'red', 'orange', 'green')),
  flag_reason TEXT,
  flag_created_by TEXT,
  flag_source TEXT,
  auto_flagged BOOLEAN,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS __SCHEMA__.sync_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id TEXT REFERENCES __SCHEMA__.sites(id) ON DELETE SET NULL,
  sync_scope TEXT NOT NULL DEFAULT 'customers' CHECK (sync_scope IN ('customers', 'balances', 'logic', 'bootstrap', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  records_fetched INTEGER NOT NULL DEFAULT 0 CHECK (records_fetched >= 0),
  rows_upserted INTEGER NOT NULL DEFAULT 0 CHECK (rows_upserted >= 0),
  rows_deleted INTEGER NOT NULL DEFAULT 0 CHECK (rows_deleted >= 0),
  error_text TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sites_status ON __SCHEMA__.sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_last_seen ON __SCHEMA__.sites(last_seen DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_customers_site_number ON __SCHEMA__.customers(site_id, customer_number);
CREATE INDEX IF NOT EXISTS idx_customers_site_name ON __SCHEMA__.customers(site_id, customer_name);
CREATE INDEX IF NOT EXISTS idx_customers_last_synced ON __SCHEMA__.customers(last_synced_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_customer_balances_site_flag ON __SCHEMA__.customer_balances(site_id, flag_color);
CREATE INDEX IF NOT EXISTS idx_customer_balances_site_sync ON __SCHEMA__.customer_balances(site_id, last_synced_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_customer_balances_auto_flagged ON __SCHEMA__.customer_balances(auto_flagged);

CREATE INDEX IF NOT EXISTS idx_flag_events_site_occurred ON __SCHEMA__.flag_events(site_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_flag_events_customer_occurred ON __SCHEMA__.flag_events(customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_flag_events_type ON __SCHEMA__.flag_events(event_type);

CREATE INDEX IF NOT EXISTS idx_sync_runs_site_started ON __SCHEMA__.sync_runs(site_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status_started ON __SCHEMA__.sync_runs(status, started_at DESC);
