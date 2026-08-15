// services/emailService.js
// ============================================================
// Email service — all transactional emails for RentMS.
// Uses the resend transporter set on app via
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

// services/emailService.js — Resend version
const { Resend } = require("resend");
const db = require("../utils/db");
const { formatDate, formatGhanaDateTime } = require("../utils/formatdate");

const FROM = process.env.EMAIL_FROM || "onboarding@resend.dev";

const getResend = (app = null) => {
  if (app) {
    const r = app.get("resend");
    if (r) return r;
  }
  return new Resend(process.env.RESEND_API_KEY);
};

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
      `INSERT INTO email_logs (user_id,notification_id,email,subject,status,error_message,sent_at) VALUES (?,?,?,?,?,?,NOW())`,
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
    console.error("❌ logEmail failed:", err.message);
  }
};

const baseTemplate = (title, content, footerNote = "") => `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:30px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#1e40af,#3b82f6);padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">🏠 RentMS Ghana</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Smart Property Management</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <h2 style="color:#1e293b;font-size:18px;margin:0 0 16px;">${title}</h2>
          <div style="color:#475569;font-size:15px;line-height:1.7;">${content}</div>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;text-align:center;">
          ${footerNote ? `<p style="color:#64748b;font-size:13px;margin:0 0 8px;">${footerNote}</p>` : ""}
          <p style="color:#94a3b8;font-size:12px;margin:0;">RentMS Ghana &copy; ${new Date().getFullYear()} &bull; Automated email — do not reply.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

const sendMail = async ({
  resendClient,
  to,
  subject,
  html,
  userId,
  notificationId = null,
}) => {
  try {
    const { error } = await resendClient.emails.send({
      from: FROM,
      to,
      subject,
      html,
    });
    if (error) throw new Error(error.message || "Resend API error");
    await logEmail(userId, notificationId, to, subject, "sent");
    console.log(`📩 Email sent → ${to} [${subject}]`);
    return true;
  } catch (err) {
    await logEmail(userId, notificationId, to, subject, "failed", err.message);
    console.error(`❌ Email failed → ${to}:`, err.message);
    return false;
  }
};

const sendPaymentConfirmation = async ({
  app = null,
  tenancyId,
  paymentId,
}) => {
  const [results] = await db.execute(
    `SELECT u.id,u.email,u.full_name,p.amount,p.payment_method,p.reference,p.payment_date,
            pl.name AS plaza_name,pl.location AS plaza_location,t.unit_number
     FROM payments p JOIN tenancies t ON t.id=p.tenancy_id JOIN users u ON u.id=t.tenant_id JOIN plazas pl ON pl.id=t.plaza_id
     WHERE p.id=? AND t.id=?`,
    [paymentId, tenancyId],
  );
  if (!results.length) return false;
  const d = results[0];
  const subject = "✅ Payment Confirmed — RentMS";
  const content = `<p>Dear <strong>${d.full_name || "Tenant"}</strong>,</p><p>Your rent payment has been received.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
      <tr style="background:#f1f5f9;"><td style="padding:10px 14px;font-weight:600;">Amount Paid</td><td style="padding:10px 14px;color:#16a34a;font-weight:700;">GHS ${parseFloat(d.amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}</td></tr>
      <tr><td style="padding:10px 14px;font-weight:600;">Reference</td><td style="padding:10px 14px;font-family:monospace;">${d.reference}</td></tr>
      <tr style="background:#f1f5f9;"><td style="padding:10px 14px;font-weight:600;">Method</td><td style="padding:10px 14px;text-transform:capitalize;">${d.payment_method}</td></tr>
      <tr><td style="padding:10px 14px;font-weight:600;">Plaza</td><td style="padding:10px 14px;">${d.plaza_name} — ${d.plaza_location}</td></tr>
      <tr style="background:#f1f5f9;"><td style="padding:10px 14px;font-weight:600;">Unit</td><td style="padding:10px 14px;">${d.unit_number || "N/A"}</td></tr>
      <tr><td style="padding:10px 14px;font-weight:600;">Date</td><td style="padding:10px 14px;">${formatGhanaDateTime(d.payment_date)}</td></tr>
    </table>`;
  const resendClient = getResend(app);
  return sendMail({
    resendClient,
    to: d.email,
    subject,
    html: baseTemplate(subject, content, "Keep this as your payment receipt."),
    userId: d.id,
  });
};

const sendWelcomeEmail = async ({ app = null, userId }) => {
  const [users] = await db.execute(
    `SELECT u.id,u.email,u.full_name,u.username,p.name AS plaza_name,p.location AS plaza_location,
            t.unit_number,t.rent_amount,t.lease_start,t.lease_end
     FROM users u LEFT JOIN tenancies t ON t.tenant_id=u.id AND t.status='active' LEFT JOIN plazas p ON p.id=t.plaza_id WHERE u.id=?`,
    [userId],
  );
  if (!users.length) return false;
  const u = users[0];
  const subject = "Welcome to RentMS Ghana 🎉";
  const content = `<p>Dear <strong>${u.full_name || u.username}</strong>,</p><p>Welcome to <strong>RentMS Ghana</strong>! Your account has been created successfully.</p>
    ${
      u.plaza_name
        ? `<table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr style="background:#f1f5f9;"><td style="padding:10px 14px;font-weight:600;">Plaza</td><td>${u.plaza_name} — ${u.plaza_location}</td></tr>
      <tr><td style="padding:10px 14px;font-weight:600;">Unit</td><td>${u.unit_number || "N/A"}</td></tr>
      <tr style="background:#f1f5f9;"><td style="padding:10px 14px;font-weight:600;">Monthly Rent</td><td style="color:#1e40af;font-weight:700;">GHS ${parseFloat(u.rent_amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}</td></tr>
      <tr><td style="padding:10px 14px;font-weight:600;">Lease Period</td><td>${formatDate(u.lease_start)} → ${formatDate(u.lease_end)}</td></tr>
    </table>`
        : ""
    }<p style="margin:20px 0;"><a href="${process.env.FRONTEND_URL || "http://localhost:5500"}/Tenants/dashboard.html" style="background:#1e40af;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Go to Dashboard</a></p>`;
  const resendClient = getResend(app);
  return sendMail({
    resendClient,
    to: u.email,
    subject,
    html: baseTemplate(
      subject,
      content,
      "If you did not register, ignore this email.",
    ),
    userId: u.id,
  });
};

const sendPasswordResetEmail = async ({
  app = null,
  userId,
  email,
  fullName,
  resetToken,
}) => {
  const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5500"}/auth/reset-password.html?token=${resetToken}`;
  const subject = "Reset Your RentMS Password";
  const content = `<p>Dear <strong>${fullName || "User"}</strong>,</p><p>Click below to reset your password:</p>
    <p style="margin:24px 0;"><a href="${resetUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Reset Password</a></p>
    <p style="color:#94a3b8;font-size:13px;">Expires in <strong>1 hour</strong>. If you didn't request this, ignore it.</p>`;
  const resendClient = getResend(app);
  return sendMail({
    resendClient,
    to: email,
    subject,
    html: baseTemplate(subject, content, "Link expires in 1 hour."),
    userId,
  });
};

module.exports = {
  sendMail,
  getResend,
  sendPaymentConfirmation,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  baseTemplate,
  logEmail,
};
