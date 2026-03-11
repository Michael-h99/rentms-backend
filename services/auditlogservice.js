// services/auditLogService.js
// ============================================================
// Audit log service — all READ operations on activity_logs.
// Writing to activity_logs is done by activityLogger.js.
// This service is consumed by the admin audit-log page and
// the admin dashboard's recent activity feed.
//
// Import path from controllers (backend/controllers/):
//   const AuditLogService = require("../services/auditLogService");
//
// All utils live one level up from services/:
//   require("../utils/db")
//   require("../utils/errorHandler")   ← capital H
//   require("../utils/pagination")
//   require("../utils/formatDate")
// ============================================================

const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");
const { buildPaginationResponse } = require("../utils/pagination");
const { formatRelative, toISODate } = require("../utils/formatdate");

const DEFAULT_LIMIT = 20;

// ── Action categories ────────────────────────────────────────
// Mirrors VALID_ACTIONS in activityLogger.js.
// Used to group filter options in the admin audit-log UI.
const ACTION_CATEGORIES = {
  auth: [
    "login",
    "logout",
    "register",
    "password_reset",
    "password_change",
    "token_refresh",
    "admin_login",
  ],
  users: [
    "user_created",
    "user_updated",
    "user_deleted",
    "user_suspended",
    "user_activated",
    "role_updated",
    "status_updated",
    "avatar_uploaded",
  ],
  plazas: ["plaza_created", "plaza_updated", "plaza_deleted"],
  tenancies: [
    "tenancy_created",
    "tenancy_updated",
    "tenancy_expired",
    "tenancy_terminated",
    "tenant_invited",
    "tenant_removed",
  ],
  invites: [
    "invite_code_created",
    "invite_code_used",
    "invite_code_revoked",
    "invite_code_expired",
  ],
  payments: [
    "payment_created",
    "payment_verified",
    "payment_failed",
    "payment_status_updated",
    "receipt_generated",
    "late_fee_applied",
  ],
  maintenance: [
    "maintenance_created",
    "maintenance_updated",
    "maintenance_status_updated",
    "maintenance_resolved",
  ],
  messages: ["message_sent"],
  notifications: [
    "notification_sent",
    "notification_read",
    "notification_cleared",
  ],
  admin: [
    "admin_action",
    "settings_updated",
    "system_backup",
    "permissions_updated",
  ],
};

const ALL_ACTIONS = Object.values(ACTION_CATEGORIES).flat();

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// ── Helper: attach derived fields ───────────────────────────
const enrichRow = (row) => ({
  ...row,
  time_ago: formatRelative(row.created_at),
  category: AuditLogService.getActionCategory(row.action),
});

