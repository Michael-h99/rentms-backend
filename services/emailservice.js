// services/emailService.js
// ============================================================
// Email service — all transactional emails for RentMS.
// Uses the nodemailer transporter set on app via
//   app.set("transporter", transporter)
// and falls back to creating its own if not available.
//
// Import path from controllers/routes:
//   const emailService = require("../services/emailService");
//
// Import path from other services (same folder):
//   const emailService = require("./emailService");
//
// DB imports:
//   const db = require("../utils/db");
// ============================================================

const nodemailer = require("nodemailer");
const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");
const { formatDate, formatGhanaDateTime } = require("../utils/formatdate");

// ── Transporter ──────────────────────────────────────────────
// Re-uses the app-level transporter if available,
// otherwise creates one from .env (useful in standalone scripts).
const getTransporter = (app = null) => {
  if (app) {
    const t = app.get("transporter");
    if (t) return t;
  }
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10) || 587,
    secure: process.env.EMAIL_SECURE === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
};

const FROM = `"RentMS Ghana" <${process.env.EMAIL_USER}>`;

// ── logEmail ─────────────────────────────────────────────────
// Insert a record into email_logs after every send attempt.
// Non-fatal — swallows its own errors.
const logEmail = async (
  userId,
  notificationId,
  email,
  subject,
  status,
  errorMessage = null,
) => {
  try {
    await db.execute(
      `INSERT INTO email_logs
         (user_id, notification_id, email, subject, status, error_message, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        userId,
        notificationId || null,
        email,
        subject || null,
        status,
        errorMessage || null,
      ],
    );
  } catch (err) {
    console.error("❌ emailService.logEmail failed:", err.message);
  }
};

// ── Base HTML Template ───────────────────────────────────────
// Clean, mobile-friendly email shell used by all templates.
const baseTemplate = (title, content, footerNote = "") => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:30px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:10px;overflow:hidden;
                    box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1e40af,#3b82f6);
                     padding:28px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;
                       letter-spacing:0.5px;">🏠 RentMS Ghana</h1>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">
              Smart Property Management
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <h2 style="color:#1e293b;font-size:18px;margin:0 0 16px;">${title}</h2>
            <div style="color:#475569;font-size:15px;line-height:1.7;">
              ${content}
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:20px 32px;
                     border-top:1px solid #e2e8f0;text-align:center;">
            ${
              footerNote
                ? `<p style="color:#64748b;font-size:13px;margin:0 0 8px;">${footerNote}</p>`
                : ""
            }
            <p style="color:#94a3b8;font-size:12px;margin:0;">
              RentMS Ghana &copy; ${new Date().getFullYear()} &nbsp;&bull;&nbsp;
              This is an automated email — please do not reply.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

// ── sendMail ──────────────────────────────────────────────────
// Core send helper — used by all public methods below.
// Logs every attempt (success + failure) to email_logs.
const sendMail = async ({
  transporter,
  to,
  subject,
  html,
  userId,
  notificationId = null,
}) => {
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
    await logEmail(userId, notificationId, to, subject, "sent");
    console.log(`📩 Email sent → ${to} [${subject}]`);
    return true;
  } catch (err) {
    await logEmail(userId, notificationId, to, subject, "failed", err.message);
    console.error(`❌ Email failed → ${to}:`, err.message);
    return false;
  }
};

// ── sendNotificationEmail ─────────────────────────────────────
// Generic notification email — used by the admin panel and API.
//
// Usage (controller):
//   await emailService.sendNotificationEmail(req, res);
const sendNotificationEmail = async (req, res) => {
  const { user_id, subject, message, notification_id } = req.body;

  if (!user_id || !subject || !message) {
    return res
      .status(400)
      .json({ error: "user_id, subject, and message are required" });
  }

  const [users] = await db.execute(
    `SELECT id, email, full_name FROM users WHERE id = ?`,
    [user_id],
  );
  if (!users.length) return res.status(404).json({ error: "User not found" });

  const user = users[0];
  const html = baseTemplate(
    subject,
    `<p>Dear ${user.full_name || "User"},</p><p>${message}</p>`,
  );
  const trans = getTransporter(req.app);

  const ok = await sendMail({
    transporter: trans,
    to: user.email,
    subject,
    html,
    userId: user.id,
    notificationId: notification_id || null,
  });

  if (!ok) return res.status(500).json({ error: "Email sending failed" });
  return res.json({ message: "Email sent successfully" });
};

// ── sendPaymentReminder ───────────────────────────────────────
// Remind a tenant their rent is due.
// Called by cron job or landlord manually.
//
// Usage (controller):
//   await emailService.sendPaymentReminder(req, res);
const sendPaymentReminder = async (req, res) => {
  const { tenancy_id } = req.body;
  if (!tenancy_id)
    return res.status(400).json({ error: "tenancy_id is required" });

  const [results] = await db.execute(
    `SELECT u.id, u.email, u.full_name, t.rent_amount, t.lease_end,
            p.name AS plaza_name, p.location AS plaza_location
     FROM tenancies t
     JOIN users  u ON u.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id
     WHERE t.id = ?`,
    [tenancy_id],
  );

  if (!results.length)
    return res.status(404).json({ error: "Tenancy not found" });

  const tenant = results[0];
  const subject = "Rent Payment Reminder — Action Required";
  const content = `
    <p>Dear <strong>${tenant.full_name || "Tenant"}</strong>,</p>
    <p>This is a friendly reminder that your rent payment is due:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr style="background:#f1f5f9;">
        <td style="padding:10px 14px;font-weight:600;color:#1e293b;">Amount Due</td>
        <td style="padding:10px 14px;color:#1e40af;font-weight:700;font-size:16px;">
          GHS ${parseFloat(tenant.rent_amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}
        </td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;color:#1e293b;">Plaza</td>
        <td style="padding:10px 14px;">${tenant.plaza_name} — ${tenant.plaza_location}</td>
      </tr>
      ${
        tenant.lease_end
          ? `
      <tr style="background:#f1f5f9;">
        <td style="padding:10px 14px;font-weight:600;color:#1e293b;">Lease End</td>
        <td style="padding:10px 14px;">${formatDate(tenant.lease_end)}</td>
      </tr>`
          : ""
      }
    </table>
    <p>Please log in to your RentMS account to complete your payment.</p>
    <p style="margin:20px 0;">
      <a href="${process.env.FRONTEND_URL || "http://localhost:5500"}/tenant/payments.html"
         style="background:#1e40af;color:#fff;padding:12px 24px;
                border-radius:6px;text-decoration:none;font-weight:600;">
        Pay Now
      </a>
    </p>
    <p style="color:#94a3b8;font-size:13px;">
      If you have already made payment, please disregard this message.
    </p>`;

  const trans = getTransporter(req.app);
  const ok = await sendMail({
    transporter: trans,
    to: tenant.email,
    subject,
    html: baseTemplate(subject, content),
    userId: tenant.id,
  });

  if (!ok) return res.status(500).json({ error: "Failed to send reminder" });
  return res.json({ message: "Payment reminder sent" });
};

// ── sendTenancyAlert ──────────────────────────────────────────
// Lease expiry notice or general tenancy update.
// alert_type: "lease_expiring" | "lease_expired" | "tenancy_update"
//
// Usage (controller):
//   await emailService.sendTenancyAlert(req, res);
const sendTenancyAlert = async (req, res) => {
  const { tenancy_id, alert_type } = req.body;
  if (!tenancy_id || !alert_type) {
    return res
      .status(400)
      .json({ error: "tenancy_id and alert_type are required" });
  }

  const [results] = await db.execute(
    `SELECT u.id, u.email, u.full_name, t.lease_end, t.rent_amount,
            p.name AS plaza_name, p.location AS plaza_location
     FROM tenancies t
     JOIN users  u ON u.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id
     WHERE t.id = ?`,
    [tenancy_id],
  );

  if (!results.length)
    return res.status(404).json({ error: "Tenancy not found" });

  const tenant = results[0];
  const name = tenant.full_name || "Tenant";
  let subject, content;

  if (alert_type === "lease_expiring") {
    subject = "⚠️ Your Lease is Expiring Soon";
    content = `
      <p>Dear <strong>${name}</strong>,</p>
      <p>Your lease is expiring soon. Here are the details:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr style="background:#fef3c7;">
          <td style="padding:10px 14px;font-weight:600;color:#92400e;">Lease Ends</td>
          <td style="padding:10px 14px;color:#b45309;font-weight:700;">
            ${formatDate(tenant.lease_end)}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:600;">Plaza</td>
          <td style="padding:10px 14px;">${tenant.plaza_name} — ${tenant.plaza_location}</td>
        </tr>
      </table>
      <p>Please contact your landlord as soon as possible to arrange a renewal.</p>
      <p style="margin:20px 0;">
        <a href="${process.env.FRONTEND_URL || "http://localhost:5500"}/tenant/lease.html"
           style="background:#d97706;color:#fff;padding:12px 24px;
                  border-radius:6px;text-decoration:none;font-weight:600;">
          View Lease Details
        </a>
      </p>`;
  } else if (alert_type === "lease_expired") {
    subject = "🔴 Your Lease Has Expired";
    content = `
      <p>Dear <strong>${name}</strong>,</p>
      <p>Your lease at <strong>${tenant.plaza_name}</strong> expired on
         <strong>${formatDate(tenant.lease_end)}</strong>.</p>
      <p>Please contact your landlord urgently to discuss renewal or next steps.</p>`;
  } else {
    subject = "Tenancy Update — RentMS";
    content = `
      <p>Dear <strong>${name}</strong>,</p>
      <p>There has been an update to your tenancy at
         <strong>${tenant.plaza_name}</strong>.</p>
      <p>Please log in to your account to view the latest details.</p>`;
  }

  const trans = getTransporter(req.app);
  const ok = await sendMail({
    transporter: trans,
    to: tenant.email,
    subject,
    html: baseTemplate(subject, content),
    userId: tenant.id,
  });

  if (!ok)
    return res.status(500).json({ error: "Failed to send tenancy alert" });
  return res.json({ message: "Tenancy alert sent" });
};

// ── sendPaymentConfirmation ───────────────────────────────────
// Receipt email after a successful payment.
//
// Usage (paymentController after insert):
//   await emailService.sendPaymentConfirmation({ app: req.app, tenancyId, paymentId });
const sendPaymentConfirmation = async ({
  app = null,
  tenancyId,
  paymentId,
}) => {
  const [results] = await db.execute(
    `SELECT
       u.id, u.email, u.full_name,
       p.amount, p.payment_method, p.reference, p.payment_date,
       pl.name AS plaza_name, pl.location AS plaza_location,
       t.unit_number
     FROM payments p
     JOIN tenancies t  ON t.id  = p.tenancy_id
     JOIN users     u  ON u.id  = t.tenant_id
     JOIN plazas    pl ON pl.id = t.plaza_id
     WHERE p.id = ? AND t.id = ?`,
    [paymentId, tenancyId],
  );

  if (!results.length) return false;

  const d = results[0];
  const subject = "✅ Payment Confirmed — RentMS";
  const content = `
    <p>Dear <strong>${d.full_name || "Tenant"}</strong>,</p>
    <p>Your rent payment has been received successfully.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;
                  border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
      <tr style="background:#f1f5f9;">
        <td style="padding:10px 14px;font-weight:600;color:#1e293b;">Amount Paid</td>
        <td style="padding:10px 14px;color:#16a34a;font-weight:700;font-size:16px;">
          GHS ${parseFloat(d.amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}
        </td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;">Reference</td>
        <td style="padding:10px 14px;font-family:monospace;">${d.reference}</td>
      </tr>
      <tr style="background:#f1f5f9;">
        <td style="padding:10px 14px;font-weight:600;">Payment Method</td>
        <td style="padding:10px 14px;text-transform:capitalize;">${d.payment_method}</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;">Plaza</td>
        <td style="padding:10px 14px;">${d.plaza_name} — ${d.plaza_location}</td>
      </tr>
      <tr style="background:#f1f5f9;">
        <td style="padding:10px 14px;font-weight:600;">Unit</td>
        <td style="padding:10px 14px;">${d.unit_number || "N/A"}</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;">Date</td>
        <td style="padding:10px 14px;">${formatGhanaDateTime(d.payment_date)}</td>
      </tr>
    </table>
    <p>Please keep this email as proof of payment.</p>`;

  const trans = getTransporter(app);
  return sendMail({
    transporter: trans,
    to: d.email,
    subject,
    html: baseTemplate(
      subject,
      content,
      "Keep this email as your payment receipt.",
    ),
    userId: d.id,
    notificationId: null,
  });
};

// ── sendWelcomeEmail ──────────────────────────────────────────
// Sent after a new tenant registers using an invite code.
//
// Usage (authController after registration):
//   await emailService.sendWelcomeEmail({ app: req.app, userId });
const sendWelcomeEmail = async ({ app = null, userId }) => {
  const [users] = await db.execute(
    `SELECT u.id, u.email, u.full_name, u.username,
            p.name AS plaza_name, p.location AS plaza_location,
            t.unit_number, t.rent_amount, t.lease_start, t.lease_end
     FROM users u
     LEFT JOIN tenancies t ON t.tenant_id = u.id AND t.status = 'active'
     LEFT JOIN plazas    p ON p.id = t.plaza_id
     WHERE u.id = ?`,
    [userId],
  );

  if (!users.length) return false;
  const u = users[0];

  const subject = "Welcome to RentMS Ghana 🎉";
  const content = `
    <p>Dear <strong>${u.full_name || u.username}</strong>,</p>
    <p>Welcome to <strong>RentMS Ghana</strong>! Your account has been created successfully.</p>
    ${
      u.plaza_name
        ? `
    <p>Here's a summary of your tenancy:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr style="background:#f1f5f9;">
        <td style="padding:10px 14px;font-weight:600;">Plaza</td>
        <td style="padding:10px 14px;">${u.plaza_name} — ${u.plaza_location}</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;">Unit</td>
        <td style="padding:10px 14px;">${u.unit_number || "N/A"}</td>
      </tr>
      <tr style="background:#f1f5f9;">
        <td style="padding:10px 14px;font-weight:600;">Monthly Rent</td>
        <td style="padding:10px 14px;color:#1e40af;font-weight:700;">
          GHS ${parseFloat(u.rent_amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}
        </td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;">Lease Period</td>
        <td style="padding:10px 14px;">
          ${formatDate(u.lease_start)} → ${formatDate(u.lease_end)}
        </td>
      </tr>
    </table>`
        : ""
    }
    <p style="margin:20px 0;">
      <a href="${process.env.FRONTEND_URL || "http://localhost:5500"}/tenant/dashboard.html"
         style="background:#1e40af;color:#fff;padding:12px 24px;
                border-radius:6px;text-decoration:none;font-weight:600;">
        Go to Your Dashboard
      </a>
    </p>`;

  const trans = getTransporter(app);
  return sendMail({
    transporter: trans,
    to: u.email,
    subject,
    html: baseTemplate(
      subject,
      content,
      "If you did not register for RentMS, please ignore this email.",
    ),
    userId: u.id,
  });
};

// ── sendPasswordResetEmail ────────────────────────────────────
// Password reset link email.
//
// Usage (authController):
//   await emailService.sendPasswordResetEmail({ app: req.app, userId, resetToken });
const sendPasswordResetEmail = async ({
  app = null,
  userId,
  email,
  fullName,
  resetToken,
}) => {
  const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5500"}/auth/reset-password.html?token=${resetToken}`;
  const subject = "Reset Your RentMS Password";
  const content = `
    <p>Dear <strong>${fullName || "User"}</strong>,</p>
    <p>We received a request to reset your password. Click the button below to set a new one:</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}"
         style="background:#dc2626;color:#fff;padding:12px 24px;
                border-radius:6px;text-decoration:none;font-weight:600;">
        Reset Password
      </a>
    </p>
    <p style="color:#94a3b8;font-size:13px;">
      This link expires in <strong>1 hour</strong>. If you did not request a
      password reset, you can safely ignore this email.
    </p>
    <p style="font-size:12px;color:#cbd5e1;word-break:break-all;">
      Or copy this link: ${resetUrl}
    </p>`;

  const trans = getTransporter(app);
  return sendMail({
    transporter: trans,
    to: email,
    subject,
    html: baseTemplate(
      subject,
      content,
      "For security, this link expires in 1 hour.",
    ),
    userId,
  });
};

module.exports = {
  sendNotificationEmail,
  sendPaymentReminder,
  sendTenancyAlert,
  sendPaymentConfirmation,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  // Internals exposed for testing
  baseTemplate,
  logEmail,
};
