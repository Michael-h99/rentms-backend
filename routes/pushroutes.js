// routes/pushRoutes.js
// ============================================================
// Base path: /api/push
// All routes require a valid JWT.
// Role restrictions are applied per-route, not globally.
//
// Endpoints:
//   POST   /api/push/subscribe           — all roles (save sub)
//   DELETE /api/push/subscribe           — all roles (remove sub)
//   GET    /api/push/status              — all roles (check if subscribed)
//   POST   /api/push/send                — admin, landlord
//   POST   /api/push/send-to-plaza       — admin, landlord
//   POST   /api/push/broadcast           — admin only
//   GET    /api/push/stats               — admin only
//   GET    /api/push/subscriptions       — admin only
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
  saveSubscription,
  removeSubscription,
  getSubscriptionStatus,
  sendPushToUser,
  broadcastPush,
  sendPushToPlaza,
  getPushStats,
  getSubscriptions,
} = require("../controllers/pushController");

// ── Global Protection ────────────────────────────────────────
// All push routes require a valid JWT — 401 if missing/expired
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════
// SUBSCRIPTION MANAGEMENT
// All authenticated users can manage their own subscription
// ════════════════════════════════════════════════════════════

/**
 * POST /api/push/subscribe
 * Save or refresh the Web Push subscription for the current user.
 * Schema has UNIQUE on user_id — re-subscribing replaces the old entry.
 * Body: { subscription: { endpoint, keys: { p256dh, auth } } }
 */
router.post("/subscribe", saveSubscription);

/**
 * DELETE /api/push/subscribe
 * Remove the push subscription for the current user.
 * Called on logout or when the user turns off notifications.
 * Returns 404 if no subscription exists for this account.
 */
router.delete("/subscribe", removeSubscription);

/**
 * GET /api/push/status
 * Check whether the current user has an active push subscription.
 * Used by the frontend to toggle the "Enable notifications" button.
 * Returns: { subscribed: true | false }
 */
router.get("/status", getSubscriptionStatus);

// ════════════════════════════════════════════════════════════
// SEND — Admin + Landlord
// ════════════════════════════════════════════════════════════

/**
 * POST /api/push/send
 * Send a push notification to a specific user by ID.
 * Landlords are restricted to their own active tenants (enforced in controller).
 * Admins can target any user.
 * Body: { user_id, title, body, url? }
 * Rate limited — prevents notification spam.
 */
router.post(
  "/send",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  sendPushToUser,
);

/**
 * POST /api/push/send-to-plaza
 * Send a push notification to all active tenants in a specific plaza.
 * Landlords must own the plaza (enforced in controller).
 * Body: { plaza_id, title, body, url? }
 * Rate limited.
 */
router.post(
  "/send-to-plaza",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  sendPushToPlaza,
);

/**
 * POST /api/push/broadcast
 * Broadcast a push notification to ALL subscribed users platform-wide.
 * Admin only — too sensitive for landlords.
 * Body: { title, body, url? }
 * Rate limited — each broadcast hits every subscribed device.
 */
router.post(
  "/broadcast",
  roleMiddleware(["admin"]),
  notificationLimiter,
  broadcastPush,
);

// ════════════════════════════════════════════════════════════
// ADMIN — Stats + Subscription viewer
// ════════════════════════════════════════════════════════════

/**
 * GET /api/push/stats
 * Platform-wide push statistics.
 * Returns subscription counts and push_logs success/failure totals.
 * Admin only.
 */
router.get("/stats", roleMiddleware(["admin"]), getPushStats);

/**
 * GET /api/push/subscriptions
 * Paginated list of active device_tokens for admin debugging.
 * Query params: page, limit, user_id?
 * Admin only.
 */
router.get(
  "/subscriptions",
  roleMiddleware(["admin"]),
  generalLimiter,
  getSubscriptions,
);

module.exports = router;
