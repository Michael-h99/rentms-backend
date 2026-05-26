// controllers/emailcontroller.js
// ============================================================
// All email endpoints — sends via resend

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
//   require("../controllers/emailcontroller")
// ============================================================

// controllers/emailcontroller.js — Resend version
const { Resend } = require("resend");
const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const { buildPaginationResponse } = require("../utils/pagination");
const { formatDate } = require("../utils/formatdate");

const DEFAULT_LIMIT = 20;
const VALID_ALERT_TYPES = ["lease_expiring", "lease_renewed", "tenancy_update"];
const FROM = process.env.EMAIL_FROM || "onboarding@resend.dev";

const getResend = (req) =>
  req.app.get("resend") || new Resend(process.env.RESEND_API_KEY);

const esc = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const baseTemplate = (title, content) => `
<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#374151">
  <div style="background:#1e40af;padding:16px 24px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:18px">🏠 RentMS Ghana</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px">
    <h2 style="color:#111827;margin-top:0">${esc(title)}</h2>${content}
  </div>
  <p style="font-size:11px;color:#9ca3af;text-align:center;margin-top:16px">
    RentMS Ghana © ${new Date().getFullYear()} — Automated message.
  </p>
</body></html>`;

const sendAndLog = async (
  req,
  { to, subject, html, userId, notificationId },
) => {
  let status = "failed";
  let errorMsg = null;
  try {
    const { error } = await getResend(req).emails.send({
      from: FROM,
      to,
      subject,
      html,
    });
    if (error) throw new Error(error.message || "Resend error");
    status = "sent";
  } catch (err) {
    errorMsg = err.message;
    throw err;
  } finally {
    try {
      await db.execute(
        `INSERT INTO email_logs (user_id,notification_id,email,subject,status,error_message,sent_at) VALUES (?,?,?,?,?,?,NOW())`,
        [userId || null, notificationId || null, to, subject, status, errorMsg],
      );
    } catch (e) {
      console.warn("email_logs insert failed:", e.message);
    }
  }
};

const checkCooldown = async (userId, subjectPrefix, mins = 60) => {
  const [[row]] = await db.execute(
    `SELECT sent_at FROM email_logs WHERE user_id=? AND subject LIKE ? AND status='sent' ORDER BY sent_at DESC LIMIT 1`,
    [userId, `${subjectPrefix}%`],
  );
  if (!row) return true;
  return (Date.now() - new Date(row.sent_at).getTime()) / 60000 >= mins;
};

// POST /api/email/notify
const sendNotificationEmail = asyncHandler(async (req, res) => {
  const { user_id, subject, message, notification_id } = req.body;
  if (!user_id || !subject?.trim() || !message?.trim())
    throw new AppError("user_id, subject, and message are required", 400);
  const [[user]] = await db.execute(
    `SELECT id,email,full_name FROM users WHERE id=? AND deleted_at IS NULL`,
    [parseInt(user_id, 10)],
  );
  if (!user) throw new AppError("User not found", 404);
  await sendAndLog(req, {
    to: user.email,
    subject: subject.trim(),
    html: baseTemplate(
      subject.trim(),
      `<p>Dear ${esc(user.full_name || "User")},</p><p>${esc(message.trim())}</p>`,
    ),
    userId: user.id,
    notificationId: notification_id ? parseInt(notification_id, 10) : null,
  });
  await logActivity(
    req.user.id,
    "email_sent",
    `Sent notification to user ${user.id}`,
    { ip: req.ip },
  );
  return res.json({ success: true, message: "Email sent successfully" });
});

