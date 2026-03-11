// controllers/emailController.js
// ============================================================
// All email endpoints — sends via Nodemailer transporter
// stored on app (app.set("transporter", ...)) and logs every
// attempt to email_logs.
//
// Schema (rentms_full_schema.sql — Section 11):
//   email_logs.status       : ENUM('sent','failed')
//   email_logs.sent_at      : TIMESTAMP (not created_at)
//   email_logs.subject      : VARCHAR(255)
//   email_logs.error_message: TEXT
//   tenancies.status        : ENUM('active','expired')
//   tenancies.lease_end     : DATE  (no due_date column)
//   users.full_name         : VARCHAR(150) NULL
//
// Import path from routes:
//   require("../controllers/emailController")
// ============================================================

const db = require("../utils/db");
const nodemailer = require("nodemailer");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const { buildPaginationResponse } = require("../utils/pagination");
const { formatDate } = require("../utils/formatdate");

const DEFAULT_LIMIT = 20;

// Schema-aligned valid alert types
const VALID_ALERT_TYPES = ["lease_expiring", "lease_renewed", "tenancy_update"];

// ── Transporter ──────────────────────────────────────────────
// Re-uses the app-level transporter (set at boot) to avoid
// creating a new SMTP connection per request.
const getTransporter = (req) =>
  req.app.get("transporter") ||
  nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10),
    secure: process.env.EMAIL_SECURE === "true",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

// ── HTML helpers ─────────────────────────────────────────────
const esc = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const baseTemplate = (title, content) => `
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>${esc(title)}</title></head>
  <body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#374151">
    <div style="background:#1e40af;padding:16px 24px;border-radius:8px 8px 0 0">
      <h1 style="color:#fff;margin:0;font-size:18px">RentMS Ghana</h1>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px">
      <h2 style="color:#111827;margin-top:0">${esc(title)}</h2>
      ${content}
    </div>
    <p style="font-size:11px;color:#9ca3af;text-align:center;margin-top:16px">
      RentMS Ghana © ${new Date().getFullYear()} — This is an automated message.
    </p>
  </body>
</html>`;

