// routes/adminRoutes.js
// ============================================================
// Base path: /api/admin
// All routes require valid JWT + admin role.
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
  getAllPlazas,
  getAllLeases,
} = require("../controllers/admincontroller");

// ── Global Protection ────────────────────────────────────────
router.use(authMiddleware);
router.use(roleMiddleware(["admin"]));

// ════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════
router.get("/dashboard", getDashboardStats);

// ════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ════════════════════════════════════════════════════════════
router.get("/users", getAllUsers);
router.get("/users/:id", getUserById);
router.patch("/users/:id", updateUser);
router.patch("/users/:id/role", updateUserRole);
router.patch("/users/:id/status", updateUserStatus);
router.delete("/users/:id", deleteUser);
router.get("/users/:id/logs", generalLimiter, getUserActivityLogs);
router.post("/users/:id/reset-password", authLimiter, triggerUserPasswordReset);

// ════════════════════════════════════════════════════════════
// PLATFORM-WIDE DATA
// ════════════════════════════════════════════════════════════
router.get("/payments", getAllPayments);
router.get("/maintenance", getAllMaintenance);
router.get("/plazas", getAllPlazas);
router.get("/leases", getAllLeases);

module.exports = router;
