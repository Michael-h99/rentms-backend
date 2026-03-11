// pushService.js
// ============================================================
// Web Push service — manages device_tokens and push_logs tables.
// Uses the webpush instance set on app via app.set("webpush").
//
// Schema tables used:
//   device_tokens  — one subscription per user (UNIQUE user_id)
//   push_logs      — audit log of every push attempt
// ============================================================

const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

// ── saveSubscription ─────────────────────────────────────────
// Save or update a browser push subscription for a user.
// Schema has UNIQUE KEY on user_id so ON DUPLICATE KEY UPDATE
// replaces the old subscription (e.g. after browser reinstall).
// Also updates last_used_at to track activity.
//
// Usage:
//   await pushService.saveSubscription(req.user.id, req.body.subscription);
const saveSubscription = async (userId, subscription) => {
  const uid = parseId(userId);
  if (!uid) throw new AppError("Invalid user ID", 400);

  if (!subscription || typeof subscription !== "object") {
    throw new AppError("Invalid push subscription object", 400);
  }
  if (!subscription.endpoint) {
    throw new AppError("Push subscription must include an endpoint", 400);
  }

  await db.execute(
    `INSERT INTO device_tokens (user_id, subscription, last_used_at, created_at)
     VALUES (?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       subscription  = VALUES(subscription),
       last_used_at  = NOW()`,
    [uid, JSON.stringify(subscription)],
  );

  return true;
};

// ── getUserSubscription ──────────────────────────────────────
// Get the single push subscription for a user.
// Returns null if the user has no subscription.
//
// Usage:
//   const sub = await pushService.getUserSubscription(userId);
const getUserSubscription = async (userId) => {
  const uid = parseId(userId);
  if (!uid) throw new AppError("Invalid user ID", 400);

  const [rows] = await db.execute(
    `SELECT id, user_id, subscription, last_used_at, created_at
     FROM device_tokens
     WHERE user_id = ?`,
    [uid],
  );

  if (!rows.length) return null;

  const row = rows[0];
  return {
    ...row,
    subscription:
      typeof row.subscription === "string"
        ? JSON.parse(row.subscription)
        : row.subscription,
  };
};

// ── getAllSubscriptions ──────────────────────────────────────
// Get all active push subscriptions — used for broadcast pushes.
// Returns parsed subscription objects ready for webpush.sendNotification().
//
// Usage:
//   const subs = await pushService.getAllSubscriptions();
const getAllSubscriptions = async () => {
  const [rows] = await db.execute(
    `SELECT id, user_id, subscription, last_used_at
     FROM device_tokens
     ORDER BY last_used_at DESC`,
  );

  return rows.map((row) => ({
    ...row,
    subscription:
      typeof row.subscription === "string"
        ? JSON.parse(row.subscription)
        : row.subscription,
  }));
};

// ── getSubscriptionsByUserIds ────────────────────────────────
// Get push subscriptions for a list of user IDs.
// Used for targeted group pushes (e.g. all tenants in a plaza).
//
// Usage:
//   const subs = await pushService.getSubscriptionsByUserIds([1, 2, 3]);
const getSubscriptionsByUserIds = async (userIds) => {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];

  const validIds = userIds.map(parseId).filter(Boolean);
  if (validIds.length === 0) return [];

  const placeholders = validIds.map(() => "?").join(", ");
  const [rows] = await db.execute(
    `SELECT id, user_id, subscription
     FROM device_tokens
     WHERE user_id IN (${placeholders})`,
    validIds,
  );

  return rows.map((row) => ({
    ...row,
    subscription:
      typeof row.subscription === "string"
        ? JSON.parse(row.subscription)
        : row.subscription,
  }));
};

// ── removeSubscription ───────────────────────────────────────
// Remove a push subscription by device_tokens.id.
// Called when webpush returns 410 Gone (subscription expired/revoked).
//
// Usage:
//   await pushService.removeSubscription(tokenId);
const removeSubscription = async (id) => {
  const tokenId = parseId(id);
  if (!tokenId) throw new AppError("Invalid token ID", 400);

  await db.execute(`DELETE FROM device_tokens WHERE id = ?`, [tokenId]);
  return true;
};

// ── removeSubscriptionByUserId ───────────────────────────────
// Remove a user's push subscription when they log out or
// explicitly unsubscribe from notifications.
//
// Usage:
//   await pushService.removeSubscriptionByUserId(req.user.id);
const removeSubscriptionByUserId = async (userId) => {
  const uid = parseId(userId);
  if (!uid) throw new AppError("Invalid user ID", 400);

  await db.execute(`DELETE FROM device_tokens WHERE user_id = ?`, [uid]);
  return true;
};