// ── Core send + log ──────────────────────────────────────────
// Sends the email and always writes a row to email_logs,
// regardless of whether the send succeeded.
const sendAndLog = async (
  req,
  { to, subject, html, userId, notificationId },
) => {
  let status = "failed";
  let errorMsg = null;
  try {
    await getTransporter(req).sendMail({
      from: `"RentMS Ghana" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    status = "sent";
  } catch (err) {
    errorMsg = err.message;
    // Re-throw after logging so caller knows it failed
    throw err;
  } finally {
    try {
      await db.execute(
        `INSERT INTO email_logs
           (user_id, notification_id, email, subject, status, error_message, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [userId || null, notificationId || null, to, subject, status, errorMsg],
      );
    } catch (logErr) {
      console.warn("email_logs insert failed (non-fatal):", logErr.message);
    }
  }
};

// ── Per-user cooldown ────────────────────────────────────────
// Prevents sending the same email type to the same user within
// cooldownMinutes (default 60). Uses the subject prefix match.
const checkCooldown = async (userId, subjectPrefix, cooldownMinutes = 60) => {
  const [[row]] = await db.execute(
    `SELECT sent_at FROM email_logs
     WHERE user_id = ? AND subject LIKE ? AND status = 'sent'
     ORDER BY sent_at DESC LIMIT 1`,
    [userId, `${subjectPrefix}%`],
  );
  if (!row) return true;
  const diffMins = (Date.now() - new Date(row.sent_at).getTime()) / 60000;
  return diffMins >= cooldownMinutes;
};

// ═══════════════════════════════════════════════════════════════
// POST /api/email/notify  — admin only
// Send a custom notification email to any user by ID.
// Body: { user_id, subject, message, notification_id? }
// ═══════════════════════════════════════════════════════════════
const sendNotificationEmail = asyncHandler(async (req, res) => {
  const { user_id, subject, message, notification_id } = req.body;

  if (!user_id || !subject?.trim() || !message?.trim()) {
    throw new AppError("user_id, subject, and message are required", 400);
  }

  const [[user]] = await db.execute(
    `SELECT id, email, full_name FROM users WHERE id = ? AND deleted_at IS NULL`,
    [parseInt(user_id, 10)],
  );
  if (!user) throw new AppError("User not found", 404);

  const name = user.full_name || "Valued Tenant";

  await sendAndLog(req, {
    to: user.email,
    subject: subject.trim(),
    html: baseTemplate(
      subject.trim(),
      `
      <p>Dear ${esc(name)},</p>
      <p>${esc(message.trim())}</p>
    `,
    ),
    userId: user.id,
    notificationId: notification_id ? parseInt(notification_id, 10) : null,
  });

  await logActivity(
    req.user.id,
    "email_sent",
    `Sent notification email to user ${user.id} (${user.email})`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Email sent successfully" });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/email/payment-reminder  — admin, landlord
// Send a payment reminder to a single active tenancy.
// Landlord must own the tenancy's plaza.
// Body: { tenancy_id }
// ═══════════════════════════════════════════════════════════════
const sendPaymentReminder = asyncHandler(async (req, res) => {
  const { tenancy_id } = req.body;
  if (!tenancy_id) throw new AppError("tenancy_id is required", 400);

  const [[tenancy]] = await db.execute(
    `SELECT
       u.id AS tenant_id, u.email, u.full_name,
       t.rent_amount, t.lease_end, t.status,
       p.name AS plaza_name, p.landlord_id
     FROM tenancies t
     JOIN users  u ON u.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id
     WHERE t.id = ?`,
    [parseInt(tenancy_id, 10)],
  );
  if (!tenancy) throw new AppError("Tenancy not found", 404);

  // Landlord must own this tenancy's plaza
  if (req.user.role === "landlord" && tenancy.landlord_id !== req.user.id) {
    throw new AppError("Access denied — not your tenant", 403);
  }
  if (tenancy.status !== "active") {
    throw new AppError("Cannot send reminder for an inactive tenancy", 400);
  }

  const canSend = await checkCooldown(
    tenancy.tenant_id,
    "Rent Payment Reminder",
  );
  if (!canSend) {
    throw new AppError(
      "A payment reminder was already sent recently. Please wait at least 1 hour.",
      429,
    );
  }

  const name = tenancy.full_name || "Valued Tenant";
  const subject = "Rent Payment Reminder";
  const content = `
    <p>Dear ${esc(name)},</p>
    <p>This is a friendly reminder that your rent payment of
    <strong>GHS ${parseFloat(tenancy.rent_amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}</strong>
    for <strong>${esc(tenancy.plaza_name)}</strong> is due.</p>
    ${tenancy.lease_end ? `<p>Your current lease runs until <strong>${formatDate(tenancy.lease_end)}</strong>.</p>` : ""}
    <p>Please log into your RentMS account to make your payment.</p>
  `;

  await sendAndLog(req, {
    to: tenancy.email,
    subject,
    html: baseTemplate(subject, content),
    userId: tenancy.tenant_id,
  });

  await logActivity(
    req.user.id,
    "email_sent",
    `Sent payment reminder to tenant ${tenancy.tenant_id} for tenancy ${tenancy_id}`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Payment reminder sent" });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/email/bulk-reminder  — admin, landlord
// Send payment reminders to all active tenants.
// Landlord: scoped to their own plazas.
// Admin: all plazas, or a specific plaza if plaza_id is supplied.
// Body: { plaza_id? }
// ═══════════════════════════════════════════════════════════════
const sendBulkPaymentReminders = asyncHandler(async (req, res) => {
  const isLandlord = req.user.role === "landlord";
  const plazaId = req.body.plaza_id ? parseInt(req.body.plaza_id, 10) : null;

  // Landlord requesting a specific plaza must own it
  if (isLandlord && plazaId) {
    const [[{ owns }]] = await db.execute(
      `SELECT COUNT(*) AS owns FROM plazas WHERE id = ? AND landlord_id = ? AND deleted_at IS NULL`,
      [plazaId, req.user.id],
    );
    if (!owns) throw new AppError("Plaza not found or access denied", 403);
  }

  const conditions = ["t.status = 'active'"];
  const params = [];

  if (isLandlord) {
    conditions.push("p.landlord_id = ?");
    params.push(req.user.id);
  }
  if (plazaId) {
    conditions.push("p.id = ?");
    params.push(plazaId);
  }

  const [tenancies] = await db.execute(
    `SELECT
       u.id AS tenant_id, u.email, u.full_name,
       t.id AS tenancy_id, t.rent_amount, t.lease_end,
       p.name AS plaza_name
     FROM tenancies t
     JOIN users  u ON u.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id
     WHERE ${conditions.join(" AND ")}`,
    params,
  );

  if (!tenancies.length) {
    return res.json({
      success: true,
      message: "No active tenancies found",
      results: { sent: 0, skipped: 0, failed: 0 },
    });
  }

  const results = { sent: 0, skipped: 0, failed: 0 };
  const subject = "Rent Payment Reminder";

  for (const t of tenancies) {
    const canSend = await checkCooldown(t.tenant_id, subject);
    if (!canSend) {
      results.skipped++;
      continue;
    }

    try {
      const name = t.full_name || "Valued Tenant";
      const content = `
        <p>Dear ${esc(name)},</p>
        <p>This is a reminder that your rent of
        <strong>GHS ${parseFloat(t.rent_amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}</strong>
        for <strong>${esc(t.plaza_name)}</strong> is due.</p>
        ${t.lease_end ? `<p>Your lease runs until <strong>${formatDate(t.lease_end)}</strong>.</p>` : ""}
        <p>Please log into your RentMS account to complete your payment.</p>
      `;
      await sendAndLog(req, {
        to: t.email,
        subject,
        html: baseTemplate(subject, content),
        userId: t.tenant_id,
      });
      results.sent++;
    } catch {
      results.failed++;
    }
  }

  await logActivity(
    req.user.id,
    "email_sent",
    `Bulk payment reminder: ${results.sent} sent, ${results.skipped} skipped, ${results.failed} failed`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Bulk payment reminders processed",
    results,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/email/tenancy-alert  — admin, landlord
// Send a lease/tenancy status alert to a specific tenant.
// Body: { tenancy_id, alert_type }
//   alert_type: "lease_expiring" | "lease_renewed" | "tenancy_update"
// ═══════════════════════════════════════════════════════════════
const sendTenancyAlert = asyncHandler(async (req, res) => {
  const { tenancy_id, alert_type } = req.body;

  if (!tenancy_id || !alert_type) {
    throw new AppError("tenancy_id and alert_type are required", 400);
  }
  if (!VALID_ALERT_TYPES.includes(alert_type)) {
    throw new AppError(
      `Invalid alert_type. Must be: ${VALID_ALERT_TYPES.join(", ")}`,
      400,
    );
  }

  const [[tenancy]] = await db.execute(
    `SELECT
       u.id AS tenant_id, u.email, u.full_name,
       t.lease_start, t.lease_end, t.rent_amount,
       p.name AS plaza_name, p.landlord_id
     FROM tenancies t
     JOIN users  u ON u.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id
     WHERE t.id = ?`,
    [parseInt(tenancy_id, 10)],
  );
  if (!tenancy) throw new AppError("Tenancy not found", 404);

  if (req.user.role === "landlord" && tenancy.landlord_id !== req.user.id) {
    throw new AppError("Access denied — not your tenant", 403);
  }

  const canSend = await checkCooldown(tenancy.tenant_id, alert_type);
  if (!canSend) {
    throw new AppError(
      "An alert of this type was already sent recently. Please wait.",
      429,
    );
  }

  const name = tenancy.full_name || "Valued Tenant";
  const leaseEnd = tenancy.lease_end ? formatDate(tenancy.lease_end) : null;

  let subject, content;

  switch (alert_type) {
    case "lease_expiring":
      subject = "Lease Expiry Notice";
      content = `
        <p>Dear ${esc(name)},</p>
        <p>Your lease at <strong>${esc(tenancy.plaza_name)}</strong>
        will expire on <strong>${leaseEnd ?? "a date set by your landlord"}</strong>.</p>
        <p>Please contact your landlord to discuss renewal options before it expires.</p>
      `;
      break;
    case "lease_renewed":
      subject = "Lease Renewal Confirmed";
      content = `
        <p>Dear ${esc(name)},</p>
        <p>Your lease at <strong>${esc(tenancy.plaza_name)}</strong>
        has been successfully renewed.
        ${leaseEnd ? `Your new lease end date is <strong>${leaseEnd}</strong>.` : ""}</p>
        <p>Thank you for continuing to stay with us.</p>
      `;
      break;
    case "tenancy_update":
    default:
      subject = "Tenancy Update";
      content = `
        <p>Dear ${esc(name)},</p>
        <p>There has been an update to your tenancy at
        <strong>${esc(tenancy.plaza_name)}</strong>.
        Please log into your RentMS account to review the latest details.</p>
      `;
  }

  await sendAndLog(req, {
    to: tenancy.email,
    subject,
    html: baseTemplate(subject, content),
    userId: tenancy.tenant_id,
  });

  await logActivity(
    req.user.id,
    "email_sent",
    `Sent ${alert_type} alert to tenant ${tenancy.tenant_id}`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Tenancy alert sent" });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/email/lease-expiry-digest  — admin, landlord
// Batch-send lease expiry notices to all tenants whose leases
// expire within N days (default 30).
// Body: { days_ahead? (1–90), plaza_id? }
// ═══════════════════════════════════════════════════════════════
const sendLeaseExpiryDigest = asyncHandler(async (req, res) => {
  const isLandlord = req.user.role === "landlord";
  const daysAhead = Math.min(
    90,
    Math.max(1, parseInt(req.body.days_ahead, 10) || 30),
  );
  const plazaId = req.body.plaza_id ? parseInt(req.body.plaza_id, 10) : null;

  if (isLandlord && plazaId) {
    const [[{ owns }]] = await db.execute(
      `SELECT COUNT(*) AS owns FROM plazas WHERE id = ? AND landlord_id = ? AND deleted_at IS NULL`,
      [plazaId, req.user.id],
    );
    if (!owns) throw new AppError("Plaza not found or access denied", 403);
  }

  const conditions = [
    "t.status = 'active'",
    "t.lease_end IS NOT NULL",
    "t.lease_end BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)",
  ];
  const params = [daysAhead];

  if (isLandlord) {
    conditions.push("p.landlord_id = ?");
    params.push(req.user.id);
  }
  if (plazaId) {
    conditions.push("p.id = ?");
    params.push(plazaId);
  }

  const [tenancies] = await db.execute(
    `SELECT
       u.id AS tenant_id, u.email, u.full_name,
       t.lease_end, p.name AS plaza_name
     FROM tenancies t
     JOIN users  u ON u.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id
     WHERE ${conditions.join(" AND ")}`,
    params,
  );

  if (!tenancies.length) {
    return res.json({
      success: true,
      message: `No leases expiring within ${daysAhead} days`,
      results: { sent: 0, skipped: 0, failed: 0 },
    });
  }

  const results = { sent: 0, skipped: 0, failed: 0 };

  for (const t of tenancies) {
    const canSend = await checkCooldown(t.tenant_id, "Lease Expiry Notice");
    if (!canSend) {
      results.skipped++;
      continue;
    }

    try {
      const name = t.full_name || "Valued Tenant";
      const subject = "Lease Expiry Notice";
      const content = `
        <p>Dear ${esc(name)},</p>
        <p>Your lease at <strong>${esc(t.plaza_name)}</strong>
        is due to expire on <strong>${formatDate(t.lease_end)}</strong>.</p>
        <p>Please contact your landlord soon to discuss renewal options.</p>
      `;
      await sendAndLog(req, {
        to: t.email,
        subject,
        html: baseTemplate(subject, content),
        userId: t.tenant_id,
      });
      results.sent++;
    } catch {
      results.failed++;
    }
  }

  await logActivity(
    req.user.id,
    "email_sent",
    `Lease expiry digest (${daysAhead}d): ${results.sent} sent, ${results.skipped} skipped, ${results.failed} failed`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Lease expiry digest sent",
    results,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/email/resend/:log_id  — admin only
// Retry a previously failed email by log ID.
// Looks up the original recipient and subject from email_logs.
// ═══════════════════════════════════════════════════════════════
const resendFailedEmail = asyncHandler(async (req, res) => {
  const logId = parseInt(req.params.log_id, 10);
  if (isNaN(logId) || logId <= 0) throw new AppError("Invalid log ID", 400);

  const [[log]] = await db.execute(
    `SELECT el.id, el.user_id, el.email, el.subject, el.status,
            u.full_name
     FROM email_logs el
     LEFT JOIN users u ON u.id = el.user_id
     WHERE el.id = ?`,
    [logId],
  );
  if (!log) throw new AppError("Email log entry not found", 404);
  if (log.status !== "failed")
    throw new AppError("Only failed emails can be resent", 400);

  const name = log.full_name || "Valued Tenant";
  const subject = `[Resent] ${log.subject}`;
  const content = `
    <p>Dear ${esc(name)},</p>
    <p>This is a redelivery of a previously failed message
    (<em>${esc(log.subject)}</em>).</p>
    <p>Please contact your landlord or our support team if you have questions.</p>
  `;

  await sendAndLog(req, {
    to: log.email,
    subject,
    html: baseTemplate(subject, content),
    userId: log.user_id,
  });

  await logActivity(
    req.user.id,
    "email_sent",
    `Resent failed email (log ID: ${logId}) to ${log.email}`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Email resent successfully" });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/email/stats  — admin only
// Platform-wide email delivery stats.
// ═══════════════════════════════════════════════════════════════
const getEmailStats = asyncHandler(async (req, res) => {
  const [[totals]] = await db.execute(
    `SELECT
       COUNT(*)               AS total_sent,
       SUM(status = 'sent')   AS successful,
       SUM(status = 'failed') AS failed,
       COUNT(CASE WHEN sent_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                  THEN 1 END) AS sent_last_24h,
       COUNT(CASE WHEN sent_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                  THEN 1 END) AS sent_last_7d
     FROM email_logs`,
  );

  const [bySubjectPrefix] = await db.execute(
    `SELECT
       CASE
         WHEN subject LIKE 'Rent Payment%'   THEN 'payment_reminder'
         WHEN subject LIKE 'Lease Expiry%'   THEN 'lease_expiring'
         WHEN subject LIKE 'Lease Renewal%'  THEN 'lease_renewed'
         WHEN subject LIKE 'Tenancy Update%' THEN 'tenancy_update'
         ELSE 'other'
       END                           AS email_type,
       COUNT(*)                      AS total,
       SUM(status = 'sent')          AS sent,
       SUM(status = 'failed')        AS failed
     FROM email_logs
     GROUP BY email_type
     ORDER BY total DESC`,
  );

  return res.json({
    success: true,
    data: { totals, by_type: bySubjectPrefix },
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/email/logs  — admin only
// Paginated email send history — schema-aligned columns.
// Query params: page, limit, user_id, status, from, to
// ═══════════════════════════════════════════════════════════════
const getEmailLogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { user_id, status, from, to } = req.query;

  if (status && !["sent", "failed"].includes(status)) {
    throw new AppError("Invalid status. Must be 'sent' or 'failed'", 400);
  }
  if (from && isNaN(Date.parse(from)))
    throw new AppError("Invalid 'from' date. Use YYYY-MM-DD", 400);
  if (to && isNaN(Date.parse(to)))
    throw new AppError("Invalid 'to' date. Use YYYY-MM-DD", 400);

  const conditions = [];
  const params = [];

  if (user_id) {
    conditions.push("el.user_id = ?");
    params.push(parseInt(user_id, 10));
  }
  if (status) {
    conditions.push("el.status = ?");
    params.push(status);
  }
  if (from) {
    conditions.push("DATE(el.sent_at) >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("DATE(el.sent_at) <= ?");
    params.push(to);
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM email_logs el ${WHERE}`,
    params,
  );

  const [logs] = await db.execute(
    `SELECT
       el.id, el.user_id, el.email, el.subject,
       el.status, el.error_message, el.sent_at,
       u.full_name AS user_name
     FROM email_logs el
     LEFT JOIN users u ON u.id = el.user_id
     ${WHERE}
     ORDER BY el.sent_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: logs, total, page, limit }),
  });
});

module.exports = {
  sendNotificationEmail,
  sendPaymentReminder,
  sendBulkPaymentReminders,
  sendTenancyAlert,
  sendLeaseExpiryDigest,
  resendFailedEmail,
  getEmailStats,
  getEmailLogs,
};
