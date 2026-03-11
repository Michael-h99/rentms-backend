// controllers/pushController.js
// ============================================================
// Handles all Web Push endpoints. Delegates storage and
// sending logic to pushService.js.
//
// Table used:  device_tokens  (one row per user — UNIQUE user_id)
//              push_logs      (one row per send attempt)
//
// Import path from routes:
//   require("../controllers/pushController")
// ============================================================

const db = require("../utils/db");
const pushService = require("../services/pushservice");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const { buildPaginationResponse } = require("../utils/pagination");

// ── Validate Web Push subscription shape ─────────────────────
const isValidSubscription = (sub) =>
  sub &&
  typeof sub === "object" &&
  typeof sub.endpoint === "string" &&
  sub.endpoint.length > 0 &&
  sub.keys &&
  typeof sub.keys.p256dh === "string" &&
  typeof sub.keys.auth === "string";

// ── POST /api/push/subscribe ─────────────────────────────────
// Save or update the Web Push subscription for the current user.
// Schema has UNIQUE on user_id — ON DUPLICATE KEY UPDATE handles refresh.
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
const saveSubscription = asyncHandler(async (req, res) => {
  const { subscription } = req.body;

  if (!isValidSubscription(subscription)) {
    throw new AppError(
      "Valid subscription object required with endpoint, keys.p256dh, and keys.auth",
      400,
    );
  }

  await pushService.saveSubscription(req.user.id, subscription);

  await logActivity(
    req.user.id,
    "notification_sent",
    "Push subscription saved",
    { ip: req.ip },
  );

  return res
    .status(201)
    .json({ success: true, message: "Subscription saved successfully" });
});

// ── DELETE /api/push/subscribe ───────────────────────────────
// Remove the push subscription for the current user.
// Called on logout or when the user turns off push notifications.
const removeSubscription = asyncHandler(async (req, res) => {
  const removed = await pushService.removeSubscriptionByUserId(req.user.id);

  if (!removed) {
    throw new AppError("No active subscription found for this account", 404);
  }

  await logActivity(
    req.user.id,
    "notification_cleared",
    "Push subscription removed",
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Subscription removed successfully",
  });
});

// ── GET /api/push/status ─────────────────────────────────────
// Check whether the current user has an active push subscription.
// Used by the frontend to show / hide the "Enable notifications" button.
const getSubscriptionStatus = asyncHandler(async (req, res) => {
  const subscribed = await pushService.hasSubscription(req.user.id);
  return res.json({ success: true, subscribed });
});

// ── POST /api/push/send ──────────────────────────────────────
// Send a push notification to a specific user.
// Landlords can notify their own tenants; admin can notify anyone.
// Body: { user_id, title, body, url? }
const sendPushToUser = asyncHandler(async (req, res) => {
  const webpush = req.app.get("webpush");
  if (!webpush)
    throw new AppError("Push notification service is not configured", 503);

  const { user_id, title, body, url } = req.body;
  if (!user_id || !title || !body) {
    throw new AppError("user_id, title, and body are required", 400);
  }

  const targetId = parseInt(user_id, 10);
  if (isNaN(targetId) || targetId <= 0)
    throw new AppError("Invalid user_id", 400);

  // Landlord ownership check — landlords can only push to their own tenants
  if (req.user.role === "landlord") {
    const [[{ count }]] = await db.execute(
      `SELECT COUNT(*) AS count
       FROM tenancies t
       JOIN plazas p ON p.id = t.plaza_id
       WHERE p.landlord_id = ? AND t.tenant_id = ? AND t.status = 'active'`,
      [req.user.id, targetId],
    );
    if (!count) throw new AppError("User not found or not your tenant", 403);
  } else {
    // Admin — just confirm user exists
    const [[{ exists }]] = await db.execute(
      `SELECT COUNT(*) AS exists FROM users WHERE id = ? AND deleted_at IS NULL`,
      [targetId],
    );
    if (!exists) throw new AppError("User not found", 404);
  }

  const result = await pushService.sendToUser(webpush, targetId, {
    title,
    body,
    url: url || "/",
  });

  if (result.sent === 0 && result.failed === 0) {
    return res.status(404).json({
      success: false,
      message: "User has no active push subscription",
    });
  }

  return res.json({
    success: true,
    message: "Push notification sent",
    sent: result.sent,
    failed: result.failed,
  });
});

