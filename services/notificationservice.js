// notificationService.js
// ============================================================
// Notification service — all DB operations for the notifications
// table plus real-time Socket.io emit.
//
// Column mapping (rentms_full_schema.sql):
//   recipient_id, sender_id, type, message, reference_id,
//   grouped_key, is_read, read_at, delivery_channel,
//   expires_at, created_at
// ============================================================

const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");
const { buildPaginationResponse } = require("../utils/pagination");

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

const VALID_CHANNELS = ["in_app", "email", "push"];
const DEFAULT_LIMIT = 20;

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

class NotificationService {
  // ── create ─────────────────────────────────────────────
  // Insert a notification and optionally emit via Socket.io.
  // Non-fatal — never throws to the caller.
  //
  // Usage:
  //   await NotificationService.create({
  //     recipientId  : tenant.id,
  //     senderId     : req.user.id,
  //     type         : "payment_received",
  //     message      : "Your payment of GHS 1,500 has been received",
  //     referenceId  : payment.id,
  //     io           : req.app.get("io"),
  //   });
  static async create({
    recipientId,
    senderId = null,
    type,
    message,
    referenceId = null,
    groupedKey = null,
    channel = "in_app",
    expiresAt = null,
    io = null,
    connection = null,
  }) {
    const uid = parseId(recipientId);
    if (!uid) {
      console.warn(
        "⚠️  NotificationService.create: invalid recipientId —",
        recipientId,
      );
      return null;
    }
    if (!type || !VALID_TYPES.includes(type)) {
      console.warn(`⚠️  NotificationService.create: invalid type "${type}"`);
      return null;
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      console.warn("⚠️  NotificationService.create: message is required");
      return null;
    }

    const deliveryChannel = VALID_CHANNELS.includes(channel)
      ? channel
      : "in_app";

    try {
      const executor = connection || db;
      const [result] = await executor.execute(
        `INSERT INTO notifications
           (recipient_id, sender_id, type, message, reference_id,
            grouped_key, is_read, delivery_channel, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, FALSE, ?, ?, NOW())`,
        [
          uid,
          senderId ? parseId(senderId) : null,
          type,
          message.trim(),
          referenceId ? parseId(referenceId) : null,
          groupedKey || null,
          deliveryChannel,
          expiresAt || null,
        ],
      );

      const notif = {
        id: result.insertId,
        type,
        message: message.trim(),
        reference_id: referenceId || null,
        is_read: false,
        created_at: new Date().toISOString(),
      };

      // Real-time emit via Socket.io
      if (io) {
        io.to(`user_${uid}`).emit("notification", notif);
      }

      return notif;
    } catch (err) {
      console.error("❌ NotificationService.create failed:", err.message);
      return null;
    }
  }

  // ── createBulk ─────────────────────────────────────────
  // Send the same notification to multiple recipients.
  //
  // Usage:
  //   await NotificationService.createBulk({
  //     recipientIds : [1, 2, 3],
  //     type         : "announcement",
  //     message      : "Plaza maintenance tomorrow at 9am",
  //     io           : req.app.get("io"),
  //   });
  static async createBulk({
    recipientIds,
    senderId = null,
    type,
    message,
    channel = "in_app",
    groupedKey = null,
    io = null,
  }) {
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) return;