class AuditLogService {
  // ── getAll ─────────────────────────────────────────────
  // Paginated audit log with full filter support.
  //
  // Supported filters:
  //   userId    — show logs for one user
  //   action    — exact action name (e.g. "payment_created")
  //   category  — action group (e.g. "payments", "auth")
  //   search    — text search across description, ip_address,
  //               user full_name, user email
  //   dateFrom  — YYYY-MM-DD lower bound
  //   dateTo    — YYYY-MM-DD upper bound
  //   ipAddress — exact IP filter (security investigation)
  //
  // Usage:
  //   const result = await AuditLogService.getAll({
  //     category: "payments", dateFrom: "2026-01-01", page: 1
  //   });
  static async getAll({
    page = 1,
    limit = DEFAULT_LIMIT,
    userId = null,
    action = null,
    category = null,
    search = null,
    dateFrom = null,
    dateTo = null,
    ipAddress = null,
  } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = [];
    const params = [];

    if (userId && parseId(userId)) {
      conditions.push("a.user_id = ?");
      params.push(parseId(userId));
    }

    if (action && ALL_ACTIONS.includes(action)) {
      conditions.push("a.action = ?");
      params.push(action);
    }

    // category expands to IN (action1, action2, ...)
    if (category && ACTION_CATEGORIES[category]) {
      const acts = ACTION_CATEGORIES[category];
      conditions.push(`a.action IN (${acts.map(() => "?").join(", ")})`);
      params.push(...acts);
    }

    if (search) {
      conditions.push(
        "(a.description LIKE ? OR a.ip_address LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)",
      );
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    if (ipAddress) {
      conditions.push("a.ip_address = ?");
      params.push(ipAddress.trim());
    }

    if (dateFrom && !isNaN(new Date(dateFrom).getTime())) {
      conditions.push("DATE(a.created_at) >= ?");
      params.push(toISODate(new Date(dateFrom)));
    }

    if (dateTo && !isNaN(new Date(dateTo).getTime())) {
      conditions.push("DATE(a.created_at) <= ?");
      params.push(toISODate(new Date(dateTo)));
    }

    const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         a.id,
         a.user_id,
         a.action,
         a.description,
         a.ip_address,
         a.user_agent,
         a.created_at,
         u.full_name    AS user_name,
         u.email        AS user_email,
         u.role         AS user_role,
         u.avatar_url   AS user_avatar
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${WHERE}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows.map(enrichRow),
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── getByUser ──────────────────────────────────────────
  // All audit logs for a specific user, paginated.
  // Used on the admin user-detail page.
  //
  // Usage:
  //   const result = await AuditLogService.getByUser(userId, { page: 1 });
  static async getByUser(
    userId,
    { page = 1, limit = DEFAULT_LIMIT, action = null } = {},
  ) {
    const uid = parseId(userId);
    if (!uid) throw new AppError("Invalid user ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["a.user_id = ?"];
    const params = [uid];

    if (action && ALL_ACTIONS.includes(action)) {
      conditions.push("a.action = ?");
      params.push(action);
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM activity_logs a WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         a.id, a.action, a.description,
         a.ip_address, a.user_agent, a.created_at
       FROM activity_logs a
       WHERE ${WHERE}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows.map(enrichRow),
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── getById ────────────────────────────────────────────
  // Single audit log entry with full user context.
  static async getById(id) {
    const logId = parseId(id);
    if (!logId) throw new AppError("Invalid log ID", 400);

    const [rows] = await db.execute(
      `SELECT
         a.*,
         u.full_name AS user_name,
         u.email     AS user_email,
         u.role      AS user_role,
         u.avatar_url AS user_avatar
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`,
      [logId],
    );

    if (!rows.length) throw new AppError("Audit log entry not found", 404);
    return enrichRow(rows[0]);
  }

  // ── getRecentActivity ──────────────────────────────────
  // Last N system-wide actions for the admin dashboard feed.
  // Returns lightweight rows — no pagination needed here.
  //
  // Usage:
  //   const feed = await AuditLogService.getRecentActivity(10);
  static async getRecentActivity(limit = 10) {
    const safeLimit = Math.min(50, parseInt(limit, 10) || 10);

    const [rows] = await db.execute(
      `SELECT
         a.id, a.action, a.description, a.ip_address, a.created_at,
         u.full_name  AS user_name,
         u.email      AS user_email,
         u.role       AS user_role,
         u.avatar_url AS user_avatar
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT ?`,
      [safeLimit],
    );

    return rows.map(enrichRow);
  }

  // ── getSuspiciousActivity ──────────────────────────────
  // Detect two suspicious patterns within the last N hours:
  //   1. Multiple failed logins from the same IP
  //   2. Unusually high action volume from a single user
  //
  // Usage:
  //   const flags = await AuditLogService.getSuspiciousActivity({ hours: 24, threshold: 5 });
  static async getSuspiciousActivity({ hours = 24, threshold = 5 } = {}) {
    // IPs with repeated failed logins
    const [failedLogins] = await db.execute(
      `SELECT
         a.ip_address,
         COUNT(*)          AS attempt_count,
         MIN(a.created_at) AS first_attempt,
         MAX(a.created_at) AS last_attempt
       FROM activity_logs a
       WHERE a.action       = 'login'
         AND a.description  LIKE '%failed%'
         AND a.created_at  >= DATE_SUB(NOW(), INTERVAL ? HOUR)
         AND a.ip_address  IS NOT NULL
       GROUP BY a.ip_address
       HAVING attempt_count >= ?
       ORDER BY attempt_count DESC`,
      [hours, threshold],
    );

    // Users with abnormally high action count in the window
    const [highVolumeUsers] = await db.execute(
      `SELECT
         a.user_id,
         u.full_name  AS user_name,
         u.email      AS user_email,
         u.role       AS user_role,
         COUNT(*)          AS action_count,
         MIN(a.created_at) AS window_start,
         MAX(a.created_at) AS window_end
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
         AND a.user_id IS NOT NULL
       GROUP BY a.user_id
       HAVING action_count >= ?
       ORDER BY action_count DESC
       LIMIT 20`,
      [hours, threshold * 10],
    );

    // Password resets in bulk (possible account takeover attempts)
    const [bulkResets] = await db.execute(
      `SELECT
         a.ip_address,
         COUNT(*) AS reset_count
       FROM activity_logs a
       WHERE a.action      = 'password_reset'
         AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       GROUP BY a.ip_address
       HAVING reset_count >= 3
       ORDER BY reset_count DESC`,
      [hours],
    );

    return {
      failed_login_ips: failedLogins,
      high_volume_users: highVolumeUsers,
      bulk_password_resets: bulkResets,
      checked_at: new Date().toISOString(),
      window_hours: hours,
    };
  }

  // ── getActionBreakdown ─────────────────────────────────
  // Count of each action in the last N days.
  // Returns both a flat list and a grouped-by-category object.
  // Used by admin bar/pie charts.
  //
  // Usage:
  //   const data = await AuditLogService.getActionBreakdown(7);
  static async getActionBreakdown(days = 7) {
    const safeDays = Math.min(90, parseInt(days, 10) || 7);

    const [rows] = await db.execute(
      `SELECT
         action,
         COUNT(*) AS count
       FROM activity_logs
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY action
       ORDER BY count DESC`,
      [safeDays],
    );

    // Group by category for chart legends
    const byCategory = {};
    for (const row of rows) {
      const cat = AuditLogService.getActionCategory(row.action);
      if (!byCategory[cat]) byCategory[cat] = { total: 0, actions: [] };
      byCategory[cat].total += Number(row.count);
      byCategory[cat].actions.push({
        action: row.action,
        count: Number(row.count),
      });
    }

    return {
      by_action: rows,
      by_category: byCategory,
      period_days: safeDays,
    };
  }

  // ── getDailyVolume ─────────────────────────────────────
  // Daily total activity count + key event sub-counts
  // for the last N days — used by line/area charts on the
  // admin dashboard and reports page.
  //
  // Usage:
  //   const data = await AuditLogService.getDailyVolume(30);
  static async getDailyVolume(days = 30) {
    const safeDays = Math.min(90, parseInt(days, 10) || 30);

    const [rows] = await db.execute(
      `SELECT
         DATE(created_at)                                    AS date,
         COUNT(*)                                            AS total,
         SUM(action IN ('login', 'admin_login'))             AS logins,
         SUM(action = 'payment_created')                     AS payments,
         SUM(action IN ('maintenance_created',
                        'maintenance_status_updated',
                        'maintenance_resolved'))             AS maintenance,
         SUM(action IN ('register', 'user_created'))         AS registrations,
         SUM(action IN ('invite_code_created',
                        'invite_code_used'))                 AS invite_activity
       FROM activity_logs
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [safeDays],
    );

    return rows;
  }

  // ── getHourlyVolume ────────────────────────────────────
  // Action count per hour for a specific date.
  // Used to identify peak usage times.
  //
  // Usage:
  //   const data = await AuditLogService.getHourlyVolume("2026-03-01");
  static async getHourlyVolume(date = null) {
    const targetDate = date ? toISODate(new Date(date)) : toISODate(new Date());

    const [rows] = await db.execute(
      `SELECT
         HOUR(created_at) AS hour,
         COUNT(*)         AS total
       FROM activity_logs
       WHERE DATE(created_at) = ?
       GROUP BY HOUR(created_at)
       ORDER BY hour ASC`,
      [targetDate],
    );

    // Fill in missing hours with 0 so charts don't skip
    const filled = Array.from({ length: 24 }, (_, h) => {
      const found = rows.find((r) => Number(r.hour) === h);
      return { hour: h, total: found ? Number(found.total) : 0 };
    });

    return { date: targetDate, hours: filled };
  }

  // ── getLoginHistory ────────────────────────────────────
  // All login attempts for a specific user — success + failure.
  // Used on admin user detail page for security review.
  //
  // Usage:
  //   const history = await AuditLogService.getLoginHistory(userId, 20);
  static async getLoginHistory(userId, limit = 20) {
    const uid = parseId(userId);
    if (!uid) throw new AppError("Invalid user ID", 400);
    const safeLimit = Math.min(100, parseInt(limit, 10) || 20);

    const [rows] = await db.execute(
      `SELECT
         id, action, description, ip_address, user_agent, created_at
       FROM activity_logs
       WHERE user_id = ?
         AND action IN ('login', 'logout', 'admin_login',
                        'password_reset', 'password_change')
       ORDER BY created_at DESC
       LIMIT ?`,
      [uid, safeLimit],
    );

    return rows.map(enrichRow);
  }

  // ── purgeOldLogs ───────────────────────────────────────
  // Delete logs older than N days.
  // Minimum enforced: 30 days (protects recent audit trail).
  // Run by a scheduled cron job or admin action.
  // Returns count of deleted rows.
  //
  // Usage:
  //   const deleted = await AuditLogService.purgeOldLogs(90);
  static async purgeOldLogs(olderThanDays = 90) {
    const days = Math.max(30, parseInt(olderThanDays, 10) || 90);

    const [result] = await db.execute(
      `DELETE FROM activity_logs
       WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days],
    );

    console.log(
      `🗑️  AuditLogService.purgeOldLogs: removed ${result.affectedRows} ` +
        `records older than ${days} days`,
    );
    return result.affectedRows;
  }

  // ── getActionCategory ──────────────────────────────────
  // Map an action string to its category label.
  // Returns "general" if the action is not in any category.
  static getActionCategory(action) {
    for (const [category, actions] of Object.entries(ACTION_CATEGORIES)) {
      if (actions.includes(action)) return category;
    }
    return "general";
  }

  // ── getCategories ──────────────────────────────────────
  // Return all categories and their actions.
  // Used to populate filter dropdown menus in the admin UI.
  static getCategories() {
    return ACTION_CATEGORIES;
  }

  // ── getAllActions ──────────────────────────────────────
  // Flat list of all valid action strings.
  static getAllActions() {
    return ALL_ACTIONS;
  }
}

module.exports = AuditLogService;
