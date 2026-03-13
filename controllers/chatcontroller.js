// controllers/chatcontroller.js
// ============================================================
// Direct messaging between users (tenant ↔ landlord,
// landlord ↔ admin, etc.). All roles can send and receive.
//
// Schema (rentms_full_schema.sql — Section 9):
//   messages.sender_id   : INT
//   messages.receiver_id : INT
//   messages.content     : TEXT NULL
//   messages.file_url    : VARCHAR(500) NULL
//   messages.file_type   : ENUM('image','pdf','doc','other') NULL
//   messages.is_read     : BOOLEAN DEFAULT FALSE
//   messages.read_at     : DATETIME NULL
//   messages.timestamp   : TIMESTAMP  ← not created_at
//
// Import path from routes:
//   require("../controllers/chatcontroller")
// ============================================================

const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");
const { buildPaginationResponse } = require("../utils/pagination");

const DEFAULT_LIMIT = 30;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// ── Resolve file_type from MIME ───────────────────────────────
const resolveFileType = (mime) => {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("word") || mime.includes("document")) return "doc";
  return "other";
};

// ── Messaging permission check ────────────────────────────────
// Tenants → only their active plaza's landlord
// Landlords → their own active tenants or any admin
// Admins → anyone
const assertMessagingAllowed = async (userId, userRole, partnerId) => {
  const [[partner]] = await db.execute(
    `SELECT id, full_name, role, status FROM users
     WHERE id = ? AND deleted_at IS NULL`,
    [partnerId],
  );
  if (!partner) throw new AppError("User not found", 404);
  if (partner.status !== "active")
    throw new AppError("Cannot message a suspended user", 400);
  if (userRole === "admin") return partner;

  if (userRole === "tenant") {
    const [[{ count }]] = await db.execute(
      `SELECT COUNT(*) AS count
       FROM tenancies t JOIN plazas p ON p.id = t.plaza_id
       WHERE t.tenant_id = ? AND p.landlord_id = ? AND t.status = 'active'`,
      [userId, partnerId],
    );
    if (!count)
      throw new AppError("You can only message your plaza's landlord", 403);
  }

  if (userRole === "landlord") {
    if (partner.role === "admin") return partner; // landlord ↔ admin always allowed
    const [[{ count }]] = await db.execute(
      `SELECT COUNT(*) AS count
       FROM tenancies t JOIN plazas p ON p.id = t.plaza_id
       WHERE p.landlord_id = ? AND t.tenant_id = ? AND t.status = 'active'`,
      [userId, partnerId],
    );
    if (!count)
      throw new AppError("You can only message your own active tenants", 403);
  }

  return partner;
};

// ═══════════════════════════════════════════════════════════════
// GET /api/chat/conversations
// All conversation partners for the current user.
// Returns latest message, last_file_type, timestamp, unread count.
// Avoids LATERAL JOIN — uses a correlated subquery for MySQL 5.7 compat.
// ═══════════════════════════════════════════════════════════════
const getConversations = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Step 1 — unique partner IDs
  const [partners] = await db.execute(
    `SELECT DISTINCT
       IF(sender_id = ?, receiver_id, sender_id) AS partner_id
     FROM messages
     WHERE sender_id = ? OR receiver_id = ?`,
    [userId, userId, userId],
  );

  if (!partners.length) {
    return res.json({ success: true, data: [] });
  }

  const partnerIds = partners.map((p) => p.partner_id);
  const placeholders = partnerIds.map(() => "?").join(",");

  // Step 2 — partner user info
  const [users] = await db.execute(
    `SELECT id, full_name, avatar_url, role
     FROM users WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    partnerIds,
  );
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  // Step 3 — latest message per partner + unread count
  const conversations = await Promise.all(
    partnerIds.map(async (partnerId) => {
      const [[latest]] = await db.execute(
        `SELECT content, file_type, timestamp, sender_id
         FROM messages
         WHERE (sender_id = ? AND receiver_id = ?)
            OR (sender_id = ? AND receiver_id = ?)
         ORDER BY timestamp DESC LIMIT 1`,
        [userId, partnerId, partnerId, userId],
      );

      const [[{ unread }]] = await db.execute(
        `SELECT COUNT(*) AS unread FROM messages
         WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE`,
        [partnerId, userId],
      );

      return {
        partner_id: partnerId,
        partner_name: userMap[partnerId]?.full_name ?? null,
        partner_avatar: userMap[partnerId]?.avatar_url ?? null,
        partner_role: userMap[partnerId]?.role ?? null,
        last_message: latest?.content ?? null,
        last_file_type: latest?.file_type ?? null,
        last_at: latest?.timestamp ?? null,
        last_sender_id: latest?.sender_id ?? null,
        unread_count: unread,
      };
    }),
  );

  // Sort by most recent message
  conversations.sort((a, b) => new Date(b.last_at) - new Date(a.last_at));

  return res.json({ success: true, data: conversations });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/chat/messages/:partner_id
// Paginated message thread — oldest first for chat view.
// Query params: page, limit
// ═══════════════════════════════════════════════════════════════
const fetchMessages = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const partnerId = parseId(req.params.partner_id);
  if (!partnerId) throw new AppError("Invalid partner ID", 400);
  if (partnerId === userId)
    throw new AppError("Cannot fetch messages with yourself", 400);

  const [[partner]] = await db.execute(
    `SELECT id, full_name, avatar_url, role FROM users
     WHERE id = ? AND deleted_at IS NULL`,
    [partnerId],
  );
  if (!partner) throw new AppError("User not found", 404);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;

  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM messages
     WHERE (sender_id = ? AND receiver_id = ?)
        OR (sender_id = ? AND receiver_id = ?)`,
    [userId, partnerId, partnerId, userId],
  );

  const [messages] = await db.query(
    `SELECT
       m.id, m.sender_id, m.receiver_id,
       m.content, m.file_url, m.file_type,
       m.is_read, m.read_at, m.timestamp,
       u.full_name  AS sender_name,
       u.avatar_url AS sender_avatar
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE (m.sender_id = ? AND m.receiver_id = ?)
        OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.timestamp ASC
     LIMIT ? OFFSET ?`,
    [userId, partnerId, partnerId, userId, limit, offset],
  );

  return res.json({
    success: true,
    partner,
    ...buildPaginationResponse({ data: messages, total, page, limit }),
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/chat/messages/:partner_id
// Send a message — text, file, or both.
// partner_id taken from URL param (not request body).
// ═══════════════════════════════════════════════════════════════
const sendMessage = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const partnerId = parseId(req.params.partner_id);
  if (!partnerId) throw new AppError("Invalid partner ID", 400);
  if (partnerId === userId)
    throw new AppError("Cannot send a message to yourself", 400);

  const { content } = req.body;
  if (!content?.trim() && !req.file) {
    throw new AppError("A message or file attachment is required", 400);
  }

  // File handling — MIME + path resolved by uploadMiddleware
  let file_url = null;
  let file_type = null;
  if (req.file) {
    file_url = `uploads/chat/${req.file.filename}`;
    file_type = resolveFileType(req.file.mimetype);
  }

  // Enforce messaging permissions
  await assertMessagingAllowed(userId, req.user.role, partnerId);

  const [result] = await db.execute(
    `INSERT INTO messages
       (sender_id, receiver_id, content, file_url, file_type, is_read, timestamp)
     VALUES (?, ?, ?, ?, ?, FALSE, NOW())`,
    [userId, partnerId, content?.trim() || null, file_url, file_type],
  );

  // Real-time delivery
  const io = req.app.get("io");
  if (io) {
    io.to(`user_${partnerId}`).emit("new_message", {
      id: result.insertId,
      sender_id: userId,
      receiver_id: partnerId,
      content: content?.trim() || null,
      file_url,
      file_type,
      is_read: false,
      timestamp: new Date().toISOString(),
      sender_name: req.user.full_name || req.user.username,
    });
  }

  // In-app notification — non-fatal
  await NotificationService.create({
    recipientId: partnerId,
    senderId: userId,
    type: "new_message",
    message: `New message from ${req.user.full_name || req.user.username}`,
    referenceId: result.insertId,
    groupedKey: `dm_${Math.min(userId, partnerId)}_${Math.max(userId, partnerId)}`,
    io,
  });

  await logActivity(
    userId,
    "message_sent",
    `Sent direct message to user ${partnerId} (ID: ${result.insertId})`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Message sent",
    message_id: result.insertId,
    file_url,
    file_type,
  });
});

