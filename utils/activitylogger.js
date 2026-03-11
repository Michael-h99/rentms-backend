// activityLogger.js
const db = require("./db");

// ── Valid action types ───────────────────────────────────────
// Allowlist prevents garbage data in activity_logs table.
// Matches schema: activity_logs.action VARCHAR(255)
const VALID_ACTIONS = [
  // Auth
  "login",
  "logout",
  "register",
  "password_reset",
  "password_change",
  "token_refresh",
  "admin_login",

  // User management
  "user_created",
  "user_updated",
  "user_deleted",
  "user_suspended",
  "user_activated",
  "role_updated",
  "status_updated",
  "avatar_uploaded",

  // Plaza
  "plaza_created",
  "plaza_updated",
  "plaza_deleted",

  // Tenancy
  "tenancy_created",
  "tenancy_updated",
  "tenancy_expired",
  "tenancy_terminated",
  "tenant_invited",
  "tenant_removed",

  // Invite codes
  "invite_code_created",
  "invite_code_used",
  "invite_code_revoked",
  "invite_code_expired",

  // Payments
  "payment_created",
  "payment_verified",
  "payment_failed",
  "payment_status_updated",
  "receipt_generated",
  "late_fee_applied",

  // Maintenance
  "maintenance_created",
  "maintenance_updated",
  "maintenance_status_updated",
  "maintenance_resolved",

  // Messages
  "message_sent",

  // Notifications
  "notification_sent",
  "notification_read",
  "notification_cleared",

  // Admin
  "admin_action",
  "settings_updated",
  "system_backup",
  "permissions_updated",
];

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

// ── logActivity ──────────────────────────────────────────────
// Insert a record into activity_logs.
// Non-fatal — errors are logged but never propagate.
// Activity logging must never break the main request flow.
//
// Column mapping to rentms_full_schema.sql activity_logs:
//   user_id, action, description, ip_address, user_agent, created_at
//
// @param {number} userId      — ID of the user performing the action
// @param {string} action      — Action type from VALID_ACTIONS
// @param {string} description — Human-readable description
// @param {object} options
//   ip         — IP address (req.ip)
//   userAgent  — Browser/client string (req.headers["user-agent"])
//   connection — Active DB connection for use inside a transaction
//
// Usage:
//   await logActivity(req.user.id, "login", "User logged in", { ip: req.ip });
//   await logActivity(userId, "payment_created", `Payment GHS ${amount}`, { connection });
const logActivity = async (
  userId,
  action,
  description,
  { ip = null, userAgent = null, connection = null } = {},
) => {
  const uid = parseId(userId);
  if (!uid) {
    console.warn("⚠️  logActivity: invalid userId —", userId);
    return;
  }

  if (!action || !VALID_ACTIONS.includes(action)) {
    console.warn(`⚠️  logActivity: invalid action "${action}" — skipping`);
    return;
  }

  if (
    !description ||
    typeof description !== "string" ||
    description.trim().length === 0
  ) {
    console.warn("⚠️  logActivity: description is required — skipping");
    return;
  }

  try {
    const executor = connection || db;
    await executor.execute(
      `INSERT INTO activity_logs
         (user_id, action, description, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        uid,
        action,
        description.trim(),
        ip || null,
        userAgent ? userAgent.slice(0, 500) : null,
      ],
    );
  } catch (err) {
    console.error("❌ Activity log failed:", err.message);
  }
};

// ── logAuthActivity ──────────────────────────────────────────
// Convenience wrapper for auth events.
// Automatically extracts IP and user-agent from request.
//
// Usage:
//   await logAuthActivity(req, userId, "login", "User logged in");
const logAuthActivity = async (req, userId, action, description) => {
  return logActivity(userId, action, description, {
    ip: req?.ip || req?.headers?.["x-forwarded-for"] || null,
    userAgent: req?.headers?.["user-agent"] || null,
  });
};

// ── logAdminActivity ─────────────────────────────────────────
// Convenience wrapper for admin actions.
// Tags description with the target user/resource if provided.
//
// Usage:
//   await logAdminActivity(req, "user_suspended", "Suspended user ID 42", { targetId: 42 });
const logAdminActivity = async (
  req,
  action,
  description,
  { targetId = null, connection = null } = {},
) => {
  const adminId = req?.user?.id;
  if (!adminId) return;

  const fullDescription = targetId
    ? `${description} (target_id: ${targetId})`
    : description;

  return logActivity(adminId, action, fullDescription, {
    ip: req?.ip || req?.headers?.["x-forwarded-for"] || null,
    userAgent: req?.headers?.["user-agent"] || null,
    connection,
  });
};

// ── logSystemActivity ────────────────────────────────────────
// For automated/system-generated events with no user context.
// Uses a sentinel user_id of 0 — adjust if your schema requires NULL.
//
// Usage:
//   await logSystemActivity("invite_code_expired", "Expired 3 invite codes");
const logSystemActivity = async (action, description) => {
  if (!action || !VALID_ACTIONS.includes(action)) {
    console.warn(
      `⚠️  logSystemActivity: invalid action "${action}" — skipping`,
    );
    return;
  }
  if (!description || description.trim().length === 0) return;

  try {
    await db.execute(
      `INSERT INTO activity_logs
         (user_id, action, description, ip_address, created_at)
       VALUES (NULL, ?, ?, NULL, NOW())`,
      [action, description.trim()],
    );
  } catch (err) {
    console.error("❌ System activity log failed:", err.message);
  }
};

module.exports = {
  logActivity,
  logAuthActivity,
  logAdminActivity,
  logSystemActivity,
  VALID_ACTIONS,
};
