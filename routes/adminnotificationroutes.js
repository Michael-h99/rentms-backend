// routes/adminNotificationRoutes.js
// ============================================================
// Base path: /api/admin/notifications
// All routes require valid JWT + admin role.
//
// Endpoints:
//   GET  /api/admin/notifications/stats          — summary stats
//   GET  /api/admin/notifications/platform-stats — per-type breakdown
//   GET  /api/admin/notifications/all            — paginated full log
//   GET  /api/admin/notifications/daily-trend    — chart data
//   GET  /api/admin/notifications/engagement     — read rates by type
//   POST /api/admin/notifications/send           — send to specific user
//   POST /api/admin/notifications/broadcast      — send to all active users
//
// Rate limiting:
//   GET routes  — generalLimiter (200 req/10 min) — analytics reads
//   POST routes — notificationLimiter (30 req/hr) — prevent send abuse
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

// ── Analytics controllers (adminNotificationController) ──────
const {
  getNotificationStats,
  getDailyNotificationTrend,
  getEngagementMetrics,
} = require("../controllers/adminNotificationController");

// ── Core notification controllers (notificationController) ───
const {
  sendNotification,
  broadcastNotification,
  getAdminNotificationStats,
  getAllNotificationsAdmin,
} = require("../controllers/notificationcontroller");

// ── Global Protection ────────────────────────────────────────
// All routes require valid JWT (401) + admin role (403)
router.use(authMiddleware);
router.use(roleMiddleware(["admin"]));

// ════════════════════════════════════════════════════════════
// GET — Analytics + Logs (generalLimiter — read-only)
// Static paths declared before parameterised routes.
// ════════════════════════════════════════════════════════════

/**
 * GET /api/admin/notifications/stats
 * Overall notification counts with read rate breakdown.
 * Filterable by type, user_id, from/to date range.
 * Query params: type, user_id, plaza_id, from, to
 * Source: adminNotificationController (dedicated analytics queries)
 */
router.get("/stats", generalLimiter, getNotificationStats);

/**
 * GET /api/admin/notifications/platform-stats
 * Platform-wide stats grouped by notification type.
 * Returns total, unread, read count, read_rate_percentage,
 * and last-24h volume per type.
 * Source: notificationController (getAdminNotificationStats)
 */
router.get("/platform-stats", generalLimiter, getAdminNotificationStats);

/**
 * GET /api/admin/notifications/all
 * Paginated cross-user notification log.
 * Query params: page, limit, type, recipient_id, unread (true/false)
 * Source: notificationController (getAllNotificationsAdmin)
 */
router.get("/all", generalLimiter, getAllNotificationsAdmin);

/**
 * GET /api/admin/notifications/daily-trend
 * Daily notification volume trend for dashboard charts.
 * Query params: days (1–90, default 7), from, to, type
 * Source: adminNotificationController
 */
router.get("/daily-trend", generalLimiter, getDailyNotificationTrend);

/**
 * GET /api/admin/notifications/engagement
 * Read rates and engagement metrics broken down by type.
 * Query params: from, to, type
 * Source: adminNotificationController
 */
router.get("/engagement", generalLimiter, getEngagementMetrics);

// ════════════════════════════════════════════════════════════
// POST — Send (notificationLimiter — outbound, abuse-prone)
// ════════════════════════════════════════════════════════════

/**
 * POST /api/admin/notifications/send
 * Send a notification to a specific user.
 * Body: { recipient_id, type, message, reference_id? }
 *   type: one of the schema-aligned notification types
 * Source: notificationController (sendNotification)
 * Rate limited.
 */
router.post("/send", notificationLimiter, sendNotification);

/**
 * POST /api/admin/notifications/broadcast
 * Send a notification to all active non-admin users platform-wide.
 * Body: { type, message, reference_id? }
 * Uses NotificationService.createBulk — efficient batch insert.
 * Source: notificationController (broadcastNotification)
 * Rate limited — single call can trigger thousands of rows.
 */
router.post("/broadcast", notificationLimiter, broadcastNotification);

module.exports = router;