// POST /api/email/payment-reminder
const sendPaymentReminder = asyncHandler(async (req, res) => {
  const { tenancy_id } = req.body;
  if (!tenancy_id) throw new AppError("tenancy_id is required", 400);
  const [[t]] = await db.execute(
    `SELECT u.id AS tenant_id,u.email,u.full_name,t.rent_amount,t.lease_end,t.status,p.name AS plaza_name,p.landlord_id
     FROM tenancies t JOIN users u ON u.id=t.tenant_id JOIN plazas p ON p.id=t.plaza_id WHERE t.id=?`,
    [parseInt(tenancy_id, 10)],
  );
  if (!t) throw new AppError("Tenancy not found", 404);
  if (req.user.role === "landlord" && t.landlord_id !== req.user.id)
    throw new AppError("Access denied", 403);
  if (t.status !== "active")
    throw new AppError("Cannot remind inactive tenancy", 400);
  if (!(await checkCooldown(t.tenant_id, "Rent Payment Reminder")))
    throw new AppError("Reminder already sent recently. Wait 1 hour.", 429);

  const subject = "Rent Payment Reminder";
  const content = `<p>Dear ${esc(t.full_name || "Tenant")},</p>
    <p>Your rent of <strong>GHS ${parseFloat(t.rent_amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}</strong>
    for <strong>${esc(t.plaza_name)}</strong> is due.</p>
    ${t.lease_end ? `<p>Lease ends: <strong>${formatDate(t.lease_end)}</strong></p>` : ""}
    <p>Log in to RentMS to make your payment.</p>`;
  await sendAndLog(req, {
    to: t.email,
    subject,
    html: baseTemplate(subject, content),
    userId: t.tenant_id,
  });
  await logActivity(
    req.user.id,
    "email_sent",
    `Payment reminder → tenant ${t.tenant_id}`,
    { ip: req.ip },
  );
  return res.json({ success: true, message: "Payment reminder sent" });
});

