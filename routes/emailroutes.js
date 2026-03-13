// routes/emailRoutes.js
// ============================================================
// Base path: /api/email
// All routes require a valid JWT.
//
// Endpoints:
//   POST  /api/email/notify              — admin only
//   POST  /api/email/payment-reminder    — admin, landlord
//   POST  /api/email/bulk-reminder       — admin, landlord
//   POST  /api/email/tenancy-alert       — admin, landlord
//   POST  /api/email/lease-expiry-digest — admin, landlord
//   POST  /api/email/resend/:log_id      — admin only
//   GET   /api/email/stats               — admin only
//   GET   /api/email/logs                — admin only
//
// Rate limiting:
//   All send routes use notificationLimiter (30 req/hour per IP).
//   This is the most abuse-prone resource — every request
//   triggers an outbound SMTP connection.
//
// Route ordering note:
//   Static paths (/notify, /stats, /logs, etc.) are declared
//   before parameterised paths (/resend/:log_id) to prevent
//   Express matching a keyword as a log ID.
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
  sendNotificationEmail,
  sendPaymentReminder,
  sendBulkPaymentReminders,
  sendTenancyAlert,
  sendLeaseExpiryDigest,
  resendFailedEmail,
  getEmailStats,
  getEmailLogs,
} = require("../controllers/emailcontroller");

// ── Global Protection ────────────────────────────────────────
// All email routes require a valid JWT — 401 if missing/expired
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════
// SEND ROUTES — static paths first
// ════════════════════════════════════════════════════════════

/**
 * POST /api/email/notify
 * Send a custom notification email to any user by ID.
 * Admin only — arbitrary email to any user is too sensitive for landlords.
 * Body: { user_id, subject, message, notification_id? }
 * Rate limited.
 */
router.post(
  "/notify",
  roleMiddleware(["admin"]),
  notificationLimiter,
  sendNotificationEmail,
);

/**
 * POST /api/email/payment-reminder
 * Send a payment reminder email to a single active tenant.
 * Landlord must own the tenancy's plaza (enforced in controller).
 * Cooldown: 60 min between reminders of the same type per tenant.
 * Body: { tenancy_id }
 * Rate limited.
 */
router.post(
  "/payment-reminder",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  sendPaymentReminder,
);

/**
 * POST /api/email/bulk-reminder
 * Send payment reminders to all active tenants — landlord's own plazas,
 * or all plazas for admin.
 * Each tenant has a 60-min cooldown (skipped if already sent recently).
 * Body: { plaza_id? }  — omit for all plazas (admin only without restriction)
 * Rate limited — one bulk send counts as one request against the limit.
 */
router.post(
  "/bulk-reminder",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  sendBulkPaymentReminders,
);

/**
 * POST /api/email/tenancy-alert
 * Send a tenancy status alert (expiring, renewed, or update) to a tenant.
 * Landlord must own the tenancy's plaza (enforced in controller).
 * Cooldown: 60 min between alerts of the same type per tenant.
 * Body: { tenancy_id, alert_type }
 *   alert_type: "lease_expiring" | "lease_renewed" | "tenancy_update"
 * Rate limited.
 */
router.post(
  "/tenancy-alert",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  sendTenancyAlert,
);

/**
 * POST /api/email/lease-expiry-digest
 * Batch-send lease expiry notices to all tenants whose leases
 * expire within N days. Designed for scheduled cron use or manual trigger.
 * Each tenant has a 60-min cooldown (skipped if already sent recently).
 * Body: { days_ahead? (1–90, default 30), plaza_id? }
 * Rate limited.
 */
router.post(
  "/lease-expiry-digest",
  roleMiddleware(["admin", "landlord"]),
  notificationLimiter,
  sendLeaseExpiryDigest,
);

// ════════════════════════════════════════════════════════════
// ADMIN — Stats + Logs
// Static paths declared before /resend/:log_id
// ════════════════════════════════════════════════════════════

/**
 * GET /api/email/stats
 * Platform-wide email delivery statistics.
 * Returns total sent/failed, last 24h and 7d counts,
 * and a breakdown by inferred email type.
 * Admin only.
 */
router.get("/stats", roleMiddleware(["admin"]), getEmailStats);

/**
 * GET /api/email/logs
 * Paginated email send history from email_logs.
 * Uses schema-aligned columns: sent_at, subject, error_message.
 * Query params: page, limit,
 *               user_id, status ("sent"|"failed"),
 *               from (YYYY-MM-DD), to (YYYY-MM-DD)
 * Admin only.
 */
router.get("/logs", roleMiddleware(["admin"]), generalLimiter, getEmailLogs);

// ════════════════════════════════════════════════════════════
// PARAMETERISED ROUTES — declared after all static paths
// ════════════════════════════════════════════════════════════

/**
 * POST /api/email/resend/:log_id
 * Retry a previously failed email by its email_logs ID.
 * Sends a re-delivery to the same address with a [Resent] subject prefix.
 * Returns 400 if the log entry status is not "failed".
 * Admin only.
 * Rate limited.
 */
router.post(
  "/resend/:log_id",
  roleMiddleware(["admin"]),
  notificationLimiter,
  resendFailedEmail,
);

module.exports = router;



