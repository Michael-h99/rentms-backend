// controllers/contactcontroller.js
// ============================================================
// Public homepage contact form. No authentication — anyone can
// submit this, so input is validated strictly and the endpoint
// sits behind contactLimiter (5 req / 15 min per IP).
// ============================================================

const { AppError, asyncHandler } = require("../utils/errorhandler");
const {
  sendMail,
  baseTemplate,
  getResend,
} = require("../services/emailservice");

const CONTACT_INBOX = process.env.CONTACT_EMAIL || process.env.EMAIL_FROM;

// Very small, permissive email check — good enough to reject
// obvious garbage without blocking real addresses.
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Basic HTML-escaping so submitted text can't break the email markup.
const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// POST /api/contact
// Body: { name, email, message, subject? }
const submitContactForm = asyncHandler(async (req, res) => {
  const { name, email, message, subject } = req.body;

  const trimmedName = (name || "").trim();
  const trimmedEmail = (email || "").trim();
  const trimmedMessage = (message || "").trim();

  if (!trimmedName || !trimmedEmail || !trimmedMessage) {
    throw new AppError("Name, email, and message are all required", 400);
  }
  if (trimmedName.length > 100) {
    throw new AppError("Name is too long", 400);
  }
  if (!isValidEmail(trimmedEmail)) {
    throw new AppError("Please provide a valid email address", 400);
  }
  if (trimmedMessage.length > 3000) {
    throw new AppError("Message is too long (max 3000 characters)", 400);
  }
  if (!CONTACT_INBOX) {
    // Fails loudly rather than silently swallowing a message no one will see.
    throw new AppError(
      "Contact form is not configured — missing CONTACT_EMAIL",
      500,
      false,
    );
  }

  const emailSubject = `New contact form message${
    subject ? `: ${subject}` : ""
  }`;

  const content = `
    <p><strong>From:</strong> ${escapeHtml(trimmedName)} (${escapeHtml(trimmedEmail)})</p>
    ${subject ? `<p><strong>Topic:</strong> ${escapeHtml(subject)}</p>` : ""}
    <p style="white-space: pre-wrap; border-left: 3px solid #22c55e; padding-left: 12px; margin-top: 16px;">${escapeHtml(
      trimmedMessage,
    )}</p>
  `;

  const sent = await sendMail({
    resendClient: getResend(req.app),
    to: CONTACT_INBOX,
    subject: emailSubject,
    html: baseTemplate(
      emailSubject,
      content,
      `Reply directly to ${trimmedEmail}.`,
    ),
    userId: null,
  });

  if (!sent) {
    throw new AppError(
      "Could not send your message right now. Please try again shortly.",
      502,
    );
  }

  return res.status(200).json({
    success: true,
    message: "Message sent — we'll get back to you soon.",
  });
});

module.exports = { submitContactForm };
