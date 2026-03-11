// notification.js
const { pool } = require("./db");

// ── Valid notification types — matches schema delivery_channel ENUM ──
const VALID_NOTIFICATION_TYPES = [
  "new_message",
  "maintenance_request",
  "maintenance_update",
  "payment_reminder",
  "payment_received",
  "lease_expiring",
  "lease_renewed",
  "tenancy_update",
  "group_message",
  "new_tenant",
  "invite_code",
  "announcement",
  "general",
];

const VALID_DELIVERY_CHANNELS = ["in_app", "email", "push"];

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

// ── sendNotification ─────────────────────────────────────────
// Insert a notification and emit via Socket.io if available.
// Non-fatal — errors are logged, never thrown.
// Column names match rentms_full_schema.sql notifications table:
//   recipient_id, sender_id, type, message, reference_id,
//   grouped_key, delivery_channel, expires_at
//
// Usage:
//   await sendNotification({
//     recipientId : tenant.id,
//     senderId    : req.user.id,   // optional
//     type        : "payment_received",
//     message     : "Your payment of GHS 1,500 has been received",
//     referenceId : payment.id,    // optional
//     channel     : "in_app",      // optional, default "in_app"
//     groupedKey  : null,          // optional dedup key
//     io          : req.app.get("io"),
//   });
const sendNotification = async ({
  recipientId,
  senderId = null,
  type,
  message,
  referenceId = null,
  channel = "in_app",
  groupedKey = null,
  io = null,
}) => {
  const uid = parseId(recipientId);
  if (!uid) {
    console.warn("⚠️  sendNotification: invalid recipientId —", recipientId);
    return;
  }

  if (!type || !VALID_NOTIFICATION_TYPES.includes(type)) {
    console.warn(`⚠️  sendNotification: invalid type "${type}" — skipping`);
    return;
  }

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    console.warn("⚠️  sendNotification: message is required — skipping");
    return;
  }

  const deliveryChannel = VALID_DELIVERY_CHANNELS.includes(channel)
    ? channel
    : "in_app";

  try {
    const [result] = await pool.execute(
      `INSERT INTO notifications
         (recipient_id, sender_id, type, message, reference_id,
          grouped_key, is_read, delivery_channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, FALSE, ?, NOW())`,
      [
        uid,
        senderId ? parseId(senderId) : null,
        type,
        message.trim(),
        referenceId ? parseId(referenceId) : null,
        groupedKey || null,
        deliveryChannel,
      ],
    );

    // Emit real-time via Socket.io
    if (io) {
      io.to(`user_${uid}`).emit("notification", {
        id: result.insertId,
        type,
        message: message.trim(),
        reference_id: referenceId || null,
        is_read: false,
        created_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("❌ sendNotification failed:", err.message);
  }
};

// ── sendBulkNotifications ────────────────────────────────────
// Send the same notification to multiple recipients at once.
//
// Usage:
//   await sendBulkNotifications({
//     recipientIds : [1, 2, 3],
//     type         : "announcement",
//     message      : "Plaza maintenance scheduled for tomorrow",
//     io           : req.app.get("io"),
//   });
const sendBulkNotifications = async ({
  recipientIds,
  senderId = null,
  type,
  message,
  channel = "in_app",
  groupedKey = null,
  io = null,
}) => {
  if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
    console.warn(
      "⚠️  sendBulkNotifications: recipientIds must be a non-empty array",
    );
    return;
  }

  const results = await Promise.allSettled(
    recipientIds.map((recipientId) =>
      sendNotification({
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
  if (failed > 0) {
    console.warn(`⚠️  sendBulkNotifications: ${failed} notification(s) failed`);
  }
};

// ── markAsRead ───────────────────────────────────────────────
// Mark a single notification as read.
const markAsRead = async (notificationId, recipientId) => {
  const nid = parseId(notificationId);
  const uid = parseId(recipientId);
  if (!nid || !uid) return;
  try {
    await pool.execute(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE id = ? AND recipient_id = ?`,
      [nid, uid],
    );
  } catch (err) {
    console.error("❌ markAsRead failed:", err.message);
  }
};

// ── markAllAsRead ────────────────────────────────────────────
// Mark all unread notifications for a user as read.
const markAllAsRead = async (recipientId) => {
  const uid = parseId(recipientId);
  if (!uid) return;
  try {
    await pool.execute(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE recipient_id = ? AND is_read = FALSE`,
      [uid],
    );
  } catch (err) {
    console.error("❌ markAllAsRead failed:", err.message);
  }
};

// ── getUnreadCount ───────────────────────────────────────────
// Returns the unread notification count for a user.
const getUnreadCount = async (recipientId) => {
  const uid = parseId(recipientId);
  if (!uid) return 0;
  try {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE recipient_id = ? AND is_read = FALSE`,
      [uid],
    );
    return rows[0]?.count || 0;
  } catch (err) {
    console.error("❌ getUnreadCount failed:", err.message);
    return 0;
  }
};

module.exports = {
  sendNotification,
  sendBulkNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  VALID_NOTIFICATION_TYPES,
  VALID_DELIVERY_CHANNELS,
};
