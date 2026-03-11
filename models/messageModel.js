// models/messageModel.js
// ============================================================
// Pure static utility — no constructor needed.
// All methods interact with the `messages` table.
//
// Schema (rentms_full_schema.sql — Section 9):
//   messages.timestamp   : TIMESTAMP DEFAULT NOW()  (not created_at)
//   messages.file_type   : ENUM('image','pdf','doc','other') NULL
//   messages.is_read     : BOOLEAN DEFAULT FALSE
//   messages.read_at     : DATETIME NULL
//   — NO created_at column
//
// Soft-delete: Message.softDelete() nulls content + file_url/file_type.
// The row is kept for conversation thread continuity.
//
// Methods:
//   Message.create({ sender_id, receiver_id, content, file_url, file_type })
//   Message.getConversation(user1, user2, { page, limit })
//   Message.getUserConversations(userId)
//   Message.markMessageAsRead(messageId, receiverId)
//   Message.markConversationAsRead(senderId, receiverId)
//   Message.getUnreadCount(userId)
//   Message.softDelete(id, senderId)
// ============================================================

const db = require("../utils/db");

const DEFAULT_LIMIT = 30;

const VALID_FILE_TYPES = ["image", "pdf", "doc", "other"];

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

class Message {
  // ════════════════════════════════════════════════════════════
  // Message.create
  // Must have content or file_url (or both).
  // file_type must match schema ENUM if provided.
  // Returns the new message's insertId.
  // ════════════════════════════════════════════════════════════
  static async create({
    sender_id,
    receiver_id,
    content,
    file_url,
    file_type,
  }) {
    const senderId = parseId(sender_id);
    const receiverId = parseId(receiver_id);

    if (!senderId || !receiverId) {
      throw new Error("sender_id and receiver_id must be valid numeric IDs");
    }
    if (senderId === receiverId) {
      throw new Error("sender_id and receiver_id cannot be the same user");
    }
    if (!content?.trim() && !file_url) {
      throw new Error("Either content or file_url is required");
    }
    if (file_type && !VALID_FILE_TYPES.includes(file_type)) {
      throw new Error(
        `Invalid file_type. Must be: ${VALID_FILE_TYPES.join(", ")}`,
      );
    }

    const [result] = await db.execute(
      `INSERT INTO messages
         (sender_id, receiver_id, content, file_url, file_type, is_read, timestamp)
       VALUES (?, ?, ?, ?, ?, FALSE, NOW())`,
      [
        senderId,
        receiverId,
        content?.trim() || null,
        file_url || null,
        file_type || null,
      ],
    );

    return result.insertId;
  }