// ── POST /api/push/broadcast ─────────────────────────────────
// Broadcast a push notification to ALL subscribed users.
// Admin only — platform-wide broadcast is too sensitive for landlords.
// Body: { title, body, url? }
const broadcastPush = asyncHandler(async (req, res) => {
  const webpush = req.app.get("webpush");
  if (!webpush)
    throw new AppError("Push notification service is not configured", 503);

  const { title, body, url } = req.body;
  if (!title || !body) throw new AppError("title and body are required", 400);

  const subs = await pushService.getAllSubscriptions();
  if (!subs.length) {
    return res
      .status(404)
      .json({ success: false, message: "No active subscriptions found" });
  }

  const result = await pushService.sendToAll(webpush, {
    title,
    body,
    url: url || "/",
  });

  await logActivity(
    req.user.id,
    "notification_sent",
    `Broadcast push: "${title}" → ${result.sent} sent, ${result.failed} failed`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Broadcast completed",
    total: result.total,
    sent: result.sent,
    failed: result.failed,
  });
});

// ── POST /api/push/send-to-plaza ─────────────────────────────
// Send a push notification to all active tenants in a plaza.
// Restricted to: landlord (own plazas only), admin
// Body: { plaza_id, title, body, url? }
const sendPushToPlaza = asyncHandler(async (req, res) => {
  const webpush = req.app.get("webpush");
  if (!webpush)
    throw new AppError("Push notification service is not configured", 503);

  const { plaza_id, title, body, url } = req.body;
  if (!plaza_id || !title || !body) {
    throw new AppError("plaza_id, title, and body are required", 400);
  }

  const plazaId = parseInt(plaza_id, 10);
  if (isNaN(plazaId) || plazaId <= 0)
    throw new AppError("Invalid plaza_id", 400);

  // Landlord must own this plaza
  if (req.user.role === "landlord") {
    const [[{ owns }]] = await db.execute(
      `SELECT COUNT(*) AS owns FROM plazas WHERE id = ? AND landlord_id = ? AND deleted_at IS NULL`,
      [plazaId, req.user.id],
    );
    if (!owns) throw new AppError("Plaza not found or access denied", 403);
  }

  // Get all active tenant IDs in this plaza
  const [tenants] = await db.execute(
    `SELECT DISTINCT t.tenant_id AS user_id
     FROM tenancies t WHERE t.plaza_id = ? AND t.status = 'active'`,
    [plazaId],
  );

  if (!tenants.length) {
    return res
      .status(404)
      .json({ success: false, message: "No active tenants in this plaza" });
  }

  const userIds = tenants.map((t) => t.user_id);
  const result = await pushService.sendToMany(webpush, userIds, {
    title,
    body,
    url: url || "/",
  });

  return res.json({
    success: true,
    message: "Plaza push completed",
    total_tenants: userIds.length,
    sent: result.sent,
    failed: result.failed,
  });
});

// ── GET /api/push/stats ──────────────────────────────────────
// Platform-wide push subscription statistics.
// Admin only.
const getPushStats = asyncHandler(async (req, res) => {
  const [[totals]] = await db.execute(
    `SELECT
       COUNT(*)                              AS total_subscriptions,
       COUNT(DISTINCT user_id)              AS total_users_subscribed
     FROM device_tokens`,
  );

  const [[recent]] = await db.execute(
    `SELECT COUNT(*) AS new_last_7_days
     FROM device_tokens
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
  );

  const [[pushTotals]] = await db.execute(
    `SELECT
       COUNT(*)                          AS total_sent_all_time,
       SUM(status = 'sent')              AS successful,
       SUM(status = 'failed')            AS failed,
       COUNT(CASE WHEN sent_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                  THEN 1 END)            AS sent_last_24h
     FROM push_logs`,
  );

  return res.json({
    success: true,
    subscriptions: {
      total: totals.total_subscriptions,
      users_subscribed: totals.total_users_subscribed,
      new_last_7_days: recent.new_last_7_days,
    },
    push_logs: {
      total_all_time: pushTotals.total_sent_all_time,
      successful: pushTotals.successful,
      failed: pushTotals.failed,
      sent_last_24h: pushTotals.sent_last_24h,
    },
  });
});

// ── GET /api/push/subscriptions ──────────────────────────────
// List active push subscriptions for admin debugging.
// Query params: page, limit, user_id?
const getSubscriptions = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const offset = (page - 1) * limit;
  const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;

  const conditions = [];
  const params = [];

  if (userId && !isNaN(userId)) {
    conditions.push("dt.user_id = ?");
    params.push(userId);
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM device_tokens dt ${WHERE}`,
    params,
  );

  const [rows] = await db.execute(
    `SELECT
       dt.id, dt.user_id, dt.last_used_at, dt.created_at,
       u.full_name  AS user_name,
       u.email      AS user_email,
       u.role       AS user_role
     FROM device_tokens dt
     JOIN users u ON u.id = dt.user_id
     ${WHERE}
     ORDER BY dt.last_used_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

module.exports = {
  saveSubscription,
  removeSubscription,
  getSubscriptionStatus,
  sendPushToUser,
  broadcastPush,
  sendPushToPlaza,
  getPushStats,
  getSubscriptions,
};
