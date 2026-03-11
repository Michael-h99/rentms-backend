// controllers/notificationController.js
// ============================================================
// All notification endpoints. Uses NotificationService for
// DB operations and Socket.io for real-time delivery.
//
// Schema (rentms_full_schema.sql — Section 10):
//   notifications.type        : VARCHAR(50) — see VALID_TYPES
//   notifications.is_read     : BOOLEAN
//   notifications.grouped_key : VARCHAR(100) — for grouping in UI
//   notifications.expires_at  : DATETIME NULL
//
// Import path from routes:
//   require("../controllers/notificationController")
// ============================================================

const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");
const { buildPaginationResponse } = require("../utils/pagination");

// Schema-aligned valid types (notificationService.js VALID_TYPES)
const VALID_TYPES = [
  "new_message",
  "maintenance_request",
  "maintenance_update",
  "payment_reminder",
  "payment_received",
  "payment_failed",
  "lease_expiring",
  "lease_renewed",
  "tenancy_update",
  "new_tenant",
  "invite_code",
  "announcement",
  "general",
];

const DEFAULT_LIMIT = 20;
const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// ── Generate grouped_key ─────────────────────────────────────
// Groups related notifications in the UI (e.g. all payment_received
// for a given reference on the same day collapse into one row).
const makeGroupedKey = (type, referenceId) => {
  const today = new Date().toISOString().split("T")[0];
  const safeRef = referenceId
    ? String(referenceId).replace(/[^a-zA-Z0-9_-]/g, "")
    : "general";
  return `${type}_${safeRef}_${today}`;
};

// ═══════════════════════════════════════════════════════════════
// SEND — Admin + Landlord
// ═══════════════════════════════════════════════════════════════