// ── logPush ──────────────────────────────────────────────────
// Insert a record into push_logs after each send attempt.
// Non-fatal — logging failures are swallowed.
//
// Usage (internal):
//   await logPush(userId, notificationId, "sent");
//   await logPush(userId, null, "failed", err.message);
const logPush = async (
  userId,
  notificationId = null,
  status,
  errorMessage = null,
) => {
  const uid = parseId(userId);
  if (!uid || !["sent", "failed"].includes(status)) return;

  try {
    await db.execute(
      `INSERT INTO push_logs
         (user_id, notification_id, status, error_message, sent_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [
        uid,
        notificationId ? parseId(notificationId) : null,
        status,
        errorMessage || null,
      ],
    );
  } catch (err) {
    console.error("❌ pushService.logPush failed:", err.message);
  }
};

// ── sendToUser ───────────────────────────────────────────────
// Send a push notification to a single user.
// Handles 410 Gone by auto-removing the stale subscription.
// Logs every attempt to push_logs.
//
// @param {object} webpush        — from req.app.get("webpush")
// @param {number} userId         — target user
// @param {object} payload        — { title, body, icon, url }
// @param {number} notificationId — optional linked notifications.id
//
// Usage:
//   const webpush = req.app.get("webpush");
//   await pushService.sendToUser(webpush, userId, { title, body, url });
const sendToUser = async (webpush, userId, payload, notificationId = null) => {
  if (!webpush) {
    console.warn("⚠️  pushService.sendToUser: webpush not configured");
    return { sent: 0, failed: 0 };
  }

  const sub = await getUserSubscription(userId);
  if (!sub) return { sent: 0, failed: 0 };

  const pushPayload = JSON.stringify({
    title: payload.title || "RentMS Notification",
    body: payload.body || "",
    icon: payload.icon || "/assets/images/favicon.png",
    badge: payload.badge || "/assets/images/favicon.png",
    url: payload.url || "/",
    data: payload.data || {},
  });

  try {
    await webpush.sendNotification(sub.subscription, pushPayload);
    await logPush(userId, notificationId, "sent");
    // Update last_used_at
    await db.execute(
      `UPDATE device_tokens SET last_used_at = NOW() WHERE user_id = ?`,
      [parseId(userId)],
    );
    return { sent: 1, failed: 0 };
  } catch (err) {
    // 410 Gone or 404 = subscription is no longer valid — remove it
    if (err.statusCode === 410 || err.statusCode === 404) {
      await removeSubscription(sub.id);
      console.log(`🗑️  Removed stale push subscription for user ${userId}`);
    }
    await logPush(userId, notificationId, "failed", err.message);
    console.error(`❌ Push failed for user ${userId}:`, err.message);
    return { sent: 0, failed: 1 };
  }
};

// ── sendToMany ───────────────────────────────────────────────
// Send a push notification to multiple users.
// Runs all sends concurrently and returns a summary.
//
// Usage:
//   const result = await pushService.sendToMany(webpush, [1,2,3], { title, body });
const sendToMany = async (webpush, userIds, payload, notificationId = null) => {
  if (!webpush || !Array.isArray(userIds) || userIds.length === 0) {
    return { sent: 0, failed: 0, total: 0 };
  }

  const results = await Promise.allSettled(
    userIds.map((uid) => sendToUser(webpush, uid, payload, notificationId)),
  );

  let sent = 0,
    failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      sent += r.value.sent;
      failed += r.value.failed;
    } else {
      failed++;
    }
  }

  return { sent, failed, total: userIds.length };
};

// ── sendToAll ────────────────────────────────────────────────
// Broadcast a push notification to all subscribed users.
// Used for system-wide announcements.
//
// Usage:
//   await pushService.sendToAll(webpush, { title: "System Update", body: "..." });
const sendToAll = async (webpush, payload, notificationId = null) => {
  if (!webpush) return { sent: 0, failed: 0, total: 0 };

  const subs = await getAllSubscriptions();
  if (subs.length === 0) return { sent: 0, failed: 0, total: 0 };

  const userIds = subs.map((s) => s.user_id);
  return sendToMany(webpush, userIds, payload, notificationId);
};

// ── hasSubscription ──────────────────────────────────────────
// Check if a user has an active push subscription.
//
// Usage:
//   const subscribed = await pushService.hasSubscription(userId);
const hasSubscription = async (userId) => {
  const uid = parseId(userId);
  if (!uid) return false;

  const [[{ count }]] = await db.execute(
    `SELECT COUNT(*) AS count FROM device_tokens WHERE user_id = ?`,
    [uid],
  );
  return count > 0;
};

module.exports = {
  saveSubscription,
  getUserSubscription,
  getAllSubscriptions,
  getSubscriptionsByUserIds,
  removeSubscription,
  removeSubscriptionByUserId,
  sendToUser,
  sendToMany,
  sendToAll,
  hasSubscription,
  logPush,
};