    const results = await Promise.allSettled(
      recipientIds.map((recipientId) =>
        NotificationService.create({
          recipientId,
          senderId,
          type,
          message,
          channel,
          groupedKey,
          io,
        }),
      ),
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0)
      console.warn(`⚠️  createBulk: ${failed} notification(s) failed`);
  }

  // ── getForUser ──────────────────────────────────────────
  // Paginated notifications for a user, newest first.
  // Optionally filter by read status or type.
  //
  // Usage:
  //   const result = await NotificationService.getForUser(req.user.id, { unread: true });
  static async getForUser(
    recipientId,
    { page = 1, limit = DEFAULT_LIMIT, unread = false, type = null } = {},
  ) {
    const uid = parseId(recipientId);
    if (!uid) throw new AppError("Invalid recipient ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["n.recipient_id = ?"];
    const params = [uid];

    if (unread) {
      conditions.push("n.is_read = FALSE");
    }
    if (type && VALID_TYPES.includes(type)) {
      conditions.push("n.type = ?");
      params.push(type);
    }

    // Exclude expired notifications
    conditions.push("(n.expires_at IS NULL OR n.expires_at > NOW())");

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM notifications n WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         n.id, n.type, n.message, n.reference_id, n.grouped_key,
         n.is_read, n.read_at, n.delivery_channel, n.created_at,
         s.full_name  AS sender_name,
         s.avatar_url AS sender_avatar
       FROM notifications n
       LEFT JOIN users s ON s.id = n.sender_id
       WHERE ${WHERE}
       ORDER BY n.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── getById ─────────────────────────────────────────────
  static async getById(id, recipientId = null) {
    const notifId = parseId(id);
    if (!notifId) throw new AppError("Invalid notification ID", 400);

    const conditions = ["n.id = ?"];
    const params = [notifId];

    // Scope to recipient if provided (prevents users reading other's notifications)
    if (recipientId) {
      const uid = parseId(recipientId);
      if (uid) {
        conditions.push("n.recipient_id = ?");
        params.push(uid);
      }
    }

    const [rows] = await db.execute(
      `SELECT n.*, s.full_name AS sender_name
       FROM notifications n
       LEFT JOIN users s ON s.id = n.sender_id
       WHERE ${conditions.join(" AND ")}`,
      params,
    );

    if (!rows.length) throw new AppError("Notification not found", 404);
    return rows[0];
  }

  // ── getUnreadCount ──────────────────────────────────────
  // Fast unread count — used for notification badge in nav.
  static async getUnreadCount(recipientId) {
    const uid = parseId(recipientId);
    if (!uid) return 0;

    const [[{ count }]] = await db.execute(
      `SELECT COUNT(*) AS count
       FROM notifications
       WHERE recipient_id = ? AND is_read = FALSE
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [uid],
    );
    return count;
  }

  // ── markAsRead ──────────────────────────────────────────
  // Mark a single notification as read.
  static async markAsRead(id, recipientId) {
    const notifId = parseId(id);
    const uid = parseId(recipientId);
    if (!notifId || !uid) throw new AppError("Invalid ID", 400);

    const [result] = await db.execute(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE id = ? AND recipient_id = ? AND is_read = FALSE`,
      [notifId, uid],
    );

    return result.affectedRows > 0;
  }

  // ── markAllAsRead ───────────────────────────────────────
  // Mark all unread notifications for a user as read.
  static async markAllAsRead(recipientId) {
    const uid = parseId(recipientId);
    if (!uid) throw new AppError("Invalid recipient ID", 400);

    const [result] = await db.execute(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE recipient_id = ? AND is_read = FALSE`,
      [uid],
    );

    return result.affectedRows;
  }

  // ── markTypeAsRead ──────────────────────────────────────
  // Mark all notifications of a specific type as read.
  // Usage: after user views the payments page, mark payment_received as read.
  static async markTypeAsRead(recipientId, type) {
    const uid = parseId(recipientId);
    if (!uid) throw new AppError("Invalid recipient ID", 400);
    if (!type || !VALID_TYPES.includes(type))
      throw new AppError("Invalid notification type", 400);

    const [result] = await db.execute(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE recipient_id = ? AND type = ? AND is_read = FALSE`,
      [uid, type],
    );

    return result.affectedRows;
  }

  // ── delete ──────────────────────────────────────────────
  // Delete a single notification (user clearing it).
  static async delete(id, recipientId) {
    const notifId = parseId(id);
    const uid = parseId(recipientId);
    if (!notifId || !uid) throw new AppError("Invalid ID", 400);

    const [result] = await db.execute(
      `DELETE FROM notifications WHERE id = ? AND recipient_id = ?`,
      [notifId, uid],
    );

    if (result.affectedRows === 0)
      throw new AppError("Notification not found", 404);
    return true;
  }

  // ── clearAll ────────────────────────────────────────────
  // Delete all notifications for a user (clear all).
  static async clearAll(recipientId) {
    const uid = parseId(recipientId);
    if (!uid) throw new AppError("Invalid recipient ID", 400);

    const [result] = await db.execute(
      `DELETE FROM notifications WHERE recipient_id = ?`,
      [uid],
    );
    return result.affectedRows;
  }

  // ── deleteExpired ───────────────────────────────────────
  // Purge expired notifications — run by a scheduled cron job.
  static async deleteExpired() {
    const [result] = await db.execute(
      `DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
    );
    return result.affectedRows;
  }

  // ── getAll ──────────────────────────────────────────────
  // Admin only — all notifications with filters, paginated.
  static async getAll({
    page = 1,
    limit = DEFAULT_LIMIT,
    type = null,
    recipientId = null,
  } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = [];
    const params = [];

    if (type && VALID_TYPES.includes(type)) {
      conditions.push("n.type = ?");
      params.push(type);
    }
    if (recipientId && parseId(recipientId)) {
      conditions.push("n.recipient_id = ?");
      params.push(parseId(recipientId));
    }

    const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM notifications n ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         n.id, n.type, n.message, n.is_read, n.delivery_channel, n.created_at,
         r.full_name AS recipient_name, r.email AS recipient_email,
         s.full_name AS sender_name
       FROM notifications n
       JOIN users r ON r.id = n.recipient_id
       LEFT JOIN users s ON s.id = n.sender_id
       ${WHERE}
       ORDER BY n.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }
}

module.exports = NotificationService;