// POST /api/notifications/send
// Send a notification to a specific user.
// Landlords can only notify their own tenants (enforced below).
// Body: { recipient_id, type, message, reference_id? }
const sendNotification = asyncHandler(async (req, res) => {
  const { recipient_id, type, message, reference_id } = req.body;
  const senderId = req.user.id;

  if (!recipient_id || !type || !message) {
    throw new AppError("recipient_id, type, and message are required", 400);
  }
  if (!VALID_TYPES.includes(type)) {
    throw new AppError(
      `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  const recipientId = parseId(recipient_id);
  if (!recipientId) throw new AppError("Invalid recipient_id", 400);
  if (recipientId === senderId)
    throw new AppError("You cannot send a notification to yourself", 400);

  // Landlord ownership check — can only notify own active tenants
  if (req.user.role === "landlord") {
    const [[{ count }]] = await db.execute(
      `SELECT COUNT(*) AS count
       FROM tenancies t JOIN plazas p ON p.id = t.plaza_id
       WHERE p.landlord_id = ? AND t.tenant_id = ? AND t.status = 'active'`,
      [senderId, recipientId],
    );
    if (!count)
      throw new AppError("Recipient is not one of your active tenants", 403);
  } else {
    // Admin — just confirm user exists
    const [[{ exists }]] = await db.execute(
      `SELECT COUNT(*) AS exists FROM users WHERE id = ? AND deleted_at IS NULL`,
      [recipientId],
    );
    if (!exists) throw new AppError("Recipient not found", 404);
  }

  const notification = await NotificationService.create({
    recipientId: recipientId,
    senderId: senderId,
    type,
    message: message.trim(),
    referenceId: reference_id ? parseId(reference_id) : null,
    groupedKey: makeGroupedKey(type, reference_id),
    io: req.app.get("io"),
  });

  await logActivity(
    senderId,
    "notification_sent",
    `Sent ${type} notification to user ${recipientId}`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Notification sent successfully",
    notification_id: notification?.id,
  });
});

// POST /api/notifications/broadcast
// Send the same notification to all active tenants of a landlord's plaza,
// or to all users platform-wide (admin only).
// Body: { type, message, plaza_id? (landlord), reference_id? }
const broadcastNotification = asyncHandler(async (req, res) => {
  const { type, message, plaza_id, reference_id } = req.body;
  const senderId = req.user.id;

  if (!type || !message)
    throw new AppError("type and message are required", 400);
  if (!VALID_TYPES.includes(type)) {
    throw new AppError(
      `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  let recipientIds = [];

  if (req.user.role === "landlord") {
    // Landlord must provide plaza_id and must own it
    const plazaId = parseId(plaza_id);
    if (!plazaId)
      throw new AppError("plaza_id is required for landlord broadcasts", 400);

    const [[{ owns }]] = await db.execute(
      `SELECT COUNT(*) AS owns FROM plazas WHERE id = ? AND landlord_id = ? AND deleted_at IS NULL`,
      [plazaId, senderId],
    );
    if (!owns) throw new AppError("Plaza not found or access denied", 403);

    const [rows] = await db.execute(
      `SELECT DISTINCT t.tenant_id AS id
       FROM tenancies t WHERE t.plaza_id = ? AND t.status = 'active'`,
      [plazaId],
    );
    recipientIds = rows.map((r) => r.id);
    if (!recipientIds.length) {
      return res.json({
        success: true,
        message: "No active tenants in this plaza",
        sent: 0,
      });
    }
  } else {
    // Admin — broadcast to all active non-admin users
    const [rows] = await db.execute(
      `SELECT id FROM users WHERE role != 'admin' AND status = 'active' AND deleted_at IS NULL`,
    );
    recipientIds = rows.map((r) => r.id);
    if (!recipientIds.length) {
      return res.json({
        success: true,
        message: "No active users found",
        sent: 0,
      });
    }
  }

  await NotificationService.createBulk({
    recipientIds,
    senderId,
    type,
    message: message.trim(),
    referenceId: reference_id ? parseId(reference_id) : null,
    groupedKey: makeGroupedKey(type, reference_id),
    io: req.app.get("io"),
  });

  await logActivity(
    senderId,
    "notification_sent",
    `Broadcast ${type} notification to ${recipientIds.length} users`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Broadcast sent successfully",
    sent: recipientIds.length,
  });
});

// ═══════════════════════════════════════════════════════════════
// READ — Current user's own notifications
// ═══════════════════════════════════════════════════════════════

// GET /api/notifications
// All notifications for the current user, paginated.
// Query params: page, limit, unread (boolean)
const getMyNotifications = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const unreadOnly = req.query.unread === "true";

  const conditions = [
    "recipient_id = ?",
    "(expires_at IS NULL OR expires_at > NOW())",
  ];
  const params = [userId];

  if (unreadOnly) {
    conditions.push("is_read = 0");
  }

  const WHERE = conditions.join(" AND ");

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM notifications WHERE ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT
       n.id, n.type, n.message, n.reference_id,
       n.grouped_key, n.is_read, n.created_at,
       u.full_name  AS sender_name,
       u.avatar_url AS sender_avatar
     FROM notifications n
     LEFT JOIN users u ON u.id = n.sender_id
     WHERE ${WHERE}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// GET /api/notifications/grouped
// Notifications collapsed by grouped_key.
// Used by the notification centre UI to merge related entries.
const getGroupedNotifications = asyncHandler(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT
       grouped_key, type,
       COUNT(*)         AS total,
       SUM(is_read = 0) AS unread_count,
       MAX(created_at)  AS latest
     FROM notifications
     WHERE recipient_id = ?
       AND (expires_at IS NULL OR expires_at > NOW())
     GROUP BY grouped_key, type
     ORDER BY latest DESC`,
    [req.user.id],
  );
  return res.json({ success: true, data: rows });
});

// GET /api/notifications/filter
// Filter by type — paginated.
// Query params: type (required), page, limit
const filterByType = asyncHandler(async (req, res) => {
  const { type } = req.query;
  if (!type) throw new AppError("type query parameter is required", 400);
  if (!VALID_TYPES.includes(type)) {
    throw new AppError(
      `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;

  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM notifications
     WHERE recipient_id = ? AND type = ?
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [req.user.id, type],
  );

  const [rows] = await db.execute(
    `SELECT
       n.id, n.type, n.message, n.reference_id,
       n.grouped_key, n.is_read, n.created_at,
       u.full_name  AS sender_name,
       u.avatar_url AS sender_avatar
     FROM notifications n
     LEFT JOIN users u ON u.id = n.sender_id
     WHERE n.recipient_id = ? AND n.type = ?
       AND (n.expires_at IS NULL OR n.expires_at > NOW())
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [req.user.id, type, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// GET /api/notifications/unread-count
// Fast badge count — used by nav bar.
const getUnreadCount = asyncHandler(async (req, res) => {
  const [[{ unread }]] = await db.execute(
    `SELECT COUNT(*) AS unread FROM notifications
     WHERE recipient_id = ? AND is_read = 0
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [req.user.id],
  );
  return res.json({ success: true, unread });
});

// ═══════════════════════════════════════════════════════════════
// MARK AS READ
// ═══════════════════════════════════════════════════════════════

