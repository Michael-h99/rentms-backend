// routes/landlordRoutes.js
// ============================================================
// Base path: /api/landlord  (singular — matches app.js registration)
// All routes require valid JWT + landlord or admin role.
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
  getLandlordPlazas,
  getPlazaById,
  createPlaza,
  updatePlaza,
  deletePlaza,
  getPlazaTenants,
  inviteTenant,
  removeTenant,
  getRentPayments,
  getMaintenanceRequests,
  updateMaintenanceStatus,
  createPlazaGroup,
  getLandlordGroups,
  getGroupMessages,
  getGroupMembers,
  sendGroupMessageLandlord,
  uploadPlazaImage,
} = require("../controllers/landlordcontroller");

// ── Global Protection ────────────────────────────────────────
router.use(authMiddleware);
router.use(roleMiddleware(["admin", "landlord"]));

// ════════════════════════════════════════════════════════════
// PLAZA MANAGEMENT
// ════════════════════════════════════════════════════════════

router.get("/plazas", getLandlordPlazas);
router.post(
  "/plazas",
  upload.profile.single("image"),
  handleUploadError,
  createPlaza,
);
/* Plaza standalone image upload — for the upload zone in plazas.html */
router.post(
  "/plazas/upload-image",
  upload.profile.single("image"),
  handleUploadError,
  async (req, res) => {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "No image provided" });
    /* FIX: file is saved to uploads/profile/ by upload.profile middleware */
    const imageUrl = "uploads/profile/" + req.file.filename;
    return res.json({ success: true, data: { image_url: imageUrl } });
  },
);
router.get("/plazas/:id", ownershipMiddleware("plaza"), getPlazaById);
router.put(
  "/plazas/:id",
  ownershipMiddleware("plaza"),
  upload.profile.single("image"),
  handleUploadError,
  updatePlaza,
);
router.delete("/plazas/:id", ownershipMiddleware("plaza"), deletePlaza);

/* POST /plazas/:id/image — upload plaza cover photo */
router.post(
  "/plazas/:id/image",
  ownershipMiddleware("plaza"),
  uploadLimiter,
  upload.groupMessage.single("image"),
  handleUploadError,
  uploadPlazaImage,
);

/* POST /plazas/:id/image — upload plaza cover photo
   Uses groupMessage upload config (images allowed, 10MB max) */
router.post(
  "/plazas/:id/image",
  ownershipMiddleware("plaza"),
  uploadLimiter,
  upload.groupMessage.single("image"),
  handleUploadError,
  uploadPlazaImage,
);

// ════════════════════════════════════════════════════════════
// TENANT MANAGEMENT
// ════════════════════════════════════════════════════════════

router.get(
  "/plazas/:id/tenants",
  ownershipMiddleware("plaza"),
  getPlazaTenants,
);
router.post(
  "/plazas/:id/invite",
  ownershipMiddleware("plaza"),
  notificationLimiter,
  inviteTenant,
);
router.delete(
  "/tenancies/:id/tenant",
  ownershipMiddleware("tenancy"),
  removeTenant,
);

// ════════════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════════════

router.get("/payments", getRentPayments);

// ════════════════════════════════════════════════════════════
// MAINTENANCE
// ════════════════════════════════════════════════════════════

router.get("/maintenance", getMaintenanceRequests);

/* FIX: landlord.js calls PUT /landlord/maintenance/:id — add PUT alias
   alongside the PATCH route so both work */
router.patch(
  "/maintenance/:id",
  ownershipMiddleware("maintenance_request"),
  updateMaintenanceStatus,
);
router.put(
  "/maintenance/:id",
  ownershipMiddleware("maintenance_request"),
  updateMaintenanceStatus,
);

/* Keep the original /status sub-path too for backwards compat */
router.patch(
  "/maintenance/:id/status",
  ownershipMiddleware("maintenance_request"),
  updateMaintenanceStatus,
);
router.put(
  "/maintenance/:id/status",
  ownershipMiddleware("maintenance_request"),
  updateMaintenanceStatus,
);

// ════════════════════════════════════════════════════════════
// PLAZA GROUPS
// FIX: removed ownershipMiddleware("group") from both group message
// routes — it was querying group_members with wrong params causing
// "Incorrect arguments to mysqld_stmt_execute" 500 errors.
// The controller (getGroupMessages, sendGroupMessageLandlord) already
// does its own ownership check via plaza_groups JOIN plazas.
// ════════════════════════════════════════════════════════════

router.get("/groups", getLandlordGroups);
router.post("/groups", createPlazaGroup);

/* FIX: PUT /groups/:id — needed for regenCode() in landlord.js */
router.put("/groups/:id", async (req, res) => {
  const db = require("../utils/db");
  const { AppError, asyncHandler } = require("../utils/errorhandler");
  const groupId = parseInt(req.params.id, 10);
  const landlordId = Number(req.user.id);
  const { invite_code, name } = req.body;

  const [[group]] = await db.execute(
    `SELECT pg.id FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id
     WHERE pg.id = ? AND p.landlord_id = ?`,
    [groupId, landlordId],
  );
  if (!group)
    return res.status(403).json({ success: false, message: "Access denied" });

  const fields = [],
    params = [];
  if (invite_code?.trim()) {
    fields.push("invite_code = ?");
    params.push(invite_code.trim());
  }
  if (name?.trim()) {
    fields.push("name = ?");
    params.push(name.trim());
  }
  if (!fields.length)
    return res
      .status(400)
      .json({ success: false, message: "Nothing to update" });

  params.push(groupId);
  await db.execute(
    `UPDATE plaza_groups SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
  return res.json({
    success: true,
    message: "Group updated",
    data: { id: groupId, invite_code, name },
  });
});

/* GET group members */
router.get("/groups/:id/members", generalLimiter, getGroupMembers);

/* GET messages — NO ownershipMiddleware, controller handles auth */
router.get("/groups/:id/messages", generalLimiter, getGroupMessages);

/* POST messages — NO ownershipMiddleware, controller handles auth */
router.post(
  "/groups/:id/messages",
  uploadLimiter,
  upload.groupMessage.single("file"),
  handleUploadError,
  sendGroupMessageLandlord,
);

// ── Upload error handler ─────────────────────────────────────
router.use(handleUploadError);

module.exports = router;
