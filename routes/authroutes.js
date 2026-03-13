// routes/authRoutes.js
// ============================================================
// Base path: /api/auth
//
// Public endpoints (no JWT required):
//   POST  /api/auth/register
//   POST  /api/auth/login
//   POST  /api/auth/refresh
//   POST  /api/auth/forgot-password
//   POST  /api/auth/reset-password
//
// Protected endpoints (valid JWT required):
//   GET   /api/auth/me
//   PATCH /api/auth/me
//   POST  /api/auth/avatar
//   POST  /api/auth/logout
//   POST  /api/auth/change-password
//
// Rate limiters:
//   authLimiter    → 10 req / 15 min per IP  — credential + reset routes
//   generalLimiter → 200 req / 10 min per IP — baseline on token refresh
//   uploadLimiter  → stricter cap on file uploads
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const {
  authLimiter,
  generalLimiter,
  uploadLimiter,
} = require("../middleware/ratelimitMiddleware");
const { upload, handleUploadError } = require("../middleware/uploadMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  register,
  login,
  refreshToken,
  logout,
  getCurrentUser,
  updateProfile,
  uploadAvatar,
  forgotPassword,
  resetPassword,
  changePassword,
} = require("../controllers/authcontroller");

// ════════════════════════════════════════════════════════════
// PUBLIC ROUTES — No authentication required
// ════════════════════════════════════════════════════════════

/**
 * POST /api/auth/register
 * Register a new user.
 * Landlord: { username, email, phone?, full_name?, password, role: "landlord" }
 * Tenant:   same fields + invite_code (REQUIRED)
 *           → validates invite, creates user + tenancy in one transaction,
 *             notifies landlord.
 * Rate limited — prevents automated bulk account creation.
 */
router.post("/register", authLimiter, register);

/**
 * POST /api/auth/login
 * Authenticate and receive an access + refresh token pair.
 * Body: { email, password }
 * Rate limited — prevents brute-force credential attacks.
 */
router.post("/login", authLimiter, login);

/**
 * POST /api/auth/refresh
 * Exchange a valid refresh token for a new access + refresh token pair.
 * Old refresh token is rotated on every call.
 * Body: { refresh_token }
 * generalLimiter — less aggressive than authLimiter; normal app usage
 * triggers many refreshes.
 */
router.post("/refresh", generalLimiter, refreshToken);

/**
 * POST /api/auth/forgot-password
 * Send a password reset link to the provided email address.
 * Always returns 200 — prevents email enumeration.
 * Body: { email }
 * Rate limited — prevents reset email spam.
 */
router.post("/forgot-password", authLimiter, forgotPassword);

/**
 * POST /api/auth/reset-password
 * Reset password using a valid, unexpired reset token.
 * Also clears the stored refresh token — forces re-login everywhere.
 * Body: { token, new_password }
 *   new_password: min 8 chars, at least one letter and one number
 * Rate limited — prevents brute-force token guessing.
 */
router.post("/reset-password", authLimiter, resetPassword);

// ════════════════════════════════════════════════════════════
// PROTECTED ROUTES — Valid JWT required
// authMiddleware returns 401 if token is missing, invalid, or expired
// ════════════════════════════════════════════════════════════

/**
 * GET /api/auth/me
 * Get the currently authenticated user's profile.
 * Returns: safe user object (no password_hash).
 */
router.get("/me", authMiddleware, getCurrentUser);

/**
 * PATCH /api/auth/me
 * Update editable profile fields — username, full_name, phone, address.
 * Email and role cannot be changed here.
 * Body: { username?, full_name?, phone?, address? }
 * Returns the updated safe user object.
 */
router.patch("/me", authMiddleware, updateProfile);

/**
 * POST /api/auth/avatar
 * Upload or replace the authenticated user's profile avatar.
 * File field: "avatar" — images only, 10 MB max
 *             stored at uploads/profile/<filename>
 * Rate limited — prevents rapid avatar cycling / storage abuse.
 */
router.post(
  "/avatar",
  authMiddleware,
  uploadLimiter,
  upload.profile.single("avatar"),
  handleUploadError,
  uploadAvatar,
);

/**
 * POST /api/auth/logout
 * Clears the stored refresh token — invalidates the current session.
 * Body: none required (user identified via JWT).
 */
router.post("/logout", authMiddleware, logout);

/**
 * POST /api/auth/change-password
 * Update password for the authenticated user.
 * Also clears all stored refresh tokens — forces re-login on other devices.
 * Body: { current_password, new_password }
 *   new_password: min 8 chars, at least one letter and one number,
 *                 must differ from current password
 * Rate limited — prevents rapid password cycling.
 */
router.post("/change-password", authMiddleware, authLimiter, changePassword);

// ── Upload error handler ─────────────────────────────────────
// Must come after all routes that use upload middleware.
router.use(handleUploadError);

module.exports = router;





