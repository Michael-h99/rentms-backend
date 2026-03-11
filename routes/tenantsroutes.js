// routes/tenantRoutes.js
// ============================================================
// Base path: /api/tenant
// All routes require valid JWT + tenant role.
//
// Covers:
//   Dashboard   GET  /api/tenant/dashboard
//   Lease       GET  /api/tenant/lease
//               GET  /api/tenant/lease/history
//               POST /api/tenant/lease/renewal
//   Plaza       GET  /api/tenant/plaza
//               GET  /api/tenant/neighbours
//   Groups      GET  /api/tenant/groups
//               POST /api/tenant/groups/join
//               DEL  /api/tenant/groups/:group_id/leave
//               GET  /api/tenant/groups/:group_id/messages
//               POST /api/tenant/groups/:group_id/messages
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const { roleMiddleware } = require("../middleware/roleMiddleware");
const { upload, handleUploadError } = require("../middleware/uploadMiddleware");
const {
  uploadLimiter,
  generalLimiter,
} = require("../middleware/ratelimitMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  getDashboard,
  getMyLease,
  getLeaseHistory,
  requestLeaseRenewal,
  getMyPlaza,
  getMyNeighbours,
  getMyGroups,
  joinGroup,
  leaveGroup,
  getGroupMessages,
  sendGroupMessage,
} = require("../controllers/tenantController");

// ── Global Protection ────────────────────────────────────────
// Every route below requires valid JWT (401) + tenant role (403)
router.use(authMiddleware);
router.use(roleMiddleware(["tenant"]));

// ════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════

/**
 * GET /api/tenant/dashboard
 * Returns active lease, this-month payment summary, overdue flag,
 * open maintenance count, and unread notification count.
 * Powers the tenant dashboard page in a single call.
 */
router.get("/dashboard", getDashboard);

// ════════════════════════════════════════════════════════════
// LEASE
// ════════════════════════════════════════════════════════════

/**
 * GET /api/tenant/lease
 * Full details of the tenant's currently active lease.
 * Includes plaza, landlord, unit number, dates, and rent amount.
 * Returns 404 if no active lease exists.
 */
router.get("/lease", getMyLease);

/**
 * GET /api/tenant/lease/history
 * All leases (active + expired) for the tenant, paginated.
 * Query params: page, limit, status
 */
router.get("/lease/history", getLeaseHistory);

/**
 * POST /api/tenant/lease/renewal
 * Tenant sends a renewal request notification to their landlord.
 * Does not change the lease record — landlord acts separately.
 * Body: { message? }  — optional personal note to landlord
 * Returns 404 if no active lease found.
 */
router.post("/lease/renewal", requestLeaseRenewal);

// ════════════════════════════════════════════════════════════
// PLAZA
// ════════════════════════════════════════════════════════════

/**
 * GET /api/tenant/plaza
 * Details of the plaza the tenant lives in, including
 * landlord name, email, phone, and avatar for the contact card.
 * Returns 404 if no active tenancy found.
 */
router.get("/plaza", getMyPlaza);

/**
 * GET /api/tenant/neighbours
 * Other active tenants in the same plaza.
 * Returns name, unit number, and avatar only — email withheld for privacy.
 * Returns 404 if no active tenancy found.
 */
router.get("/neighbours", getMyNeighbours);

// ════════════════════════════════════════════════════════════
// GROUPS
// ════════════════════════════════════════════════════════════

/**
 * GET /api/tenant/groups
 * All plaza groups the authenticated tenant belongs to.
 * Returns group name, plaza info, join date, and member count.
 */
router.get("/groups", getMyGroups);

/**
 * POST /api/tenant/groups/join
 * Join a plaza group using a landlord-issued invite code.
 * Body: { invite_code }  — must be active and not expired
 * Returns 400 if already a member or invite code is invalid/expired.
 * Returns 404 if no group exists for the code's plaza.
 */
router.post("/groups/join", joinGroup);

/**
 * DELETE /api/tenant/groups/:group_id/leave
 * Leave a group the tenant currently belongs to.
 * Notifies the landlord on successful leave (non-fatal).
 * Returns 400 if the tenant is not a member of the group.
 */
router.delete("/groups/:group_id/leave", leaveGroup);

/**
 * GET /api/tenant/groups/:group_id/messages
 * Paginated messages for a group the tenant belongs to.
 * Membership verified before returning messages — 403 if not a member.
 * Messages ordered oldest → newest for chat view.
 * Query params: page, limit
 */
router.get("/groups/:group_id/messages", generalLimiter, getGroupMessages);

/**
 * POST /api/tenant/groups/:group_id/messages
 * Send a message to a plaza group — text, file, or both.
 * Body: { content? } + optional file field "file"
 * File types: images (jpg/png/gif/webp), PDF, DOC, DOCX — 10 MB max
 *             stored at uploads/group_messages/<filename>
 * Notifies all other group members in-app (non-fatal).
 * Rate limited via uploadLimiter — prevents message and upload abuse.
 */
router.post(
  "/groups/:group_id/messages",
  uploadLimiter,
  upload.groupMessage.single("file"),
  handleUploadError,
  sendGroupMessage,
);

// ── Upload error handler ─────────────────────────────────────
// Must come after all routes that use upload middleware.
router.use(handleUploadError);

module.exports = router;