// POST /api/email/bulk-reminder
const sendBulkPaymentReminders = asyncHandler(async (req, res) => {
  const isLandlord = req.user.role === "landlord";
  const plazaId = req.body.plaza_id ? parseInt(req.body.plaza_id, 10) : null;
  if (isLandlord && plazaId) {
    const [[{ owns }]] = await db.execute(
      `SELECT COUNT(*) AS owns FROM plazas WHERE id=? AND landlord_id=? AND deleted_at IS NULL`,
      [plazaId, req.user.id],
    );
    if (!owns) throw new AppError("Plaza not found or access denied", 403);
  }
  const cond = ["t.status='active'"];
  const params = [];
  if (isLandlord) {
    cond.push("p.landlord_id=?");
    params.push(req.user.id);
  }
  if (plazaId) {
    cond.push("p.id=?");
    params.push(plazaId);
  }
  const [tenancies] = await db.execute(
    `SELECT u.id AS tenant_id,u.email,u.full_name,t.rent_amount,t.lease_end,p.name AS plaza_name
     FROM tenancies t JOIN users u ON u.id=t.tenant_id JOIN plazas p ON p.id=t.plaza_id WHERE ${cond.join(" AND ")}`,
    params,
  );
  if (!tenancies.length)
    return res.json({
      success: true,
      message: "No active tenancies",
      results: { sent: 0, skipped: 0, failed: 0 },
    });
  const results = { sent: 0, skipped: 0, failed: 0 };
  for (const t of tenancies) {
    if (!(await checkCooldown(t.tenant_id, "Rent Payment Reminder"))) {
      results.skipped++;
      continue;
    }
    try {
      const subject = "Rent Payment Reminder";
      const content = `<p>Dear ${esc(t.full_name || "Tenant")},</p><p>Your rent of <strong>GHS ${parseFloat(t.rent_amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}</strong> for <strong>${esc(t.plaza_name)}</strong> is due.</p>${t.lease_end ? `<p>Lease ends: <strong>${formatDate(t.lease_end)}</strong></p>` : ""}`;
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
    `Bulk reminder: ${results.sent} sent`,
    { ip: req.ip },
  );
  return res.json({
    success: true,
    message: "Bulk reminders processed",
    results,
  });
});

// POST /api/email/tenancy-alert
const sendTenancyAlert = asyncHandler(async (req, res) => {
  const { tenancy_id, alert_type } = req.body;
  if (!tenancy_id || !alert_type)
    throw new AppError("tenancy_id and alert_type are required", 400);
  if (!VALID_ALERT_TYPES.includes(alert_type))
    throw new AppError(
      `Invalid alert_type. Must be: ${VALID_ALERT_TYPES.join(", ")}`,
      400,
    );
  const [[t]] = await db.execute(
    `SELECT u.id AS tenant_id,u.email,u.full_name,t.lease_start,t.lease_end,p.name AS plaza_name,p.landlord_id
     FROM tenancies t JOIN users u ON u.id=t.tenant_id JOIN plazas p ON p.id=t.plaza_id WHERE t.id=?`,
    [parseInt(tenancy_id, 10)],
  );
  if (!t) throw new AppError("Tenancy not found", 404);
  if (req.user.role === "landlord" && t.landlord_id !== req.user.id)
    throw new AppError("Access denied", 403);
  if (!(await checkCooldown(t.tenant_id, alert_type)))
    throw new AppError("Alert already sent recently.", 429);
  const name = t.full_name || "Tenant";
  const leaseEnd = t.lease_end ? formatDate(t.lease_end) : null;
  let subject, content;
  if (alert_type === "lease_expiring") {
    subject = "Lease Expiry Notice";
    content = `<p>Dear ${esc(name)},</p><p>Your lease at <strong>${esc(t.plaza_name)}</strong> expires on <strong>${leaseEnd || "a date set by your landlord"}</strong>.</p><p>Contact your landlord to arrange renewal.</p>`;
  } else if (alert_type === "lease_renewed") {
    subject = "Lease Renewal Confirmed";
    content = `<p>Dear ${esc(name)},</p><p>Your lease at <strong>${esc(t.plaza_name)}</strong> has been renewed.${leaseEnd ? ` New end date: <strong>${leaseEnd}</strong>.` : ""}</p>`;
  } else {
    subject = "Tenancy Update";
    content = `<p>Dear ${esc(name)},</p><p>There has been an update to your tenancy at <strong>${esc(t.plaza_name)}</strong>. Please log in to view details.</p>`;
  }
  await sendAndLog(req, {
    to: t.email,
    subject,
    html: baseTemplate(subject, content),
    userId: t.tenant_id,
  });
  await logActivity(
    req.user.id,
    "email_sent",
    `${alert_type} alert → tenant ${t.tenant_id}`,
    { ip: req.ip },
  );
  return res.json({ success: true, message: "Tenancy alert sent" });
});

// POST /api/email/lease-expiry-digest
const sendLeaseExpiryDigest = asyncHandler(async (req, res) => {
  const isLandlord = req.user.role === "landlord";
  const daysAhead = Math.min(
    90,
    Math.max(1, parseInt(req.body.days_ahead, 10) || 30),
  );
  const plazaId = req.body.plaza_id ? parseInt(req.body.plaza_id, 10) : null;
  if (isLandlord && plazaId) {
    const [[{ owns }]] = await db.execute(
      `SELECT COUNT(*) AS owns FROM plazas WHERE id=? AND landlord_id=? AND deleted_at IS NULL`,
      [plazaId, req.user.id],
    );
    if (!owns) throw new AppError("Plaza not found or access denied", 403);
  }
  const cond = [
    "t.status='active'",
    "t.lease_end IS NOT NULL",
    "t.lease_end BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)",
  ];
  const params = [daysAhead];
  if (isLandlord) {
    cond.push("p.landlord_id=?");
    params.push(req.user.id);
  }
  if (plazaId) {
    cond.push("p.id=?");
    params.push(plazaId);
  }
  const [tenancies] = await db.execute(
    `SELECT u.id AS tenant_id,u.email,u.full_name,t.lease_end,p.name AS plaza_name
     FROM tenancies t JOIN users u ON u.id=t.tenant_id JOIN plazas p ON p.id=t.plaza_id WHERE ${cond.join(" AND ")}`,
    params,
  );
  if (!tenancies.length)
    return res.json({
      success: true,
      message: `No leases expiring within ${daysAhead} days`,
      results: { sent: 0, skipped: 0, failed: 0 },
    });
  const results = { sent: 0, skipped: 0, failed: 0 };
  for (const t of tenancies) {
    if (!(await checkCooldown(t.tenant_id, "Lease Expiry Notice"))) {
      results.skipped++;
      continue;
    }
    try {
      const subject = "Lease Expiry Notice";
      const content = `<p>Dear ${esc(t.full_name || "Tenant")},</p><p>Your lease at <strong>${esc(t.plaza_name)}</strong> expires on <strong>${formatDate(t.lease_end)}</strong>.</p><p>Contact your landlord to discuss renewal.</p>`;
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
    `Lease expiry digest: ${results.sent} sent`,
    { ip: req.ip },
  );
  return res.json({
    success: true,
    message: "Lease expiry digest sent",
    results,
  });
});

// POST /api/email/resend/:log_id
const resendFailedEmail = asyncHandler(async (req, res) => {
  const logId = parseInt(req.params.log_id, 10);
  if (isNaN(logId) || logId <= 0) throw new AppError("Invalid log ID", 400);
  const [[log]] = await db.execute(
    `SELECT el.id,el.user_id,el.email,el.subject,el.status,u.full_name FROM email_logs el LEFT JOIN users u ON u.id=el.user_id WHERE el.id=?`,
    [logId],
  );
  if (!log) throw new AppError("Email log entry not found", 404);
  if (log.status !== "failed")
    throw new AppError("Only failed emails can be resent", 400);
  const subject = `[Resent] ${log.subject}`;
  const content = `<p>Dear ${esc(log.full_name || "User")},</p><p>This is a redelivery of a previously failed message (<em>${esc(log.subject)}</em>).</p><p>Contact support if you have questions.</p>`;
  await sendAndLog(req, {
    to: log.email,
    subject,
    html: baseTemplate(subject, content),
    userId: log.user_id,
  });
  await logActivity(
    req.user.id,
    "email_sent",
    `Resent log ID ${logId} to ${log.email}`,
    { ip: req.ip },
  );
  return res.json({ success: true, message: "Email resent successfully" });
});

// GET /api/email/stats
const getEmailStats = asyncHandler(async (req, res) => {
  const [[totals]] = await db.execute(
    `SELECT COUNT(*) AS total_sent,SUM(status='sent') AS successful,SUM(status='failed') AS failed,
     COUNT(CASE WHEN sent_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR) THEN 1 END) AS sent_last_24h,
     COUNT(CASE WHEN sent_at>=DATE_SUB(NOW(),INTERVAL 7 DAY) THEN 1 END) AS sent_last_7d FROM email_logs`,
  );
  const [byType] = await db.execute(
    `SELECT CASE WHEN subject LIKE 'Rent Payment%' THEN 'payment_reminder'
                 WHEN subject LIKE 'Lease Expiry%' THEN 'lease_expiring'
                 WHEN subject LIKE 'Lease Renewal%' THEN 'lease_renewed'
                 WHEN subject LIKE 'Tenancy Update%' THEN 'tenancy_update'
                 ELSE 'other' END AS email_type,
     COUNT(*) AS total,SUM(status='sent') AS sent,SUM(status='failed') AS failed
     FROM email_logs GROUP BY email_type ORDER BY total DESC`,
  );
  return res.json({ success: true, data: { totals, by_type: byType } });
});

// GET /api/email/logs
const getEmailLogs = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { user_id, status, from, to } = req.query;
  if (status && !["sent", "failed"].includes(status))
    throw new AppError("Invalid status", 400);
  const cond = [];
  const params = [];
  if (user_id) {
    cond.push("el.user_id=?");
    params.push(parseInt(user_id, 10));
  }
  if (status) {
    cond.push("el.status=?");
    params.push(status);
  }
  if (from) {
    cond.push("DATE(el.sent_at)>=?");
    params.push(from);
  }
  if (to) {
    cond.push("DATE(el.sent_at)<=?");
    params.push(to);
  }
  const WHERE = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM email_logs el ${WHERE}`,
    params,
  );
  const [logs] = await db.execute(
    `SELECT el.id,el.user_id,el.email,el.subject,el.status,el.error_message,el.sent_at,u.full_name AS user_name
     FROM email_logs el LEFT JOIN users u ON u.id=el.user_id ${WHERE} ORDER BY el.sent_at DESC LIMIT ? OFFSET ?`,
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
