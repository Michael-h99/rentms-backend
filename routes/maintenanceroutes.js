// routes/maintenanceRoutes.js
// ============================================================
// Base path: /api/maintenance
// All routes require a valid JWT.
//
// Endpoints:
//   POST   /api/maintenance              — tenant only
//   GET    /api/maintenance/my           — tenant only
//   GET    /api/maintenance/landlord     — landlord only
//   GET    /api/maintenance/admin        — admin only
//   GET    /api/maintenance/summary      — admin only
//   GET    /api/maintenance/:id          — tenant (own) | landlord (own plaza) | admin
//   PUT    /api/maintenance/:id          — tenant (own, pending only)
//   DELETE /api/maintenance/:id          — tenant (own, pending only)
//   PATCH  /api/maintenance/:id/status   — landlord, admin
//   GET    /api/maintenance/:id/logs     — tenant (own) | landlord (own plaza) | admin
//
// Route ordering note:
//   Static paths (/my, /landlord, /admin, /summary) are declared
//   before parameterised paths (/:id) to prevent Express from
//   matching a keyword as a request ID.
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const { roleMiddleware } = require("../middleware/roleMiddleware");
const ownershipMiddleware = require("../middleware/ownershipMiddleware");
const { upload, handleUploadError } = require("../middleware/uploadMiddleware");
const {
  generalLimiter,
  uploadLimiter,
} = require("../middleware/ratelimitMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  createRequest,
  getTenantRequests,
  getRequestById,
  updateRequest,
  deleteRequest,
  getLandlordRequests,
  getAllRequests,
  getMonthlySummary,
  updateMaintenanceStatus,
  getMaintenanceLogs,
} = require("../controllers/maintenanceController");

// ── Global Protection ────────────────────────────────────────
// All maintenance routes require a valid JWT — 401 if missing/expired
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════
// TENANT ROUTES
// ════════════════════════════════════════════════════════════

/**
 * POST /api/maintenance
 * Tenant submits a new maintenance request.
 * Looks up active tenancy to determine plaza and landlord.
 * Notifies landlord on creation (non-fatal).
 * Body: { title, description, priority? }
 *   priority: "low" | "medium" (default) | "high"
 * File: optional "attachment" — images/PDF, 10 MB max
 *       stored at uploads/maintenance/<filename>
 * Rate limited — prevents attachment abuse.
 */
router.post(
  "/",
  roleMiddleware(["tenant"]),
  uploadLimiter,
  upload.maintenance.single("attachment"),
  handleUploadError,
  createRequest,
);

/**
 * GET /api/maintenance/my
 * All requests submitted by the authenticated tenant, paginated.
 * High-priority open requests surfaced first.
 * Query params: page, limit,
 *               status ("pending"|"in_progress"|"resolved"|"rejected"),
 *               priority ("low"|"medium"|"high")
 */
router.get("/my", roleMiddleware(["tenant"]), getTenantRequests);

// ════════════════════════════════════════════════════════════
// LANDLORD ROUTES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/maintenance/landlord
 * All requests across the landlord's plazas, high-priority first.
 * Query params: page, limit, status, priority, plaza_id
 */
router.get("/landlord", roleMiddleware(["landlord"]), getLandlordRequests);

// ════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/maintenance/admin
 * All maintenance requests platform-wide — paginated.
 * Query params: page, limit, status, priority, plaza_id, tenant_id
 */
router.get("/admin", roleMiddleware(["admin"]), getAllRequests);

/**
 * GET /api/maintenance/summary
 * Monthly breakdown by status and priority + avg resolution time.
 * Query params: month (1–12), year (YYYY)
 */
router.get("/summary", roleMiddleware(["admin"]), getMonthlySummary);

// ════════════════════════════════════════════════════════════
// PARAMETERISED ROUTES — declared after all static paths
// ════════════════════════════════════════════════════════════

/**
 * GET /api/maintenance/:id
 * Single request with full context (plaza, tenant, landlord).
 * Scoped by role:
 *   Tenant   — own requests only (403 otherwise)
 *   Landlord — own plaza requests only (403 otherwise)
 *   Admin    — any request
 */
router.get("/:id", getRequestById);

/**
 * PUT /api/maintenance/:id
 * Tenant edits a pending request — title, description, priority.
 * Returns 400 if status is not "pending".
 * Returns 403 if the request does not belong to this tenant.
 * Body: { title?, description?, priority? }
 */
router.put("/:id", roleMiddleware(["tenant"]), updateRequest);

/**
 * DELETE /api/maintenance/:id
 * Tenant deletes a pending request.
 * Returns 400 if status is not "pending".
 * Returns 403 if the request does not belong to this tenant.
 */
router.delete("/:id", roleMiddleware(["tenant"]), deleteRequest);

/**
 * PATCH /api/maintenance/:id/status
 * Update request status — landlord or admin.
 * Setting "resolved" automatically sets resolved_at.
 * Writes a row to maintenance_logs and notifies the tenant.
 * Landlord ownership enforced in controller (403 if not their plaza).
 * ownershipMiddleware provides a second layer of access control.
 * Body: { status, note? }
 *   status: "pending" | "in_progress" | "resolved" | "rejected"
 */
router.patch(
  "/:id/status",
  roleMiddleware(["admin", "landlord"]),
  ownershipMiddleware("maintenance_request"),
  updateMaintenanceStatus,
);

/**
 * GET /api/maintenance/:id/logs
 * Full status-change history from the maintenance_logs table.
 * Scoped by role — same access rules as GET /:id.
 * ownershipMiddleware confirms access before returning logs.
 */
router.get(
  "/:id/logs",
  ownershipMiddleware("maintenance_request"),
  getMaintenanceLogs,
);

// ── Upload error handler ─────────────────────────────────────
// Must come after all routes that use upload middleware.
router.use(handleUploadError);

module.exports = router;
