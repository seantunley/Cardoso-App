import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 80,
      name: 'collections_worklists_v1',
      up(db) {
        // Phase 1 of the Collections rebuild — adds worklists, per-customer
        // assignments, and an append-only activity log. The existing
        // collections table is left alone for now (its status/notes fields
        // become legacy after Phase 2 routes ship; for migration safety
        // they remain readable until the UI is fully cut over).
        //
        // Customers join a worklist only via a deliberate assignment.
        // Sync hooks can mutate an assignment's status to 'collected'
        // when the customer's balance reaches zero — see services/
        // collectionsSync.js — but never create assignments.
        db.exec(`
          CREATE TABLE IF NOT EXISTS collection_worklist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            owner_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            description TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            created_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            archived_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_collection_worklist_owner
            ON collection_worklist(owner_user_id) WHERE archived_at IS NULL;

          -- Status values:
          --   active       — currently being worked
          --   collected    — auto-set when balance reaches zero
          --   escalated    — manual: handed to legal / external collector
          --   written_off  — manual: bad debt accepted
          --   closed       — manual: any other close reason (e.g. duplicate)
          CREATE TABLE IF NOT EXISTS collection_assignment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worklist_id INTEGER NOT NULL REFERENCES collection_worklist(id) ON DELETE CASCADE,
            customer_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            assigned_at TEXT DEFAULT (datetime('now')),
            assigned_by_user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            closed_at TEXT,
            closed_reason TEXT,
            next_followup_date TEXT,
            opening_balance REAL,
            -- Last-known balance from sync — used by the auto-detect hook
            -- to spot a balance drop without scanning the whole datarecord.
            last_known_balance REAL,
            last_sync_at TEXT,
            UNIQUE(worklist_id, customer_id)
          );
          CREATE INDEX IF NOT EXISTS idx_collection_assignment_customer
            ON collection_assignment(customer_id);
          CREATE INDEX IF NOT EXISTS idx_collection_assignment_worklist_status
            ON collection_assignment(worklist_id, status);
          CREATE INDEX IF NOT EXISTS idx_collection_assignment_followup
            ON collection_assignment(next_followup_date)
            WHERE status = 'active' AND next_followup_date IS NOT NULL;

          -- Append-only event log. Kinds:
          --   note              — free-text note (no transition)
          --   contacted         — rep made contact (call/email/visit)
          --   promise_made      — rep recorded a promised payment
          --   promise_kept      — auto/manual: a promise materialised
          --   promise_broken    — auto/manual: promise date passed unpaid
          --   payment_received  — Sage shows a balance drop (auto from sync)
          --   status_changed    — manual status flip (escalated/written_off/closed/reopened)
          CREATE TABLE IF NOT EXISTS collection_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id TEXT NOT NULL,
            assignment_id INTEGER REFERENCES collection_assignment(id) ON DELETE SET NULL,
            user_id INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            kind TEXT NOT NULL,
            at TEXT DEFAULT (datetime('now')),
            amount REAL,
            promise_date TEXT,
            previous_balance REAL,
            new_balance REAL,
            notes TEXT,
            source TEXT DEFAULT 'manual'
          );
          CREATE INDEX IF NOT EXISTS idx_collection_activity_customer
            ON collection_activity(customer_id, at DESC);
          CREATE INDEX IF NOT EXISTS idx_collection_activity_assignment
            ON collection_activity(assignment_id, at DESC);
          CREATE INDEX IF NOT EXISTS idx_collection_activity_kind
            ON collection_activity(kind, at DESC);
        `);
      },
    };
