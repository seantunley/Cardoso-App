import express from 'express';
import { sanitizeForSqlite, parseJsonSafely, stringifyJsonSafely, expandDataRecord, normalizeFieldKey, validateCustomFieldKey, sanitizeConnection } from '../helpers.js';
import { applyAutoFlagRulesToRecord } from '../services/autoFlag.js';
import { encryptPassword, getEncryptionKey } from '../services/encryption.js';

/**
 * Creates the data-record, auto-flag, and dynamic CRUD routes router.
 * @param {{ db, stmts, requireAuth, requireAdmin, checkTableAccess }} deps
 */
export function createRecordsRouter({ db, stmts, requireAuth, requireAdmin, requirePermission, checkTableAccess }) {
  const router = express.Router();

  // ==================== SCHEMA CACHE ====================
  const allowedTables = new Set([
    'datarecord',
    'databaseconnection',
    'autoflagrule',
    'customfieldconfig',
    'auditlog',
    'user',
    'syncrun',
  ]);

  function isValidTableName(table) {
    return allowedTables.has(table);
  }

  const _schemaCache = new Map();
  function getTableColumns(table) {
    if (_schemaCache.has(table)) return _schemaCache.get(table);
    const cols = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name));
    _schemaCache.set(table, cols);
    return cols;
  }
  // Warm the cache for all allowed tables at startup
  for (const t of allowedTables) {
    try { getTableColumns(t); } catch {}
  }

  // ==================== CUSTOM FIELD CONFIG ROUTES ====================
  router.get(
    '/api/custom-fields',
    requireAuth,
    requirePermission('can_access_settings'),
    (req, res) => {
      try {
        const rows = db.prepare(`
          SELECT *
          FROM customfieldconfig
          ORDER BY datetime(created_date) DESC, field_key ASC
        `).all();

        res.json(rows);
      } catch (error) {
        console.error('List custom fields error:', error);
        res.status(500).json({ error: 'Failed to list custom fields' });
      }
    }
  );

  router.post(
    '/api/custom-fields',
    requireAuth,
    requirePermission('can_access_settings'),
    (req, res) => {
      const {
        field_key,
        label,
        field_type = 'text',
        options = null,
        is_active = 1,
      } = req.body || {};

      const normalizedKey = normalizeFieldKey(field_key || label);

      if (!normalizedKey || !validateCustomFieldKey(normalizedKey)) {
        return res.status(400).json({
          error: 'Invalid field key. Use lowercase letters, numbers, and underscores, starting with a letter.',
        });
      }

      if (!label || !String(label).trim()) {
        return res.status(400).json({ error: 'Label is required' });
      }

      if (!['text', 'select', 'number', 'date'].includes(field_type)) {
        return res.status(400).json({ error: 'Invalid field type' });
      }

      try {
        const existing = db.prepare(`
          SELECT id FROM customfieldconfig WHERE field_key = ?
        `).get(normalizedKey);

        if (existing) {
          return res.status(400).json({ error: 'A field with this key already exists' });
        }

        const info = db.prepare(`
          INSERT INTO customfieldconfig (
            field_key,
            label,
            field_type,
            options,
            is_active,
            created_by,
            created_date,
            updated_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedKey,
          String(label).trim(),
          field_type,
          options ? stringifyJsonSafely(options, '[]') : null,
          is_active ? 1 : 0,
          req.currentUser.email,
          new Date().toISOString(),
          new Date().toISOString()
        );

        const created = db.prepare(`
          SELECT * FROM customfieldconfig WHERE id = ?
        `).get(info.lastInsertRowid);

        res.json(created);
      } catch (error) {
        console.error('Create custom field error:', error);
        res.status(500).json({ error: 'Failed to create custom field' });
      }
    }
  );

  router.put(
    '/api/custom-fields/:id',
    requireAuth,
    requirePermission('can_access_settings'),
    (req, res) => {
      const { id } = req.params;
      const {
        label,
        field_type,
        options,
        is_active,
      } = req.body || {};

      try {
        const existing = db.prepare(`SELECT * FROM customfieldconfig WHERE id = ?`).get(id);

        if (!existing) {
          return res.status(404).json({ error: 'Custom field not found' });
        }

        const updates = {
          label: label !== undefined ? String(label).trim() : existing.label,
          field_type: field_type !== undefined ? field_type : existing.field_type,
          options: options !== undefined ? (options ? stringifyJsonSafely(options, '[]') : null) : existing.options,
          is_active: is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
          updated_date: new Date().toISOString(),
        };

        if (!updates.label) {
          return res.status(400).json({ error: 'Label is required' });
        }

        if (!['text', 'select', 'number', 'date'].includes(updates.field_type)) {
          return res.status(400).json({ error: 'Invalid field type' });
        }

        db.prepare(`
          UPDATE customfieldconfig
          SET label = ?, field_type = ?, options = ?, is_active = ?, updated_date = ?
          WHERE id = ?
        `).run(
          updates.label,
          updates.field_type,
          updates.options,
          updates.is_active,
          updates.updated_date,
          id
        );

        const updated = db.prepare(`SELECT * FROM customfieldconfig WHERE id = ?`).get(id);
        res.json(updated);
      } catch (error) {
        console.error('Update custom field error:', error);
        res.status(500).json({ error: 'Failed to update custom field' });
      }
    }
  );

  router.delete(
    '/api/custom-fields/:id',
    requireAuth,
    requirePermission('can_access_settings'),
    (req, res) => {
      const { id } = req.params;

      try {
        const existing = db.prepare(`SELECT * FROM customfieldconfig WHERE id = ?`).get(id);

        if (!existing) {
          return res.status(404).json({ error: 'Custom field not found' });
        }

        db.prepare(`DELETE FROM customfieldconfig WHERE id = ?`).run(id);

        res.json({ success: true });
      } catch (error) {
        console.error('Delete custom field error:', error);
        res.status(500).json({ error: 'Failed to delete custom field' });
      }
    }
  );

  // ==================== RECORD HISTORY ROUTE ====================
  router.get(
    '/api/datarecord/:id/history',
    requireAuth,
    requirePermission('can_access_records', 'can_access_customer_search'),
    (req, res) => {
      const { id } = req.params;

      try {
        const record = db.prepare(`
          SELECT id, customer_number, customer_name
          FROM datarecord
          WHERE id = ?
        `).get(id);

        if (!record) {
          return res.status(404).json({ error: 'Record not found' });
        }

        const history = db.prepare(`
          SELECT
            id,
            action_type,
            user_email,
            user_name,
            resource_id,
            resource_name,
            action_details,
            changes,
            status,
            created_date
          FROM auditlog
          WHERE resource_type = 'record'
            AND resource_id = ?
          ORDER BY datetime(created_date) DESC
          LIMIT 50
        `).all(String(id));

        res.json(history);
      } catch (error) {
        console.error('Record history error:', error);
        res.status(500).json({ error: 'Failed to load record history' });
      }
    }
  );

  // ==================== TEST RULE ====================

  // POST /api/test-rule
  // Accepts { conditions, sample_size } and runs the rule logic against real records.
  // Returns up to sample_size records (default 5) that matched, plus up to sample_size that didn't.
  router.post('/api/test-rule', requireAuth, (req, res) => {
    try {
      const { conditions: rawConditions, sample_size = 5 } = req.body;
      let conditions = rawConditions;
      if (typeof conditions === 'string') { try { conditions = JSON.parse(conditions); } catch { conditions = []; } }
      if (!Array.isArray(conditions) || conditions.length === 0) {
        return res.status(400).json({ error: 'No conditions provided' });
      }

      // Fetch a reasonably large sample to find matches and non-matches
      const rows = db.prepare(
        `SELECT customer_number, customer_name, outstanding_balance,
                unpaid_invoices, receipts, updated_date, created_date,
                age_analysis, flag_color, flag_reason, flag_source,
                auto_flagged, terms, note, synced_at
         FROM datarecord ORDER BY RANDOM() LIMIT 200`
      ).all().map(expandDataRecord);

      function evalCondition(cond, record) {
        const raw = record[cond.field];
        const ct = cond.condition_type;
        if (ct === 'is_empty') return raw === null || raw === undefined || String(raw).trim() === '';
        if (ct === 'is_not_empty') return raw !== null && raw !== undefined && String(raw).trim() !== '';
        if (['contains','equals','starts_with','ends_with'].includes(ct)) {
          const val = String(raw ?? '').toLowerCase();
          const cmp = String(cond.condition_value ?? '').toLowerCase();
          if (ct === 'contains') return val.includes(cmp);
          if (ct === 'equals') return val === cmp;
          if (ct === 'starts_with') return val.startsWith(cmp);
          if (ct === 'ends_with') return val.endsWith(cmp);
        }
        if (['greater_than','less_than','greater_or_equal','less_or_equal','range_between'].includes(ct)) {
          const num = parseFloat(String(raw ?? '').replace(/,/g, '').replace(/\s/g, ''));
          if (isNaN(num)) return false;
          const t = parseFloat(cond.condition_value);
          if (ct === 'greater_than') return num > t;
          if (ct === 'less_than') return num < t;
          if (ct === 'greater_or_equal') return num >= t;
          if (ct === 'less_or_equal') return num <= t;
          if (ct === 'range_between') return num >= t && num <= parseFloat(cond.condition_value_secondary);
        }
        if (['date_older_than','date_newer_than','before_date','after_date'].includes(ct)) {
          if (!raw) return false;
          let _ds = String(raw).trim();
          if (/^\d{8}$/.test(_ds)) _ds = `${_ds.slice(0,4)}-${_ds.slice(4,6)}-${_ds.slice(6,8)}`;
          const d = new Date(_ds);
          if (isNaN(d.getTime())) return false;
          const now = new Date();
          if (ct === 'date_older_than') return (now - d) / 86400000 > parseFloat(cond.condition_value);
          if (ct === 'date_newer_than') return (now - d) / 86400000 < parseFloat(cond.condition_value);
          if (ct === 'before_date') return d < new Date(cond.condition_value);
          if (ct === 'after_date') return d > new Date(cond.condition_value);
        }
        return false;
      }

      function evalAll(conditions, record) {
        let result = evalCondition(conditions[0], record);
        for (let i = 1; i < conditions.length; i++) {
          const op = (conditions[i].operator || 'AND').toUpperCase();
          const val = evalCondition(conditions[i], record);
          result = op === 'OR' ? result || val : result && val;
        }
        return result;
      }

      const matched = [];
      const unmatched = [];
      const limit = Math.min(parseInt(sample_size) || 5, 20);

      for (const row of rows) {
        // Per-condition results for display
        const condResults = conditions.map(c => ({
          field: c.field,
          passed: evalCondition(c, row),
          operator: c.operator,
        }));
        const passes = evalAll(conditions, row);
        const entry = {
          customer_number: row.customer_number,
          customer_name: row.customer_name,
          outstanding_balance: row.outstanding_balance,
          last_unpaid_invoice_1_date: row.last_unpaid_invoice_1_date,
          last_receipt_1_date: row.last_receipt_1_date,
          updated_date: row.updated_date,
          age_analysis: row.age_analysis,
          flag_color: row.flag_color,
          passes,
          condition_results: condResults,
        };
        if (passes && matched.length < limit) matched.push(entry);
        else if (!passes && unmatched.length < limit) unmatched.push(entry);
        if (matched.length >= limit && unmatched.length >= limit) break;
      }

      res.json({ matched, unmatched, total_sampled: rows.length });
    } catch (err) {
      console.error('test-rule error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== AUTO-FLAG ROUTES ====================

  router.post('/api/apply-auto-flags', requireAuth, (req, res) => {
    try {
      const rules = stmts.activeAutoFlagRules.all();
      const activeRules = rules.map(r => {
        try { r.conditions = JSON.parse(r.conditions || '[]'); } catch { r.conditions = []; }
        return r;
      });
      if (activeRules.length === 0) return res.json({ flagged: 0, cleared: 0 });

      const records = stmts.autoRecordsForFlags.all().map(expandDataRecord);
      let flagged = 0, cleared = 0;

      const updateFlag = stmts.updateAutoFlag;
      const clearFlag = stmts.clearAutoFlag;

      const applyAll = db.transaction(() => {
        for (const record of records) {
          const manuallyFlagged = record.flag_color && !record.auto_flagged && record.flag_created_by;
          if (manuallyFlagged) continue;

          const autoFlag = applyAutoFlagRulesToRecord(record, activeRules);
          if (autoFlag) {
            updateFlag.run(autoFlag.flag_color, autoFlag.flag_reason, record.id);
            flagged++;
          } else if (record.auto_flagged) {
            clearFlag.run(record.id);
            cleared++;
          }
        }
      });
      applyAll();
      res.json({ flagged, cleared });
    } catch (err) {
      console.error('apply-auto-flags error:', err);
      res.status(500).json({ error: err.message });
    }
  });


  router.post('/api/clear-auto-flags', requireAuth, (req, res) => {
    try {
      const result = stmts.clearAllAutoFlags.run();
      res.json({ cleared: result.changes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // ─── Auto-Flag Rules Export / Import ─────────────────────────────────────────

  router.get('/api/autoflagrule/export', requireAuth, requireAdmin, (req, res) => {
    try {
      const rules = db.prepare(`SELECT rule_name, priority, conditions, flag_color, is_active FROM autoflagrule ORDER BY priority DESC`).all();
      const exportData = rules.map(r => ({
        name: r.rule_name,
        priority: r.priority,
        color: r.flag_color,
        is_active: r.is_active,
        conditions: (() => { try { return JSON.parse(r.conditions); } catch { return r.conditions; } })()
      }));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="cardoso-rules-export.json"');
      res.json(exportData);
    } catch (err) {
      console.error('[export error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/autoflagrule/import', requireAuth, requireAdmin, (req, res) => {
    try {
      const rules = req.body;
      if (!Array.isArray(rules)) return res.status(400).json({ error: 'Expected array of rules' });

      let created = 0, updated = 0, skipped = 0;
      const upsert = db.transaction(() => {
        for (const rule of rules) {
          if (!rule.name || !rule.conditions) { skipped++; continue; }
          const ruleColor = rule.color ?? rule.flag_color ?? 'red';
          const condStr = typeof rule.conditions === 'string' ? rule.conditions : JSON.stringify(rule.conditions);
          const existing = db.prepare(`SELECT id FROM autoflagrule WHERE rule_name = ?`).get(rule.name);
          if (existing) {
            db.prepare(`UPDATE autoflagrule SET priority = ?, conditions = ?, flag_color = ?, is_active = ? WHERE id = ?`)
              .run(rule.priority ?? 1, condStr, ruleColor, rule.is_active ?? 1, existing.id);
            updated++;
          } else {
            db.prepare(`INSERT INTO autoflagrule (rule_name, priority, conditions, flag_color, is_active) VALUES (?, ?, ?, ?, ?)`)
              .run(rule.name, rule.priority ?? 1, condStr, ruleColor, rule.is_active ?? 1);
            created++;
          }
        }
      });
      upsert();
      res.json({ created, updated, skipped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== RECORD SEARCH / AGGREGATES ====================

  router.get(
    '/api/datarecord/customer-lookup',
    requireAuth,
    requirePermission('can_access_records', 'can_access_customer_search'),
    (req, res) => {
      try {
        const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';

        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }

        const record = db.prepare(`
          SELECT *
          FROM datarecord
          WHERE customer_number = ?
             OR lower(customer_name) = lower(?)
          ORDER BY
            CASE
              WHEN customer_number = ? THEN 0
              WHEN lower(customer_name) = lower(?) THEN 1
              ELSE 2
            END,
            id DESC
          LIMIT 1
        `).get(query, query, query, query);

        if (!record) {
          return res.status(404).json({ error: 'Customer not found' });
        }

        const expandedRecord = expandDataRecord(record);
        const customerNumber = String(expandedRecord.customer_number || '').trim();
        const isParent = /^\d+$/.test(customerNumber);

        let subAccounts = [];
        if (isParent) {
          const prefixMatches = db.prepare(`
            SELECT *
            FROM datarecord
            WHERE customer_number LIKE ?
              AND customer_number != ?
            ORDER BY customer_number ASC, id ASC
          `).all(`${customerNumber}%`, customerNumber);

          subAccounts = prefixMatches
            .map(expandDataRecord)
            .filter((row) => {
              const childNumber = String(row.customer_number || '').trim();
              const match = childNumber.match(/^(\d+)/);
              return match && match[1] === customerNumber;
            });
        }

        res.json({
          record: expandedRecord,
          subAccounts,
        });
      } catch (error) {
        console.error('Customer lookup error:', error);
        res.status(500).json({ error: 'Failed to lookup customer' });
      }
    }
  );

  router.get(
    '/api/datarecord/customer-lookup/suggestions',
    requireAuth,
    requirePermission('can_access_records', 'can_access_customer_search'),
    (req, res) => {
      try {
        const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);

        if (!query) {
          return res.json({ suggestions: [] });
        }

        const startsWith = `${query}%`;
        const contains = `%${query}%`;
        const rows = db.prepare(`
          SELECT *
          FROM datarecord
          WHERE customer_number LIKE ?
             OR customer_name LIKE ?
             OR customer_number LIKE ?
             OR customer_name LIKE ?
          ORDER BY
            CASE
              WHEN customer_number = ? THEN 0
              WHEN lower(customer_name) = lower(?) THEN 1
              WHEN customer_number LIKE ? THEN 2
              WHEN customer_name LIKE ? THEN 3
              ELSE 4
            END,
            length(customer_number) ASC,
            length(customer_name) ASC,
            customer_name ASC,
            customer_number ASC,
            id DESC
          LIMIT ?
        `).all(startsWith, startsWith, contains, contains, query, query, startsWith, startsWith, limit);

        res.json({
          suggestions: rows.map((row) => expandDataRecord(row)),
        });
      } catch (error) {
        console.error('Customer lookup suggestions error:', error);
        res.status(500).json({ error: 'Failed to load customer lookup suggestions' });
      }
    }
  );

  router.get(
    '/api/datarecord/search',
    requireAuth,
    requirePermission('can_access_records', 'can_access_customer_search'),
    (req, res) => {
      try {
        const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const flagColor = typeof req.query.flag_color === 'string' ? req.query.flag_color.trim() : '';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 250);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const whereParts = [];
        const params = [];

        if (flagColor && flagColor !== 'all') {
          if (flagColor === 'none') {
            whereParts.push(`COALESCE(flag_color, 'none') = 'none'`);
          } else {
            whereParts.push('flag_color = ?');
            params.push(flagColor);
          }
        }

        if (rawSearch) {
          whereParts.push(`(
            customer_number LIKE ? OR
            customer_name LIKE ? OR
            source_id LIKE ? OR
            source_table LIKE ? OR
            data LIKE ?
          )`);
          const like = `%${rawSearch}%`;
          params.push(like, like, like, like, like);
        }

        const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
        const countRow = db.prepare(`SELECT COUNT(*) AS total FROM datarecord ${whereClause}`).get(...params);
        const rows = db.prepare(`
          SELECT *
          FROM datarecord
          ${whereClause}
          ORDER BY datetime(updated_date) DESC, id DESC
          LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        res.json({
          records: rows.map(expandDataRecord),
          total: countRow?.total ?? 0,
          limit,
          offset,
          has_more: offset + rows.length < (countRow?.total ?? 0),
        });
      } catch (error) {
        console.error('Search records error:', error);
        res.status(500).json({ error: 'Failed to search records' });
      }
    }
  );

  router.get(
    '/api/datarecord/flag-counts',
    requireAuth,
    requirePermission('can_access_customer_search'),
    (req, res) => {
      try {
        const rows = db.prepare(`
          SELECT COALESCE(flag_color, 'none') AS flag_color, COUNT(*) AS count
          FROM datarecord
          GROUP BY COALESCE(flag_color, 'none')
        `).all();

        const counts = { none: 0, red: 0, orange: 0, green: 0 };
        for (const row of rows) {
          if (row.flag_color in counts) counts[row.flag_color] = row.count;
        }

        res.json({ records_by_flag: counts, total_records: Object.values(counts).reduce((sum, value) => sum + value, 0) });
      } catch (error) {
        console.error('Record flag counts error:', error);
        res.status(500).json({ error: 'Failed to load record flag counts' });
      }
    }
  );

  // ==================== DYNAMIC CRUD ROUTES ====================

  router.get('/api/:table', requireAuth, (req, res) => {
    const { table } = req.params;

    if (!isValidTableName(table)) {
      return res.status(404).json({ error: `Table "${table}" not found` });
    }

    const access = checkTableAccess(req, table, 'GET');
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (table === 'user') {
      return res.status(403).json({ error: 'Restricted table' });
    }

    try {
      const validCols = getTableColumns(table);

      // Optional exact-match filters via ?filter_column=value
      const filterEntries = Object.entries(req.query)
        .filter(([key, value]) => key.startsWith('filter_') && value !== undefined && value !== null && String(value) !== '')
        .map(([key, value]) => [key.slice('filter_'.length), value]);

      const whereParts = [];
      const params = [];
      for (const [column, value] of filterEntries) {
        if (!validCols.has(column)) continue;
        whereParts.push(`"${column}" = ?`);
        params.push(String(value));
      }

      const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';

      // Optional sort: ?sort=priority (asc) or ?sort=-priority (desc)
      const sortParam = req.query.sort;
      let orderClause = '';
      if (sortParam) {
        const desc = sortParam.startsWith('-');
        const col = desc ? sortParam.slice(1) : sortParam;
        if (validCols.has(col)) {
          orderClause = ` ORDER BY "${col}" ${desc ? 'DESC' : 'ASC'}`;
        }
      }

      const rawLimit = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 5000) : null;
      const limitClause = limit ? ` LIMIT ${limit}` : '';

      const stmt = db.prepare(`SELECT * FROM "${table}"${whereClause}${orderClause}${limitClause}`);
      const rows = stmt.all(...params);
      let output = table === 'datarecord' ? rows.map(expandDataRecord) : rows;
      if (table === 'databaseconnection') output = output.map(sanitizeConnection);
      res.json(output);
    } catch {
      res.status(404).json({ error: `Table "${table}" not found` });
    }
  });

  router.get('/api/:table/:id', requireAuth, (req, res) => {
    const { table, id } = req.params;

    if (!isValidTableName(table)) {
      return res.status(404).json({ error: `Table "${table}" not found` });
    }

    const access = checkTableAccess(req, table, 'GET');
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (table === 'user') {
      return res.status(403).json({ error: 'Restricted table' });
    }

    try {
      const stmt = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`);
      const row = stmt.get(id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      let output = table === 'datarecord' ? expandDataRecord(row) : row;
      if (table === 'databaseconnection') output = sanitizeConnection(output);
      res.json(output);
    } catch {
      res.status(404).json({ error: `Table "${table}" not found` });
    }
  });

  router.post('/api/:table', requireAuth, (req, res) => {
    const { table } = req.params;

    if (!isValidTableName(table)) {
      return res.status(404).json({ error: `Table "${table}" not found` });
    }

    const access = checkTableAccess(req, table, 'POST');
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (table === 'user' || table === 'syncrun') {
      return res.status(403).json({ error: 'Direct create not allowed for this table' });
    }

    const data = sanitizeForSqlite(req.body);

    // Serialize JSON fields that must be stored as strings
    if (table === 'autoflagrule' && data.conditions !== undefined && typeof data.conditions !== 'string') {
      data.conditions = JSON.stringify(data.conditions);
    }

    if (table === 'databaseconnection' && data.status !== undefined) {
      const allowedStatuses = new Set(['active', 'inactive', 'error', 'testing']);
      if (!allowedStatuses.has(data.status)) {
        return res.status(400).json({ error: `Invalid status: ${data.status}` });
      }
    }

    // Encrypt MSSQL password before storing
    if (table === 'databaseconnection' && data.encrypted_password) {
      if (process.env.NODE_ENV === 'production' && !getEncryptionKey()) {
        return res.status(503).json({ error: 'ENCRYPTION_KEY must be configured before storing MSSQL credentials in production' });
      }
      data.encrypted_password = encryptPassword(data.encrypted_password);
    }

    // Serialize conditions array for autoflagrule
    if (table === 'autoflagrule' && data.conditions !== undefined && typeof data.conditions !== 'string') {
      data.conditions = JSON.stringify(data.conditions);
    }

    try {
      const columns = Object.keys(data);
      if (columns.length === 0) {
        return res.status(400).json({ error: 'No data provided' });
      }

      // Validate column names against actual schema to prevent injection
      const validColumns = getTableColumns(table);
      const invalidCols = columns.filter((k) => !validColumns.has(k));
      if (invalidCols.length > 0) {
        return res.status(400).json({ error: `Invalid fields: ${invalidCols.join(', ')}` });
      }

      const placeholders = columns.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT INTO "${table}" (${columns.join(',')}) VALUES (${placeholders})`);
      const info = stmt.run(...Object.values(data));
      res.json({ id: info.lastInsertRowid, ...data });
    } catch (e) {
      console.error('POST error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/api/:table/:id', requireAuth, (req, res) => {
    const { table, id } = req.params;

    if (!isValidTableName(table)) {
      return res.status(404).json({ error: `Table "${table}" not found` });
    }

    const access = checkTableAccess(req, table, 'PUT');
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (table === 'user' || table === 'syncrun') {
      return res.status(403).json({ error: 'Use dedicated routes instead' });
    }

    let data = sanitizeForSqlite(req.body);

    if (table === 'databaseconnection' && data.status !== undefined) {
      const allowedStatuses = new Set(['active', 'inactive', 'error', 'testing']);
      if (!allowedStatuses.has(data.status)) {
        return res.status(400).json({ error: `Invalid status: ${data.status}` });
      }
    }

    // Encrypt MSSQL password before storing
    if (table === 'databaseconnection' && data.encrypted_password) {
      if (process.env.NODE_ENV === 'production' && !getEncryptionKey()) {
        return res.status(503).json({ error: 'ENCRYPTION_KEY must be configured before storing MSSQL credentials in production' });
      }
      data.encrypted_password = encryptPassword(data.encrypted_password);
    }

    // Serialize conditions array for autoflagrule
    if (table === 'autoflagrule' && data.conditions !== undefined && typeof data.conditions !== 'string') {
      data.conditions = JSON.stringify(data.conditions);
    }

    try {
      const existing = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id);

      if (!existing) {
        return res.status(404).json({ error: 'Record not found' });
      }

      let flagChanged = false;
      let oldFlagColor = null;
      let oldFlagReason = null;
      let newFlagColor = null;
      let newFlagReason = null;

      if (table === 'datarecord') {
        oldFlagColor = existing.flag_color ?? null;
        oldFlagReason = existing.flag_reason ?? null;

        newFlagColor = data.flag_color !== undefined ? data.flag_color : oldFlagColor;
        newFlagReason = data.flag_reason !== undefined ? data.flag_reason : oldFlagReason;

        flagChanged = oldFlagColor !== newFlagColor || oldFlagReason !== newFlagReason;

        if (flagChanged) {
          data.flag_created_by = req.currentUser.email;
        }

        if (data.local_fields !== undefined) {
          data.local_fields = stringifyJsonSafely(
            typeof data.local_fields === 'string' ? parseJsonSafely(data.local_fields, {}) : data.local_fields,
            '{}'
          );
        }
      }

      // Sanitize booleans/undefined to SQLite-compatible types
      data = sanitizeForSqlite(data);

      const keys = Object.keys(data);
      if (keys.length === 0) {
        return res.status(400).json({ error: 'No data provided' });
      }

      // Validate column names against actual schema to prevent injection
      const validColumns = getTableColumns(table);
      const invalidKeys = keys.filter((k) => !validColumns.has(k));
      if (invalidKeys.length > 0) {
        return res.status(400).json({ error: `Invalid fields: ${invalidKeys.join(', ')}` });
      }

      const sets = keys.map((k) => `${k} = ?`).join(',');
      const stmt = db.prepare(`UPDATE "${table}" SET ${sets} WHERE id = ?`);
      stmt.run(...Object.values(data), id);

      if (table === 'datarecord' && flagChanged) {
        const beforeColorLabel = oldFlagColor || 'none';
        const afterColorLabel = newFlagColor || 'none';
        const beforeReasonLabel = oldFlagReason || '';
        const afterReasonLabel = newFlagReason || '';

        let actionDetails = `Flag changed from ${beforeColorLabel} to ${afterColorLabel}`;

        if (beforeReasonLabel !== afterReasonLabel) {
          if (!beforeReasonLabel && afterReasonLabel) {
            actionDetails += `; reason added: "${afterReasonLabel}"`;
          } else if (beforeReasonLabel && !afterReasonLabel) {
            actionDetails += '; reason cleared';
          } else {
            actionDetails += `; reason changed from "${beforeReasonLabel}" to "${afterReasonLabel}"`;
          }
        }

        db.prepare(`
          INSERT INTO auditlog (
            action_type,
            user_email,
            user_name,
            resource_type,
            resource_id,
            resource_name,
            action_details,
            changes,
            ip_address,
            status,
            created_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'update_flag',
          req.currentUser.email,
          req.currentUser.full_name || '',
          'record',
          String(id),
          existing.customer_number || existing.customer_name || `Record ${id}`,
          actionDetails,
          JSON.stringify({
            field_changes: {
              flag_color: {
                from: oldFlagColor,
                to: newFlagColor,
              },
              flag_reason: {
                from: oldFlagReason,
                to: newFlagReason,
              },
              flag_created_by: {
                from: existing.flag_created_by ?? null,
                to: data.flag_created_by ?? existing.flag_created_by ?? null,
              },
            },
            summary: {
              changed_by: req.currentUser.email,
              changed_at: new Date().toISOString(),
              previous_flag: oldFlagColor,
              new_flag: newFlagColor,
              previous_reason: oldFlagReason,
              new_reason: newFlagReason,
            },
          }),
          req.ip || '',
          'success',
          new Date().toISOString()
        );
      }

      res.json({ success: true });
    } catch (e) {
      console.error('PUT error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/api/:table/:id', requireAuth, (req, res) => {
    const { table, id } = req.params;

    if (!isValidTableName(table)) {
      return res.status(404).json({ error: `Table "${table}" not found` });
    }

    const access = checkTableAccess(req, table, 'DELETE');
    if (!access.ok) {
      return res.status(access.status).json({ error: access.error });
    }

    if (table === 'user' || table === 'syncrun') {
      return res.status(403).json({ error: 'Use dedicated routes instead' });
    }

    try {
      const stmt = db.prepare(`DELETE FROM "${table}" WHERE id = ?`);
      stmt.run(id);
      res.json({ success: true });
    } catch (e) {
      console.error('DELETE error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
