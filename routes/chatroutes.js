// routes/chatRoutes.js
// ============================================================
// Base path: /api/chat
// All routes require a valid JWT. All roles can access chat.
//
// Endpoints:
//   GET    /api/chat/unread-count                    — all roles
//   GET    /api/chat/conversations                   — all roles
//   GET    /api/chat/messages/:partner_id            — all roles
//   POST   /api/chat/messages/:partner_id            — all roles
//   DELETE /api/chat/messages/:message_id            — all roles (own only)
//   PATCH  /api/chat/messages/:message_id/read       — all roles
//   PATCH  /api/chat/messages/:partner_id/read-all   — all roles
//
// Route ordering note:
//   Static paths (/unread-count, /conversations) are declared
//   before parameterised paths (/messages/:id) to prevent
//   Express matching a keyword as an ID.
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const { uploadLimiter } = require("../middleware/ratelimitMiddleware");
const { upload, handleUploadError } = require("../middleware/uploadMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  getConversations,
  fetchMessages,
  sendMessage,
  markMessageRead,
  markConversationRead,
  deleteMessage,
  getUnreadCount,
} = require("../controllers/chatcontroller");

// ── Global Protection ────────────────────────────────────────
// All chat routes require a valid JWT — 401 if missing/expired
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════
// STATIC PATHS — declared before parameterised routes
// ════════════════════════════════════════════════════════════

/**
 * GET /api/chat/unread-count
 * Total unread messages across all conversations.
 * Used by the nav bar badge to display a notification dot.
 * Returns: { unread: <number> }
 */
router.get("/unread-count", getUnreadCount);

/**
 * GET /api/chat/conversations
 * All conversation partners for the authenticated user.
 * For each partner: last message, file type, timestamp, unread count.
 * Partners with no messages are excluded.
 * Sorted by most recent message descending.
 */
router.get("/conversations", getConversations);

// ════════════════════════════════════════════════════════════
// MESSAGES — parameterised routes
// ════════════════════════════════════════════════════════════

/**
 * GET /api/chat/messages/:partner_id
 * Paginated message thread between the current user and a partner.
 * Ordered oldest → newest for chat UI rendering.
 * Also returns the partner's profile (name, avatar, role).
 * Query params: page, limit
 */
router.get("/messages/:partner_id", fetchMessages);

/**
 * POST /api/chat/messages/:partner_id
 * Send a message to a user — text, file, or both.
 * Messaging permissions enforced in controller:
 *   Tenant   → only their plaza's landlord
 *   Landlord → only their own active tenants or any admin
 *   Admin    → anyone
 * Body: { content? } + optional file field "file"
 * File: MIME validated by uploadMiddleware, 10 MB max,
 *       stored at uploads/chat/<filename>
 *       file_type resolved to: image | pdf | doc | other
 * Emits "new_message" via Socket.io to the partner's user room.
 * Sends an in-app notification (non-fatal).
 * Rate limited — prevents message flooding.
 */
router.post(
  "/messages/:partner_id",
  uploadLimiter,
  upload.chat.single("file"),
  handleUploadError,
  sendMessage,
);

/**
 * DELETE /api/chat/messages/:message_id
 * Soft-delete a message — sender only.
 * Nulls content, file_url, and file_type.
 * Row is kept for conversation thread continuity.
 * Returns 403 if the message does not belong to the current user.
 */
router.delete("/messages/:message_id", deleteMessage);

/**
 * PATCH /api/chat/messages/:message_id/read
 * Mark a single message as read.
 * Sets is_read = TRUE and read_at = NOW().
 * Only the receiver can mark a message as read.
 * Returns 200 (not 404) if already read — idempotent.
 */
router.patch("/messages/:message_id/read", markMessageRead);

/**
 * PATCH /api/chat/messages/:partner_id/read-all
 * Mark all unread messages from a specific partner as read.
 * Only marks messages where the current user is the receiver.
 * Returns: { updated: <count> }
 */
router.patch("/messages/:partner_id/read-all", markConversationRead);

// ── Upload error handler ─────────────────────────────────────
// Must come after all routes that use upload middleware.
// Catches Multer errors and INVALID_FILE_TYPE before the global handler.
router.use(handleUploadError);

module.exports = router;


