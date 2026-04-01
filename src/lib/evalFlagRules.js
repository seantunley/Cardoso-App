/**
 * Evaluate a single auto-flag rule condition against a full record object.
 * record: the full datarecord row (flat, with all fields)
 */
export function evaluateCondition(condition, record) {
  const { field, condition_type, condition_value, condition_value_secondary } = condition;
  const raw = record[field];

  // is_empty / is_not_empty work for all types
  if (condition_type === "is_empty") {
    return raw === null || raw === undefined || String(raw).trim() === "";
  }
  if (condition_type === "is_not_empty") {
    return raw !== null && raw !== undefined && String(raw).trim() !== "";
  }

  // --- TEXT conditions (age_analysis etc.) ---
  if (["contains","equals","starts_with","ends_with"].includes(condition_type)) {
    const val = String(raw ?? "").toLowerCase();
    const cmp = String(condition_value ?? "").toLowerCase();
    switch (condition_type) {
      case "contains":    return val.includes(cmp);
      case "equals":      return val === cmp;
      case "starts_with": return val.startsWith(cmp);
      case "ends_with":   return val.endsWith(cmp);
    }
  }

  // --- NUMBER conditions ---
  if (["greater_than","less_than","greater_or_equal","less_or_equal","range_between"].includes(condition_type)) {
    const num = parseFloat(String(raw ?? "").replace(/,/g, ""));
    const threshold = parseFloat(condition_value);
    if (isNaN(num)) return false;
    switch (condition_type) {
      case "greater_than":    return num > threshold;
      case "less_than":       return num < threshold;
      case "greater_or_equal":return num >= threshold;
      case "less_or_equal":   return num <= threshold;
      case "range_between": {
        const lo = parseFloat(condition_value);
        const hi = parseFloat(condition_value_secondary);
        return num >= lo && num <= hi;
      }
    }
  }

  // --- DATE conditions ---
  if (["date_older_than","date_newer_than","before_date","after_date"].includes(condition_type)) {
    if (!raw) return false;
    const recordDate = new Date(raw);
    if (isNaN(recordDate.getTime())) return false;
    const now = new Date();
    switch (condition_type) {
      case "date_older_than": {
        const days = parseFloat(condition_value);
        return (now - recordDate) / 86400000 > days;
      }
      case "date_newer_than": {
        const days = parseFloat(condition_value);
        return (now - recordDate) / 86400000 < days;
      }
      case "before_date": {
        const d = new Date(condition_value);
        return recordDate < d;
      }
      case "after_date": {
        const d = new Date(condition_value);
        return recordDate > d;
      }
    }
  }

  return false;
}

/**
 * Check all active auto-flag rules against a full record.
 * Returns { flag_color, flag_reason, auto_flagged } or null.
 */
export function checkAutoFlagRules(record, rules) {
  for (const rule of rules) {
    let conditions = rule.conditions;
    if (typeof conditions === "string") {
      try { conditions = JSON.parse(conditions); } catch { conditions = []; }
    }
    if (!Array.isArray(conditions) || conditions.length === 0) continue;

    const logic = rule.logic || "AND";
    const results = conditions.map(c => evaluateCondition(c, record));
    const matches = logic === "OR" ? results.some(Boolean) : results.every(Boolean);
    if (matches) return {
      flag_color: rule.flag_color,
      flag_reason: `Auto-flagged: ${rule.rule_name}`,
      auto_flagged: true,
    };
  }
  return null;
}
