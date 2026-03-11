// routes/landlordRoutes.js
// ============================================================
// Base path: /api/landlords
// All routes require valid JWT + landlord or admin role.
//
// Endpoints:
//   Plazas:
//     GET    /api/landlords/plazas                  — own plazas + occupancy
//     POST   /api/landlords/plazas                  — create plaza
//     GET    /api/landlords/plazas/:id              — single plaza + live stats
//     PUT    /api/landlords/plazas/:id              — update plaza
//     DELETE /api/landlords/plazas/:id              — soft-delete plaza
//   Tenants:
//     GET    /api/landlords/plazas/:id/tenants      — list tenants in plaza
//     POST   /api/landlords/plazas/:id/invite       — generate invite code
//     DELETE /api/landlords/tenancies/:id/tenant    — expire tenancy
//   Payments:
//     GET    /api/landlords/payments                — own payment history
//   Maintenance:
//     GET    /api/landlords/maintenance             — own maintenance requests
//     PATCH  /api/landlords/maintenance/:id/status  — update request status
//   Groups:
//     GET    /api/landlords/groups                  — own groups list
//     POST   /api/landlords/groups                  — create group
//     GET    /api/landlords/groups/:id/messages     — group message history
//     POST   /api/landlords/groups/:id/messages     — send message to group
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const { roleMiddleware } = require("../middleware/roleMiddleware");
const ownershipMiddleware = require("../middleware/ownershipMiddleware");
const { upload, handleUploadError } = require("../middleware/uploadMiddleware");
const {
  notificationLimiter,
  uploadLimiter,
  generalLimiter,
} = require("../middleware/ratelimitMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  // Plazas
  getLandlordPlazas,
  getPlazaById,
  createPlaza,
  updatePlaza,
  deletePlaza,
  // Tenants
  getPlazaTenants,
  inviteTenant,
  removeTenant,
  // Payments
  getRentPayments,
  // Maintenance
  getMaintenanceRequests,
  updateMaintenanceStatus,
  // Groups
  createPlazaGroup,
  getLandlordGroups,
  getGroupMessages,
  sendGroupMessageLandlord,
} = require("../controllers/landlordController");

// ── Global Protection ────────────────────────────────────────
// All landlord routes require valid JWT (401) + landlord or admin role (403)
router.use(authMiddleware);
router.use(roleMiddleware(["admin", "landlord"]));

// ════════════════════════════════════════════════════════════
// PLAZA MANAGEMENT
// ════════════════════════════════════════════════════════════

/**
 * GET /api/landlords/plazas
 * All plazas owned by the landlord with occupied/vacant unit counts.
 * Query params: page, limit
 */
router.get("/plazas", getLandlordPlazas);

/**
 * POST /api/landlords/plazas
 * Create a new plaza.
 * Body: { name, location, total_units }
 */
router.post("/plazas", createPlaza);

/**
 * GET /api/landlords/plazas/:id
 * Single plaza with live stats: active tenants, this-month revenue,
 * open maintenance count.
 * Returns 403 if the landlord does not own this plaza.
 */
router.get("/plazas/:id", ownershipMiddleware("plaza"), getPlazaById);

/**
 * PUT /api/landlords/plazas/:id
 * Update plaza name, location, or total_units.
 * ownershipMiddleware confirms plaza belongs to this landlord.
 * Body: { name?, location?, total_units? }
 */
router.put("/plazas/:id", ownershipMiddleware("plaza"), updatePlaza);

/**
 * DELETE /api/landlords/plazas/:id
 * Soft-delete a plaza (sets deleted_at).
 * Returns 400 if the plaza still has active tenancies.
 */
router.delete("/plazas/:id", ownershipMiddleware("plaza"), deletePlaza);

// ════════════════════════════════════════════════════════════
// TENANT MANAGEMENT
// ════════════════════════════════════════════════════════════

/**
 * GET /api/landlords/plazas/:id/tenants
 * Paginated list of tenants in a plaza with lease details.
 * ownershipMiddleware confirms plaza belongs to this landlord.
 * Query params: page, limit, status ("active"|"expired")
 */
