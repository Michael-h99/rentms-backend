// routes/adminRoutes.js
// ============================================================
// Base path: /api/admin
// All routes require valid JWT + admin role.
//
// Endpoints:
//   Dashboard:
//     GET    /api/admin/dashboard
//   Users:
//     GET    /api/admin/users
//     GET    /api/admin/users/:id
//     PATCH  /api/admin/users/:id
//     PATCH  /api/admin/users/:id/role
//     PATCH  /api/admin/users/:id/status
//     DELETE /api/admin/users/:id
//   User sub-resources:
//     GET    /api/admin/users/:id/logs
//     POST   /api/admin/users/:id/reset-password
//   Platform-wide data:
//     GET    /api/admin/payments
//     GET    /api/admin/maintenance
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const { roleMiddleware } = require("../middleware/roleMiddleware");
const {
  generalLimiter,
  authLimiter,
} = require("../middleware/ratelimitMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  getDashboardStats,
  getAllUsers,
  getUserById,
  updateUser,
  updateUserRole,
  updateUserStatus,
  deleteUser,
  getUserActivityLogs,
  triggerUserPasswordReset,
  getAllPayments,
  getAllMaintenance,
} = require("../controllers/admincontroller");

// ── Global Protection ────────────────────────────────────────
// All admin routes require valid JWT (401) + admin role (403)
router.use(authMiddleware);
router.use(roleMiddleware(["admin"]));

// ════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════

/**
 * GET /api/admin/dashboard
 * Platform-wide summary: users by role/status, plazas,
 * tenancies, payments (revenue, paid/pending/failed),
 * maintenance by status, and today's activity count.
 */
router.get("/dashboard", getDashboardStats);

// ════════════════════════════════════════════════════════════
// USER MANAGEMENT
// Static paths (/users) before parameterised (/users/:id)
// ════════════════════════════════════════════════════════════

/**
 * GET /api/admin/users
 * Paginated user list — never returns password_hash.
 * Query params: page, limit,
 *               role ("tenant"|"landlord"|"admin"),
 *               status ("active"|"suspended"|"blacklisted"),
 *               search (matches username, email, full_name)
 */
router.get("/users", getAllUsers);

/**
 * GET /api/admin/users/:id
 * Full user profile with related counts:
 * total_tenancies, total_maintenance, total_payments, total_activity_logs.
 * Payments are joined through tenancies (no payments.tenant_id column).
 */
router.get("/users/:id", getUserById);

/**
 * PATCH /api/admin/users/:id
 * Update profile fields — username, full_name, email, phone.
 * Role and status have dedicated PATCH endpoints below.
 * Body: { username?, full_name?, email?, phone? }
 */
router.patch("/users/:id", updateUser);

/**
 * PATCH /api/admin/users/:id/role
 * Change a user's role.
 * Cannot change own role.
 * Cannot assign a role higher than the admin's own role.
 * Sends an in-app notification to the affected user.
 * Body: { role: "tenant" | "landlord" | "admin" }
 */
router.patch("/users/:id/role", updateUserRole);

/**
 * PATCH /api/admin/users/:id/status
 * Suspend, blacklist, or re-activate a user account.
 * Suspending/blacklisting also invalidates all active refresh tokens.
 * Cannot change own status or the status of an equal/higher-role user.
 * Sends an in-app notification to the affected user.
 * Body: { status: "active" | "suspended" | "blacklisted" }
 */
router.patch("/users/:id/status", updateUserStatus);

/**
 * DELETE /api/admin/users/:id
 * Soft-delete a user (sets deleted_at, clears refresh_token).
 * Cannot delete own account or a user of equal/higher role.
 */
router.delete("/users/:id", deleteUser);

// ════════════════════════════════════════════════════════════
// USER SUB-RESOURCES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/admin/users/:id/logs
 * Paginated activity log entries for a specific user.
 * Query params: page, limit
 */
router.get("/users/:id/logs", generalLimiter, getUserActivityLogs);

/**
 * POST /api/admin/users/:id/reset-password
 * Admin triggers a password reset email for any user.
 * Generates a 1-hour reset token and emails the link.
 * Cannot be used on self — use /api/auth/change-password.
 * Tight rate limit — prevents admin account from being used
 * to spam password reset emails.
 */
router.post("/users/:id/reset-password", authLimiter, triggerUserPasswordReset);

// ════════════════════════════════════════════════════════════
// PLATFORM-WIDE DATA
// Admin-scoped equivalents — no req.user.id scoping
// ════════════════════════════════════════════════════════════

/**
 * GET /api/admin/payments
 * All payments platform-wide — paginated.
 * Joins through tenancies (no payments.tenant_id column).
 * Query params: page, limit,
 *               from (YYYY-MM-DD), to (YYYY-MM-DD),
 *               status ("paid"|"pending"|"failed"),
 *               plaza_id, user_id
 */
router.get("/payments", getAllPayments);

/**
 * GET /api/admin/maintenance
 * All maintenance requests platform-wide — paginated.
 * High-priority open requests surfaced first.
 * Query params: page, limit, status, priority, plaza_id, user_id
 */
router.get("/maintenance", getAllMaintenance);

module.exports = router;


