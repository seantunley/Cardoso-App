// ── Auto-flag rule evaluator (mirrors src/lib/evalFlagRules.js) ────────
function _evalCondition(condition, record) {
  const { field, condition_type, condition_value, condition_value_secondary } = condition;
  const raw = record[field];

  if (condition_type === 'is_empty')     return raw === null || raw === undefined || String(raw).trim() === '';
  if (condition_type === 'is_not_empty') return raw !== null && raw !== undefined && String(raw).trim() !== '';

  if (['contains','equals','starts_with','ends_with'].includes(condition_type)) {
    const val = String(raw ?? '').toLowerCase();
    const cmp = String(condition_value ?? '').toLowerCase();
    if (condition_type === 'contains')    return val.includes(cmp);
    if (condition_type === 'equals')      return val === cmp;
    if (condition_type === 'starts_with') return val.startsWith(cmp);
    if (condition_type === 'ends_with')   return val.endsWith(cmp);
  }

  if (['greater_than','less_than','greater_or_equal','less_or_equal','range_between'].includes(condition_type)) {
    const num = parseFloat(String(raw ?? '').replace(/,/g, '').replace(/\s/g, ''));
    if (isNaN(num)) return false;
    const threshold = parseFloat(condition_value);
    if (condition_type === 'greater_than')     return num > threshold;
    if (condition_type === 'less_than')        return num < threshold;
    if (condition_type === 'greater_or_equal') return num >= threshold;
    if (condition_type === 'less_or_equal')    return num <= threshold;
    if (condition_type === 'range_between') {
      const hi = parseFloat(condition_value_secondary);
      return num >= threshold && num <= hi;
    }
  }

  if (['date_older_than','date_newer_than','before_date','after_date'].includes(condition_type)) {
    if (!raw) return false;
    let dateStr = String(raw).trim();
    if (/^\d{8}$/.test(dateStr)) dateStr = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
    const recordDate = new Date(dateStr);
    if (isNaN(recordDate.getTime())) return false;
    const now = new Date();
    if (condition_type === 'date_older_than') return (now - recordDate) / 86400000 > parseFloat(condition_value);
    if (condition_type === 'date_newer_than') return (now - recordDate) / 86400000 < parseFloat(condition_value);
    if (condition_type === 'before_date')     return recordDate < new Date(condition_value);
    if (condition_type === 'after_date')      return recordDate > new Date(condition_value);
  }

  return false;
}

function _evalRuleConditions(conditions, record) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  let result = _evalCondition(conditions[0], record);
  for (let i = 1; i < conditions.length; i++) {
    const op = (conditions[i].operator ?? 'AND').toUpperCase();
    const val = _evalCondition(conditions[i], record);
    result = op === 'OR' ? (result || val) : (result && val);
  }
  return result;
}

/**
 * Check active auto-flag rules against a record object.
 * Returns { flag_color, flag_reason, auto_flagged: 1 } or null.
 * Only applies if the record has NOT been manually flagged by a user.
 */
function applyAutoFlagRulesToRecord(record, activeRules) {
  // Never overwrite a manual flag (flag exists AND was set by a real user AND not auto-flagged)
  if (record.flag_color && record.flag_color !== 'none' && record.flag_created_by && !record.auto_flagged) return null;

  for (const rule of activeRules) {
    let conditions = rule.conditions;
    if (typeof conditions === 'string') { try { conditions = JSON.parse(conditions); } catch { conditions = []; } }
    if (!Array.isArray(conditions) || conditions.length === 0) continue;
    if (_evalRuleConditions(conditions, record)) {
      return { flag_color: rule.flag_color, flag_reason: `Auto-flagged: ${rule.rule_name}`, auto_flagged: 1 };
    }
  }
  return null;
}

export { _evalCondition, _evalRuleConditions, applyAutoFlagRulesToRecord };
