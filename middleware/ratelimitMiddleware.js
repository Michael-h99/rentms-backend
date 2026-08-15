// middleware/rateLimitMiddleware.js
// ============================================================
// Centralised rate limiting for all API routes.
//
// Usage in routes:
//   const { authLimiter, generalLimiter } = require("../middleware/rateLimitMiddleware");
//   router.post("/login", authLimiter, loginHandler);
//   router.use(generalLimiter); // broad baseline in app.js
//
// Dependency:
//   npm install express-rate-limit
// ============================================================

const rateLimit = require("express-rate-limit");

// ── Shared response factory ───────────────────────────────────
// Response format matches the rest of the codebase:
//   { success: false, message: "..." }
// Logs blocked request with IP, route, and user ID for auditing.
const makeLimiter = (options) =>
  rateLimit({
    standardHeaders: true, // Return limit info in RateLimit-* headers
    legacyHeaders: false, // Disable deprecated X-RateLimit-* headers
    handler: (req, res) => {
      console.warn(
        `[RATE LIMIT] Blocked — IP: ${req.ip}, route: ${req.originalUrl}, ` +
          `user: ${req.user?.id ?? "unauthenticated"}`,
      );
      return res.status(429).json({
        success: false,
        message: options.message,
      });
    },
    ...options,
  });

// ── Auth Limiter ──────────────────────────────────────────────
// Routes: /login, /register, /forgot-password, /reset-password
//         /change-password, admin /reset-password
// 10 requests per 15 min per IP.
// Failed requests still count — intentional, prevents credential stuffing.
const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: "Too many attempts. Please wait 15 minutes before trying again.",
});

// ── Payment Limiter ───────────────────────────────────────────
// Routes: POST /payments
// 20 requests per hour per IP.
// skipSuccessfulRequests: true — successful payments don't eat into the
// limit; only failed/rejected attempts count (prevents flooding).
const paymentLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  skipSuccessfulRequests: true,
  message:
    "Too many payment requests. Please wait before submitting another payment.",
});

// ── Notification / Email Limiter ──────────────────────────────
// Routes: /notifications/send, /notifications/broadcast, /email/*
// 30 requests per hour per IP — prevents notification spam.
const notificationLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: "Too many notification requests. Please wait before sending more.",
});

// ── Upload Limiter ────────────────────────────────────────────
// Routes: any route using uploadMiddleware
// 50 uploads per hour per IP — prevents upload abuse / storage flooding.
const uploadLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  message: "Too many file uploads. Please wait before uploading more files.",
});

// ── Contact Limiter ────────────────────────────────────────────
// Route: public POST /api/contact (no auth — anyone can hit this)
// Tighter than authLimiter since it's unauthenticated and sends
// real email through Resend on every success.
// 5 requests per 15 min per IP.
const contactLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: "Too many messages sent. Please try again later.",
});

// ── General Limiter ───────────────────────────────────────────
// Applied broadly in app.js as a baseline across all routes.
// 200 requests per 10 min per IP.
const generalLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 200,
  message: "Too many requests. Please slow down and try again shortly.",
});

module.exports = {
  authLimiter,
  paymentLimiter,
  notificationLimiter,
  uploadLimiter,
  contactLimiter,
  generalLimiter,
};