// PATCH /api/notifications/:notification_id/read
// Mark a single notification as read.
// Scoped to the current user — cannot mark another user's notifications.
const markAsRead = asyncHandler(async (req, res) => {
  const notifId = parseId(req.params.notification_id);
  if (!notifId) throw new AppError("Invalid notification ID", 400);

  const [result] = await db.execute(
    `UPDATE notifications SET is_read = 1
     WHERE id = ? AND recipient_id = ?`,
    [notifId, req.user.id],
  );

  if (!result.affectedRows) {
    throw new AppError(
      "Notification not found or you are not the recipient",
      404,
    );
  }

  await logActivity(
    req.user.id,
    "notification_read",
    `Marked notification ${notifId} as read`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Marked as read" });
});

// PATCH /api/notifications/read-all
// Mark all unread notifications as read for the current user.
const markAllAsRead = asyncHandler(async (req, res) => {
  const [result] = await db.execute(
    `UPDATE notifications SET is_read = 1
     WHERE recipient_id = ? AND is_read = 0`,
    [req.user.id],
  );

  await logActivity(
    req.user.id,
    "notification_read",
    `Marked ${result.affectedRows} notifications as read (bulk)`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "All notifications marked as read",
    updated: result.affectedRows,
  });
});

// PATCH /api/notifications/read-type/:type
// Mark all unread notifications of a specific type as read.
// Useful when the user visits a page (e.g. all payment_received
// cleared when they open the payments tab).
const markTypeAsRead = asyncHandler(async (req, res) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) {
    throw new AppError(
      `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  const [result] = await db.execute(
    `UPDATE notifications SET is_read = 1
     WHERE recipient_id = ? AND type = ? AND is_read = 0`,
    [req.user.id, type],
  );

  return res.json({
    success: true,
    message: `Marked ${result.affectedRows} ${type} notifications as read`,
    updated: result.affectedRows,
  });
});

// ═══════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════

// DELETE /api/notifications/:notification_id
// User deletes a single notification — own only.
const deleteNotification = asyncHandler(async (req, res) => {
  const notifId = parseId(req.params.notification_id);
  if (!notifId) throw new AppError("Invalid notification ID", 400);

  const [result] = await db.execute(
    `DELETE FROM notifications WHERE id = ? AND recipient_id = ?`,
    [notifId, req.user.id],
  );

  if (!result.affectedRows) {
    throw new AppError(
      "Notification not found or you are not the recipient",
      404,
    );
  }

  return res.json({ success: true, message: "Notification deleted" });
});

// DELETE /api/notifications/clear-all
// User clears all their own notifications.
const clearAllNotifications = asyncHandler(async (req, res) => {
  const [result] = await db.execute(
    `DELETE FROM notifications WHERE recipient_id = ?`,
    [req.user.id],
  );
  return res.json({
    success: true,
    message: "All notifications cleared",
    deleted: result.affectedRows,
  });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════

// GET /api/notifications/admin/stats
// Platform-wide notification breakdown by type.
// Includes total, unread, read count, and read rate %.
const getAdminNotificationStats = asyncHandler(async (req, res) => {
  const [byType] = await db.execute(
    `SELECT
       type,
       COUNT(*)                                                  AS total,
       SUM(is_read = 0)                                          AS unread,
       SUM(is_read = 1)                                          AS read_count,
       ROUND(SUM(is_read = 1) * 100.0 / NULLIF(COUNT(*), 0), 1) AS read_rate_pct
     FROM notifications
     GROUP BY type
     ORDER BY total DESC`,
  );

  const [[totals]] = await db.execute(
    `SELECT
       COUNT(*)                      AS total_notifications,
       SUM(is_read = 0)              AS total_unread,
       COUNT(DISTINCT recipient_id)  AS users_with_notifications,
       COUNT(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                  THEN 1 END)        AS sent_last_24h
     FROM notifications`,
  );

  return res.json({ success: true, data: { by_type: byType, totals } });
});

// GET /api/notifications/admin/all
// Paginated view of all notifications across all users.
// Query params: page, limit, type, recipient_id, unread
const getAllNotificationsAdmin = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { type } = req.query;
  const recipientId = parseId(req.query.recipient_id);
  const unreadOnly = req.query.unread === "true";

  const conditions = [];
  const params = [];

  if (type && VALID_TYPES.includes(type)) {
    conditions.push("n.type = ?");
    params.push(type);
  }
  if (recipientId) {
    conditions.push("n.recipient_id = ?");
    params.push(recipientId);
  }
  if (unreadOnly) {
    conditions.push("n.is_read = 0");
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM notifications n ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT
       n.id, n.type, n.message, n.reference_id,
       n.is_read, n.created_at,
       r.full_name  AS recipient_name,
       r.email      AS recipient_email,
       s.full_name  AS sender_name
     FROM notifications n
     JOIN users r ON r.id = n.recipient_id
     LEFT JOIN users s ON s.id = n.sender_id
     ${WHERE}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

module.exports = {
  // Send
  sendNotification,
  broadcastNotification,
  // Read
  getMyNotifications,
  getGroupedNotifications,
  filterByType,
  getUnreadCount,
  // Mark as read
  markAsRead,
  markAllAsRead,
  markTypeAsRead,
  // Delete
  deleteNotification,
  clearAllNotifications,
  // Admin
  getAdminNotificationStats,
  getAllNotificationsAdmin,
};
