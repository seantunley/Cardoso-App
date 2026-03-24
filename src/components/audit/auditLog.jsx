import { api } from "@/api/apiClient";

/**
 * Logs an action to the audit log
 */
export async function logAction({
  actionType,
  resourceType,
  resourceId = null,
  resourceName = null,
  actionDetails = null,
  changes = null,
  status = "success",
  userEmail = null,
  userName = null,
}) {
  try {
    // Get current user if not provided
    let email = userEmail;
    let name = userName;

    if (!email || !name) {
      const currentUser = await api.auth.me();
      email = email || currentUser?.email;
      name = name || currentUser?.full_name;
    }

    // Create audit log entry
    await api.entities.AuditLog.create({
      action_type: actionType,
      resource_type: resourceType,
      resource_id: resourceId,
      resource_name: resourceName,
      action_details: actionDetails,
      changes: changes,
      user_email: email,
      user_name: name,
      status: status,
    });
  } catch (error) {
    console.error("Failed to log action:", error);
    // Don't throw - audit logging failures shouldn't break app functionality
  }
}

/**
 * Helper functions for common audit actions
 */

export async function logUserInvited(email, role, invitedBy) {
  await logAction({
    actionType: "user_invited",
    resourceType: "user",
    resourceName: email,
    actionDetails: `Invited ${email} as ${role}`,
    userEmail: invitedBy,
  });
}

export async function logPermissionsUpdated(userId, userName, changes, updatedBy) {
  await logAction({
    actionType: "user_permissions_updated",
    resourceType: "user",
    resourceId: userId,
    resourceName: userName,
    actionDetails: `Updated permissions for ${userName}`,
    changes: changes,
    userEmail: updatedBy,
  });
}

export async function logConnectionCreated(connectionName, createdBy) {
  await logAction({
    actionType: "connection_created",
    resourceType: "connection",
    resourceName: connectionName,
    actionDetails: `Created database connection: ${connectionName}`,
    userEmail: createdBy,
  });
}

export async function logConnectionUpdated(connectionName, changes, updatedBy) {
  await logAction({
    actionType: "connection_updated",
    resourceType: "connection",
    resourceName: connectionName,
    actionDetails: `Updated connection: ${connectionName}`,
    changes: changes,
    userEmail: updatedBy,
  });
}

export async function logConnectionDeleted(connectionName, deletedBy) {
  await logAction({
    actionType: "connection_deleted",
    resourceType: "connection",
    resourceName: connectionName,
    actionDetails: `Deleted connection: ${connectionName}`,
    userEmail: deletedBy,
  });
}

export async function logRecordFlagged(recordId, flagColor, reason, flaggedBy) {
  await logAction({
    actionType: "record_flagged",
    resourceType: "record",
    resourceId: recordId,
    actionDetails: `Flagged record with ${flagColor} flag: ${reason || "No reason provided"}`,
    userEmail: flaggedBy,
  });
}

export async function logRecordUnflagged(recordId, unflaggedBy) {
  await logAction({
    actionType: "record_unflagged",
    resourceType: "record",
    resourceId: recordId,
    actionDetails: "Removed flag from record",
    userEmail: unflaggedBy,
  });
}

export async function logRecordEdited(recordId, changes, editedBy) {
  await logAction({
    actionType: "record_edited",
    resourceType: "record",
    resourceId: recordId,
    actionDetails: "Edited record details",
    changes: changes,
    userEmail: editedBy,
  });
}

export async function logRuleCreated(ruleName, createdBy) {
  await logAction({
    actionType: "rule_created",
    resourceType: "rule",
    resourceName: ruleName,
    actionDetails: `Created auto-flag rule: ${ruleName}`,
    userEmail: createdBy,
  });
}

export async function logRuleUpdated(ruleName, changes, updatedBy) {
  await logAction({
    actionType: "rule_updated",
    resourceType: "rule",
    resourceName: ruleName,
    actionDetails: `Updated rule: ${ruleName}`,
    changes: changes,
    userEmail: updatedBy,
  });
}

export async function logRuleDeleted(ruleName, deletedBy) {
  await logAction({
    actionType: "rule_deleted",
    resourceType: "rule",
    resourceName: ruleName,
    actionDetails: `Deleted rule: ${ruleName}`,
    userEmail: deletedBy,
  });
}

export async function logRuleApplied(ruleCount, recordCount, appliedBy) {
  await logAction({
    actionType: "rule_applied",
    resourceType: "rule",
    actionDetails: `Applied ${ruleCount} rule(s) to ${recordCount} record(s)`,
    userEmail: appliedBy,
  });
}