// ═══════════════════════════════════════════════════════════════
// PATCH /api/chat/messages/:message_id/read
// Mark a single message as read — receiver only.
// ═══════════════════════════════════════════════════════════════
const markMessageRead = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const messageId = parseId(req.params.message_id);
  if (!messageId) throw new AppError("Invalid message ID", 400);

  const [result] = await db.execute(
    `UPDATE messages
     SET is_read = TRUE, read_at = NOW()
     WHERE id = ? AND receiver_id = ? AND is_read = FALSE`,
    [messageId, userId],
  );

  if (!result.affectedRows) {
    // Not found, not the receiver, or already read — all safe to ignore
    return res.json({
      success: true,
      message: "Message already read or not found",
    });
  }

  return res.json({ success: true, message: "Message marked as read" });
});

// ═══════════════════════════════════════════════════════════════
// PATCH /api/chat/messages/:partner_id/read-all
// Mark all unread messages from a partner as read.
// Only marks messages where current user is the receiver.
// ═══════════════════════════════════════════════════════════════
const markConversationRead = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const partnerId = parseId(req.params.partner_id);
  if (!partnerId) throw new AppError("Invalid partner ID", 400);

  const [result] = await db.execute(
    `UPDATE messages
     SET is_read = TRUE, read_at = NOW()
     WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE`,
    [partnerId, userId],
  );

  return res.json({
    success: true,
    message: "Conversation marked as read",
    updated: result.affectedRows,
  });
});

// ═══════════════════════════════════════════════════════════════
// DELETE /api/chat/messages/:message_id
// Sender soft-deletes their own message (nulls content + file refs).
// Row is kept for conversation thread continuity.
// ═══════════════════════════════════════════════════════════════
const deleteMessage = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const messageId = parseId(req.params.message_id);
  if (!messageId) throw new AppError("Invalid message ID", 400);

  const [[msg]] = await db.execute(
    `SELECT id, sender_id FROM messages WHERE id = ?`,
    [messageId],
  );
  if (!msg) throw new AppError("Message not found", 404);
  if (msg.sender_id !== userId)
    throw new AppError("You can only delete your own messages", 403);

  await db.execute(
    `UPDATE messages SET content = NULL, file_url = NULL, file_type = NULL WHERE id = ?`,
    [messageId],
  );

  return res.json({ success: true, message: "Message deleted" });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/chat/unread-count
// Total unread messages across all conversations.
// Used by the nav bar badge.
// ═══════════════════════════════════════════════════════════════
const getUnreadCount = asyncHandler(async (req, res) => {
  const [[{ unread }]] = await db.execute(
    `SELECT COUNT(*) AS unread FROM messages
     WHERE receiver_id = ? AND is_read = FALSE`,
    [req.user.id],
  );
  return res.json({ success: true, unread });
});

module.exports = {
  getConversations,
  fetchMessages,
  sendMessage,
  markMessageRead,
  markConversationRead,
  deleteMessage,
  getUnreadCount,
};
