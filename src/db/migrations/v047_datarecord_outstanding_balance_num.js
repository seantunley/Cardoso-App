import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 47,
      name: 'datarecord_outstanding_balance_num',
      up(db) {
        // Numeric mirror of outstanding_balance (which is TEXT, often with
        // commas / spaces). Lets ORDER BY / WHERE use a real index instead of
        // CAST(REPLACE(REPLACE(...))) on every row. SQLite triggers keep the
        // numeric column in sync on every insert/update — no app-code changes
        // needed in the sync engine.
        const dataCols = db.prepare("PRAGMA table_info(datarecord)").all().map(c => c.name);
        if (!dataCols.includes('outstanding_balance_num')) {
          db.exec(`ALTER TABLE datarecord ADD COLUMN outstanding_balance_num REAL`);
        }
        db.exec(`
          UPDATE datarecord
          SET outstanding_balance_num = CASE
            WHEN outstanding_balance IS NULL OR outstanding_balance = '' OR outstanding_balance = '0'
              THEN NULL
            ELSE CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL)
          END
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_datarecord_balance_num ON datarecord(outstanding_balance_num)`);
        // Triggers — fire on insert/update of outstanding_balance only.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_datarecord_balance_num_ins
          AFTER INSERT ON datarecord
          BEGIN
            UPDATE datarecord SET outstanding_balance_num = CASE
              WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                THEN NULL
              ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
            END WHERE id = NEW.id;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_datarecord_balance_num_upd
          AFTER UPDATE OF outstanding_balance ON datarecord
          BEGIN
            UPDATE datarecord SET outstanding_balance_num = CASE
              WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                THEN NULL
              ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
            END WHERE id = NEW.id;
          END
        `);

        // Mirror on hub_records if present.
        try {
          const hubCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
          if (hubCols.length > 0 && !hubCols.includes('outstanding_balance_num')) {
            db.exec(`ALTER TABLE hub_records ADD COLUMN outstanding_balance_num REAL`);
            db.exec(`
              UPDATE hub_records
              SET outstanding_balance_num = CASE
                WHEN outstanding_balance IS NULL OR outstanding_balance = '' OR outstanding_balance = '0'
                  THEN NULL
                ELSE CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL)
              END
            `);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_records_balance_num ON hub_records(outstanding_balance_num)`);
            // hub_records uses a composite primary key (site_id, record_id),
            // not a single `id` column. The earlier version of this trigger
            // had `WHERE id = NEW.id` (copy-pasted from the datarecord
            // trigger) which makes SQLite refuse to prepare ANY insert/update
            // against hub_records with "no such column: id" — the Hub's
            // entire customer-records ETL silently fails as a result.
            //
            // Migration 54 below repairs already-broken Hubs by dropping +
            // recreating these triggers with the correct composite-key
            // WHERE clause.
            db.exec(`
              CREATE TRIGGER IF NOT EXISTS trg_hub_records_balance_num_ins
              AFTER INSERT ON hub_records
              BEGIN
                UPDATE hub_records SET outstanding_balance_num = CASE
                  WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                    THEN NULL
                  ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
                END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
              END
            `);
            db.exec(`
              CREATE TRIGGER IF NOT EXISTS trg_hub_records_balance_num_upd
              AFTER UPDATE OF outstanding_balance ON hub_records
              BEGIN
                UPDATE hub_records SET outstanding_balance_num = CASE
                  WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                    THEN NULL
                  ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
                END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
              END
            `);
          }
        } catch {}
      },
    };
