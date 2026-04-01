/**
 * Evaluate a single condition against a full record object.
 */
export function evaluateCondition(condition, record) {
  const { field, condition_type, condition_value, condition_value_secondary } = condition;
  const raw = record[field];

  if (condition_type === "is_empty") {
    return raw === null || raw === undefined || String(raw).trim() === "";
  }
  if (condition_type === "is_not_empty") {
    return raw !== null && raw !== undefined && String(raw).trim() !== "";
  }

  // TEXT
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

  // NUMBER
  if (["greater_than","less_than","greater_or_equal","less_or_equal","range_between"].includes(condition_type)) {
    const num = parseFloat(String(raw ?? "").replace(/,/g, ""));
    if (isNaN(num)) return false;
    const threshold = parseFloat(condition_value);
    switch (condition_type) {
      case "greater_than":     return num > threshold;
      case "less_than":        return num < threshold;
      case "greater_or_equal": return num >= threshold;
      case "less_or_equal":    return num <= threshold;
      case "range_between": {
        const lo = parseFloat(condition_value);
        const hi = parseFloat(condition_value_secondary);
        return num >= lo && num <= hi;
      }
    }
  }

  // DATE
  if (["date_older_than","date_newer_than","before_date","after_date"].includes(condition_type)) {
    if (!raw) return false;
    const recordDate = new Date(raw);
    if (isNaN(recordDate.getTime())) return false;
    const now = new Date();
    switch (condition_type) {
      case "date_older_than": return (now - recordDate) / 86400000 > parseFloat(condition_value);
      case "date_newer_than": return (now - recordDate) / 86400000 < parseFloat(condition_value);
      case "before_date":     return recordDate < new Date(condition_value);
      case "after_date":      return recordDate > new Date(condition_value);
    }
  }

  return false;
}

/**
 * Evaluate all conditions for a rule using group logic:
 *   - Conditions within the same group are AND'd together
 *   - Groups are OR'd against each other
 * 
 * Backward compatible: conditions without a `group` field default to group 1
 * (treated as a single AND group, same as the old AND logic).
 */
function evaluateRuleConditions(conditions, record) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;

  // Assign default group for legacy conditions
  const withGroups = conditions.map(c => ({ group: 1, ...c }));

  // Collect unique groups
  const groupNums = [...new Set(withGroups.map(c => c.group))];

  // Each group must ALL pass (AND); any group passing = rule matches (OR)
  return groupNums.some(g => {
    const groupConds = withGroups.filter(c => c.group === g);
    return groupConds.every(c => evaluateCondition(c, record));
  });
}

/**
 * Check all active auto-flag rules against a full record.
 * Returns { flag_color, flag_reason, auto_flagged } for the first matching rule, or null.
 */
export function checkAutoFlagRules(record, rules) {
  for (const rule of rules) {
    let conditions = rule.conditions;
    if (typeof conditions === "string") {
      try { conditions = JSON.parse(conditions); } catch { conditions = []; }
    }
    if (!Array.isArray(conditions) || conditions.length === 0) continue;

    if (evaluateRuleConditions(conditions, record)) {
      return {
        flag_color: rule.flag_color,
        flag_reason: `Auto-flagged: ${rule.rule_name}`,
        auto_flagged: true,
      };
    }
  }
  return null;
}