router.get(
  "/plazas/:id/tenants",
  ownershipMiddleware("plaza"),
  getPlazaTenants,
);

/**
 * POST /api/landlords/plazas/:id/invite
 * Generate an invite code for a new tenant to self-register.
 * Tenant uses the code at POST /api/auth/register.
 * ownershipMiddleware confirms plaza belongs to this landlord.
 * Body: { unit_number, rent_amount, lease_start, lease_end,
 *         max_uses? (default 1), expires_days? (default 30) }
 * Rate limited — prevents invite code spam.
 */
router.post(
  "/plazas/:id/invite",
  ownershipMiddleware("plaza"),
  notificationLimiter,
  inviteTenant,
);

/**
 * DELETE /api/landlords/tenancies/:id/tenant
 * Expire a tenant's active tenancy (status → "expired").
 * Sends a tenancy_update notification to the tenant.
 * ownershipMiddleware confirms tenancy belongs to this landlord's plaza.
 */
router.delete(
  "/tenancies/:id/tenant",
  ownershipMiddleware("tenancy"),
  removeTenant,
);

// ════════════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════════════

/**
 * GET /api/landlords/payments
 * All rent payments across the landlord's plazas — paginated.
 * Query params: page, limit, from (YYYY-MM-DD), to (YYYY-MM-DD),
 *               plaza_id, status ("paid"|"pending"|"failed")
 */
router.get("/payments", getRentPayments);

// ════════════════════════════════════════════════════════════
// MAINTENANCE
// ════════════════════════════════════════════════════════════

/**
 * GET /api/landlords/maintenance
 * All maintenance requests across the landlord's plazas.
 * High-priority open requests surfaced first.
 * Query params: page, limit, status, priority, plaza_id
 */
router.get("/maintenance", getMaintenanceRequests);

/**
 * PATCH /api/landlords/maintenance/:id/status
 * Update the status of a maintenance request.
 * Setting "resolved" auto-sets resolved_at.
 * Writes to maintenance_logs and notifies the tenant.
 * ownershipMiddleware confirms the request belongs to this landlord's plaza.
 * Body: { status, note? }
 *   status: "pending" | "in_progress" | "resolved" | "rejected"
 */
router.patch(
  "/maintenance/:id/status",
  ownershipMiddleware("maintenance_request"),
  updateMaintenanceStatus,
);

// ════════════════════════════════════════════════════════════
// PLAZA GROUPS
// ════════════════════════════════════════════════════════════

/**
 * GET /api/landlords/groups
 * All plaza groups the landlord owns with member counts.
 * Query params: plaza_id? (filter to one plaza)
 */
router.get("/groups", getLandlordGroups);

/**
 * POST /api/landlords/groups
 * Create a new group for a plaza.
 * Body: { plaza_id, name }
 * Plaza ownership verified in controller.
 */
router.post("/groups", createPlazaGroup);

/**
 * GET /api/landlords/groups/:id/messages
 * Paginated message history for a group the landlord owns.
 * Ordered oldest → newest for chat view.
 * ownershipMiddleware confirms group belongs to this landlord.
 * Query params: page, limit
 */
router.get(
  "/groups/:id/messages",
  ownershipMiddleware("group"),
  generalLimiter,
  getGroupMessages,
);

/**
 * POST /api/landlords/groups/:id/messages
 * Send a message to a plaza group — text, file, or both.
 * Emits real-time event via Socket.io to the group_<id> room.
 * Notifies all group members in-app (non-fatal).
 * ownershipMiddleware confirms group belongs to this landlord.
 * Body: { content? } + optional file field "file"
 * File: images/PDF/DOC, 10 MB max — uploads/group_messages/<filename>
 * Rate limited.
 */
router.post(
  "/groups/:id/messages",
  ownershipMiddleware("group"),
  uploadLimiter,
  upload.groupMessage.single("file"),
  handleUploadError,
  sendGroupMessageLandlord,
);

// ── Upload error handler ─────────────────────────────────────
// Must come after all routes that use upload middleware.
router.use(handleUploadError);

module.exports = router;
