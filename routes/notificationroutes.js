// routes/notificationRoutes.js
// ============================================================
// Base path: /api/notifications
// All routes require a valid JWT.
//
// Endpoints:
//   POST   /api/notifications/send                     — admin, landlord
//   POST   /api/notifications/broadcast                — admin, landlord
//   GET    /api/notifications                          — all roles
//   GET    /api/notifications/grouped                  — all roles
//   GET    /api/notifications/filter                   — all roles
//   GET    /api/notifications/unread-count             — all roles
//   PATCH  /api/notifications/read-all                 — all roles
//   PATCH  /api/notifications/read-type/:type          — all roles
//   PATCH  /api/notifications/:notification_id/read    — all roles
//   DELETE /api/notifications/clear-all                — all roles
//   DELETE /api/notifications/:notification_id         — all roles
//   GET    /api/notifications/admin/stats              — admin only
//   GET    /api/notifications/admin/all                — admin only
//
// Route ordering note:
//   Static paths (/send, /broadcast, /grouped, /filter,
//   /unread-count, /read-all, /admin/*) MUST be declared
//   before parameterised paths (/:notification_id) to prevent
//   Express matching a keyword as a notification ID.
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const { roleMiddleware } = require("../middleware/roleMiddleware");
const {
  notificationLimiter,
  generalLimiter,
} = require("../middleware/ratelimitMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  sendNotification,
  broadcastNotification,
  getMyNotifications,
  getGroupedNotifications,
  filterByType,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  markTypeAsRead,
  deleteNotification,
  clearAllNotifications,
  getAdminNotificationStats,
  getAllNotificationsAdmin,
} = require("../controllers/notificationcontroller");

// ── Global Protection ────────────────────────────────────────
// All notification routes require a valid JWT — 401 if missing/expired
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════
// SEND — Admin + Landlord
// ════════════════════════════════════════════════════════════

/**
 * POST /api/notifications/send
 * Send a notification to a specific user.
 * Landlords can only notify their own active tenants (enforced in controller).
 * Body: { recipient_id, type, message, reference_id? }
 * Rate limited — prevents notification spam.
 */
router.post(
  "/send",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  sendNotification,
);

/**
 * POST /api/notifications/broadcast
 * Send the same notification to multiple recipients at once.
 * Landlord: requires plaza_id — notifies all active tenants in that plaza.
 * Admin: notifies all active non-admin users platform-wide.
 * Body: { type, message, plaza_id? (landlord only), reference_id? }
 * Rate limited.
 */
router.post(
  "/broadcast",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  broadcastNotification,
);

// ════════════════════════════════════════════════════════════
// ADMIN — Stats + Full list
// Declared before /:notification_id to avoid param collision
// ════════════════════════════════════════════════════════════

/**
 * GET /api/notifications/admin/stats
 * Platform-wide notification breakdown by type.
 * Includes total, unread, read count, read rate %, and last 24h volume.
 * Admin only.
 */
router.get(
  "/admin/stats",
  roleMiddleware(["admin"]),
  getAdminNotificationStats,
);

/**
 * GET /api/notifications/admin/all
 * Paginated list of all notifications across all users.
 * Query params: page, limit, type, recipient_id, unread (true/false)
 * Admin only.
 */
router.get(
  "/admin/all",
  roleMiddleware(["admin"]),
  generalLimiter,
  getAllNotificationsAdmin,
);

// ════════════════════════════════════════════════════════════
// READ — Current user's own notifications
// All authenticated roles — scoped to req.user.id in controller
// ════════════════════════════════════════════════════════════

/**
 * GET /api/notifications
 * Paginated list of the current user's notifications.
 * Expired notifications excluded automatically.
 * Query params: page, limit, unread (true returns unread only)
 */
router.get("/", getMyNotifications);

/**
 * GET /api/notifications/grouped
 * Notifications collapsed by grouped_key for the notification centre UI.
 * Returns: grouped_key, type, total count, unread count, latest timestamp.
 */
router.get("/grouped", getGroupedNotifications);

/**
 * GET /api/notifications/filter
 * Filter the current user's notifications by type, paginated.
 * Query params: type (required), page, limit
 * Valid types: new_message, maintenance_request, maintenance_update,
 *              payment_reminder, payment_received, payment_failed,
 *              lease_expiring, lease_renewed, tenancy_update,
 *              new_tenant, invite_code, announcement, general
 */
router.get("/filter", filterByType);

/**
 * GET /api/notifications/unread-count
 * Fast badge count for the nav bar.
 * Returns: { unread: <number> }
 */
router.get("/unread-count", getUnreadCount);

// ════════════════════════════════════════════════════════════
// MARK AS READ — bulk static routes before parameterised
// ════════════════════════════════════════════════════════════

/**
 * PATCH /api/notifications/read-all
 * Mark all unread notifications as read for the current user.
 * Returns: { updated: <count> }
 */
router.patch("/read-all", markAllAsRead);

/**
 * PATCH /api/notifications/read-type/:type
 * Mark all unread notifications of a specific type as read.
 * Useful when the user navigates to a relevant page (e.g. opening
 * the payments tab clears all payment_received notifications).
 * Returns: { updated: <count> }
 */
router.patch("/read-type/:type", markTypeAsRead);

/**
 * PATCH /api/notifications/:notification_id/read
 * Mark a single notification as read.
 * Scoped to the current user — returns 404 if not owned.
 */
router.patch("/:notification_id/read", markAsRead);

// ════════════════════════════════════════════════════════════
// DELETE — static routes before parameterised
// ════════════════════════════════════════════════════════════

/**
 * DELETE /api/notifications/clear-all
 * Delete all notifications for the current user.
 * Returns: { deleted: <count> }
 */
router.delete("/clear-all", clearAllNotifications);

/**
 * DELETE /api/notifications/:notification_id
 * Delete a single notification — current user only.
 * Returns 404 if not found or not owned.
 */
router.delete("/:notification_id", deleteNotification);

module.exports = router;

