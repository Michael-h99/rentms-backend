// routes/tenantRoutes.js
// ============================================================
// Base path: /api/tenant
// All routes require valid JWT + tenant role.
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
} = require("../controllers/tenantcontroller");

// ── Global Protection ────────────────────────────────────────
router.use(authMiddleware);
router.use(roleMiddleware(["tenant"]));

// ════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════
router.get("/dashboard", getDashboard);

// ════════════════════════════════════════════════════════════
// LEASE
// ════════════════════════════════════════════════════════════
router.get("/lease", getMyLease);
router.get("/lease/history", getLeaseHistory);
router.post("/lease/renewal", requestLeaseRenewal);

// ════════════════════════════════════════════════════════════
// PLAZA
// ════════════════════════════════════════════════════════════
router.get("/plaza", getMyPlaza);
router.get("/neighbours", getMyNeighbours);

// ════════════════════════════════════════════════════════════
// GROUPS
// FIX: static routes (/groups, /groups/join) MUST be declared
// BEFORE parameterised routes (/groups/:group_id/...).
// Express matches routes top-to-bottom — if /:group_id comes
// first, "join" gets treated as a group_id and the wrong
// handler runs, causing 400 "Invalid group ID" errors.
// ════════════════════════════════════════════════════════════

// Static routes first
router.get("/groups", getMyGroups);
router.post("/groups/join", joinGroup);

// Parameterised routes after
router.delete("/groups/:group_id/leave", leaveGroup);
router.get("/groups/:group_id/messages", generalLimiter, getGroupMessages);
router.post(
  "/groups/:group_id/messages",
  uploadLimiter,
  upload.groupMessage.single("file"),
  handleUploadError,
  sendGroupMessage,
);

// ── Upload error handler ─────────────────────────────────────
router.use(handleUploadError);

module.exports = router;