  // ════════════════════════════════════════════════════════════
  // Message.getConversation
  // Paginated thread between two users — oldest first for chat UI.
  // ════════════════════════════════════════════════════════════
  static async getConversation(
    user1,
    user2,
    { page = 1, limit = DEFAULT_LIMIT } = {},
  ) {
    const userId1 = parseId(user1);
    const userId2 = parseId(user2);
    if (!userId1 || !userId2)
      throw new Error("Both user IDs must be valid numeric IDs");

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM messages
       WHERE (sender_id = ? AND receiver_id = ?)
          OR (sender_id = ? AND receiver_id = ?)`,
      [userId1, userId2, userId2, userId1],
    );

    const [rows] = await db.query(
    `SELECT
         id, sender_id, receiver_id, content,
         file_url, file_type, is_read, read_at, timestamp
       FROM messages
       WHERE (sender_id = ? AND receiver_id = ?)
          OR (sender_id = ? AND receiver_id = ?)
       ORDER BY timestamp ASC
       LIMIT ? OFFSET ?`,
      [userId1, userId2, userId2, userId1, safeLimit, offset],
    );

    return {
      data: rows,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        total_pages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  // Message.getUserConversations
  // Latest message per conversation partner + unread count.
  // Uses correlated subquery — avoids LATERAL JOIN for MySQL 5.7 compat.
  // Returns partner full_name (not username).
  // ════════════════════════════════════════════════════════════
  static async getUserConversations(userId) {
    const uid = parseId(userId);
    if (!uid) throw new Error("Invalid user ID");

    // Step 1 — unique partner IDs
    const [partners] = await db.execute(
      `SELECT DISTINCT
         IF(sender_id = ?, receiver_id, sender_id) AS partner_id
       FROM messages
       WHERE sender_id = ? OR receiver_id = ?`,
      [uid, uid, uid],
    );

    if (!partners.length) return [];

    const partnerIds = partners.map((p) => p.partner_id);

    // Step 2 — partner user info
    const placeholders = partnerIds.map(() => "?").join(",");
    const [users] = await db.execute(
      `SELECT id, full_name, email, avatar_url, role
       FROM users WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      partnerIds,
    );
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    // Step 3 — latest message + unread count per partner
    const conversations = await Promise.all(
      partnerIds.map(async (partnerId) => {
        const [[latest]] = await db.execute(
          `SELECT id, content, file_type, timestamp, sender_id
           FROM messages
           WHERE (sender_id = ? AND receiver_id = ?)
              OR (sender_id = ? AND receiver_id = ?)
           ORDER BY timestamp DESC LIMIT 1`,
          [uid, partnerId, partnerId, uid],
        );

        const [[{ unread }]] = await db.execute(
          `SELECT COUNT(*) AS unread FROM messages
           WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE`,
          [partnerId, uid],
        );

        return {
          partner_id: partnerId,
          partner_name: userMap[partnerId]?.full_name ?? null,
          partner_email: userMap[partnerId]?.email ?? null,
          partner_avatar: userMap[partnerId]?.avatar_url ?? null,
          partner_role: userMap[partnerId]?.role ?? null,
          last_message_id: latest?.id ?? null,
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

    return conversations;
  }

  // ════════════════════════════════════════════════════════════
  // Message.markMessageAsRead
  // Only the receiver can mark a message as read.
  // receiverId guard prevents sender from marking own message read.
  // Returns true if updated, false if already read / not found.
  // ════════════════════════════════════════════════════════════
  static async markMessageAsRead(messageId, receiverId) {
    const msgId = parseId(messageId);
    const rId = parseId(receiverId);
    if (!msgId) throw new Error("Invalid message ID");
    if (!rId) throw new Error("receiverId must be a valid numeric ID");

    const [result] = await db.execute(
      `UPDATE messages
       SET is_read = TRUE, read_at = NOW()
       WHERE id = ? AND receiver_id = ? AND is_read = FALSE`,
      [msgId, rId],
    );

    return result.affectedRows > 0;
  }

  // ════════════════════════════════════════════════════════════
  // Message.markConversationAsRead
  // Marks all unread messages from senderId to receiverId as read.
  // Returns count of messages updated.
  // ════════════════════════════════════════════════════════════
  static async markConversationAsRead(senderId, receiverId) {
    const sId = parseId(senderId);
    const rId = parseId(receiverId);
    if (!sId || !rId)
      throw new Error(
        "Both sender_id and receiver_id must be valid numeric IDs",
      );

    const [result] = await db.execute(
      `UPDATE messages
       SET is_read = TRUE, read_at = NOW()
       WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE`,
      [sId, rId],
    );

    return result.affectedRows;
  }

  // ════════════════════════════════════════════════════════════
  // Message.getUnreadCount
  // Total unread messages for a user across all conversations.
  // ════════════════════════════════════════════════════════════
  static async getUnreadCount(userId) {
    const uid = parseId(userId);
    if (!uid) throw new Error("Invalid user ID");

    const [[{ unread }]] = await db.execute(
      `SELECT COUNT(*) AS unread FROM messages
       WHERE receiver_id = ? AND is_read = FALSE`,
      [uid],
    );

    return unread;
  }

  // ════════════════════════════════════════════════════════════
  // Message.softDelete
  // Sender retracts their own message — nulls content + file fields.
  // The row is kept so the conversation thread remains intact.
  // senderId guard ensures only the sender can retract.
  // ════════════════════════════════════════════════════════════
  static async softDelete(id, senderId) {
    const msgId = parseId(id);
    const sId = parseId(senderId);
    if (!msgId) throw new Error("Invalid message ID");
    if (!sId) throw new Error("senderId must be a valid numeric ID");

    const [result] = await db.execute(
      `UPDATE messages
       SET content = NULL, file_url = NULL, file_type = NULL
       WHERE id = ? AND sender_id = ?`,
      [msgId, sId],
    );

    if (!result.affectedRows)
      throw new Error("Message not found or you are not the sender");
    return true;
  }
}

module.exports = Message;
