-- Migration 002: Import staging and logging tables
-- Purpose: Buffer SQLite → Postgres imported records for validation before upsert
-- Additive only — no existing table alterations

CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

-- Staging table: holds raw imported records pending validation
CREATE TABLE IF NOT EXISTS __SCHEMA__.hub_import_staging (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_run_id BIGINT,
  site_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  customer_number TEXT,
  customer_name TEXT,
  sales_rep TEXT,
  account_type TEXT,
  terms TEXT,
  flag_color TEXT,
  flag_reason TEXT,
  flag_created_by TEXT,
  flag_source TEXT,
  auto_flagged BOOLEAN DEFAULT FALSE,
  outstanding_balance_text TEXT,
  unpaid_invoices JSONB NOT NULL DEFAULT '[]'::jsonb,
  receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload JSONB,
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hub_import_staging_run_site_record UNIQUE (import_run_id, site_id, source_record_id)
);

-- Import log: tracks each import run and its outcome
CREATE TABLE IF NOT EXISTS __SCHEMA__.hub_import_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'validation_failed')),
  records_total INTEGER NOT NULL DEFAULT 0,
  records_valid INTEGER NOT NULL DEFAULT 0,
  records_invalid INTEGER NOT NULL DEFAULT 0,
  records_upserted INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Foreign key from staging to import log
ALTER TABLE __SCHEMA__.hub_import_staging
  ADD CONSTRAINT hub_import_staging_import_run_fk
  FOREIGN KEY (import_run_id) REFERENCES __SCHEMA__.hub_import_log(id) ON DELETE CASCADE;

-- Indexes for staging query performance
CREATE INDEX IF NOT EXISTS idx_staging_run_id ON __SCHEMA__.hub_import_staging(import_run_id);
CREATE INDEX IF NOT EXISTS idx_staging_site_id ON __SCHEMA__.hub_import_staging(site_id);
CREATE INDEX IF NOT EXISTS idx_staging_validation_errors ON __SCHEMA__.hub_import_staging((jsonb_array_length(validation_errors) > 0));