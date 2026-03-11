// controllers/tenantController.js
// ============================================================
// All tenant-scoped actions not covered by a dedicated controller
// (payments, maintenance, notifications each have their own).
//
// Covers:
//   Dashboard  — overview, lease, payment summary, alerts
//   Lease      — view active lease, history, renewal request
//   Plaza      — view plaza details, neighbours
//   Groups     — join, leave, paginated messages, send message
//
// Import path: ../controllers/tenantController
// Utils path : ../utils/  (one level up from controllers/)
// Services   : ../services/
// ============================================================

const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");
const LeaseService = require("../services/leaseservice");
const { buildPaginationResponse } = require("../utils/pagination");

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const resolveFileType = (mime) => {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  return "doc";
};

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════

// GET /api/tenant/dashboard
// Returns active lease, this-month payment summary, overdue flag,
// open maintenance count, unread notification count.
const getDashboard = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;

  const lease = await LeaseService.getActiveLease(tenantId);

  let paymentSummary = {
    paid_this_month: 0,
    total_paid: 0,
    last_payment_date: null,
  };
  if (lease) {
    const [[s]] = await db.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status='paid'
                        AND YEAR(payment_date)  = YEAR(CURDATE())
                        AND MONTH(payment_date) = MONTH(CURDATE())
                       THEN amount END), 0) AS paid_this_month,
         COALESCE(SUM(CASE WHEN status='paid' THEN amount END), 0) AS total_paid,
         MAX(CASE WHEN status='paid' THEN payment_date END)        AS last_payment_date
       FROM payments WHERE tenancy_id = ?`,
      [lease.id],
    );
    paymentSummary = s;
  }

  const [[{ open_maintenance }]] = await db.execute(
    `SELECT COUNT(*) AS open_maintenance FROM maintenance_requests
     WHERE tenant_id = ? AND status IN ('pending','in_progress')`,
    [tenantId],
  );

  const unread_notifications =
    await NotificationService.getUnreadCount(tenantId);

  let is_overdue = false;
  if (lease) {
    const [[{ paid }]] = await db.execute(
      `SELECT COUNT(*) AS paid FROM payments
       WHERE tenancy_id = ? AND status='paid'
         AND YEAR(payment_date)  = YEAR(CURDATE())
         AND MONTH(payment_date) = MONTH(CURDATE())`,
      [lease.id],
    );
    is_overdue = paid === 0;
  }

  return res.json({
    success: true,
    data: {
      lease,
      payment_summary: paymentSummary,
      is_overdue,
      open_maintenance,
      unread_notifications,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// LEASE
// ═══════════════════════════════════════════════════════════════

// GET /api/tenant/lease
const getMyLease = asyncHandler(async (req, res) => {
  const lease = await LeaseService.getActiveLease(req.user.id);
  if (!lease) throw new AppError("No active lease found", 404);
  return res.json({ success: true, data: lease });
});

// GET /api/tenant/lease/history
const getLeaseHistory = asyncHandler(async (req, res) => {
  const result = await LeaseService.getByTenant(req.user.id, req.query);
  return res.json({ success: true, ...result });
});

// POST /api/tenant/lease/renewal
// Body: { message? }
const requestLeaseRenewal = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const lease = await LeaseService.getActiveLease(tenantId);
  if (!lease) throw new AppError("No active lease found", 404);

  const userMsg = req.body.message?.trim() || "I would like to renew my lease.";

  await NotificationService.create({
    recipientId: lease.landlord_id,
    senderId: tenantId,
    type: "lease_expiring",
    message: `Renewal request from ${req.user.full_name || req.user.username}: ${userMsg}`,
    referenceId: lease.id,
    io: req.app.get("io"),
  });

  await logActivity(
    tenantId,
    "tenancy_updated",
    `Requested lease renewal for tenancy ${lease.id}`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Renewal request sent to your landlord.",
  });
});

// ═══════════════════════════════════════════════════════════════
// PLAZA
// ═══════════════════════════════════════════════════════════════

// GET /api/tenant/plaza
const getMyPlaza = asyncHandler(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT
       p.id, p.name, p.location, p.total_units,
       l.full_name  AS landlord_name,
       l.email      AS landlord_email,
       l.phone      AS landlord_phone,
       l.avatar_url AS landlord_avatar
     FROM tenancies t
     JOIN plazas p ON p.id = t.plaza_id
     JOIN users  l ON l.id = p.landlord_id
     WHERE t.tenant_id = ? AND t.status = 'active'
     LIMIT 1`,
    [req.user.id],
  );
  if (!rows.length) throw new AppError("No active tenancy found", 404);
  return res.json({ success: true, data: rows[0] });
});

// GET /api/tenant/neighbours
// Returns name, unit, avatar — no email for privacy
const getMyNeighbours = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const [tenancy] = await db.execute(
    `SELECT plaza_id FROM tenancies WHERE tenant_id = ? AND status = 'active' LIMIT 1`,
    [tenantId],
  );
  if (!tenancy.length) throw new AppError("No active tenancy found", 404);

  const [rows] = await db.execute(
    `SELECT u.full_name AS name, u.avatar_url AS avatar, t.unit_number
     FROM tenancies t
     JOIN users u ON u.id = t.tenant_id
     WHERE t.plaza_id  = ? AND t.status = 'active'
       AND t.tenant_id != ? AND u.deleted_at IS NULL
     ORDER BY t.unit_number ASC`,
    [tenancy[0].plaza_id, tenantId],
  );

  return res.json({ success: true, data: rows });
});

// ═══════════════════════════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════════════════════════

// GET /api/tenant/groups
const getMyGroups = asyncHandler(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT
       pg.id, pg.name, pg.plaza_id, pg.created_at,
       p.name AS plaza_name, p.location AS plaza_location,
       gm.joined_at,
       COUNT(DISTINCT gm2.user_id) AS member_count
     FROM group_members gm
     JOIN plaza_groups  pg  ON pg.id     = gm.group_id
     JOIN plazas        p   ON p.id      = pg.plaza_id
     LEFT JOIN group_members gm2 ON gm2.group_id = pg.id
     WHERE gm.user_id = ?
     GROUP BY pg.id, gm.joined_at
     ORDER BY gm.joined_at DESC`,
    [req.user.id],
  );
  return res.json({ success: true, data: rows });
});

// POST /api/tenant/groups/join
// Body: { invite_code }
const joinGroup = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const invite_code = req.body.invite_code?.trim();
  if (!invite_code) throw new AppError("invite_code is required", 400);

  const [codes] = await db.execute(
    `SELECT ic.*, p.landlord_id, p.name AS plaza_name
     FROM invite_codes ic JOIN plazas p ON p.id = ic.plaza_id
     WHERE ic.code = UPPER(?) AND ic.status = 'active' AND ic.expires_at > NOW()`,
    [invite_code],
  );
  if (!codes.length) throw new AppError("Invalid or expired invite code", 400);
  const ic = codes[0];

  const [groups] = await db.execute(
    `SELECT id, name FROM plaza_groups WHERE plaza_id = ? LIMIT 1`,
    [ic.plaza_id],
  );
  if (!groups.length) throw new AppError("No group found for this plaza", 404);
  const group = groups[0];

  const [[{ exists }]] = await db.execute(
    `SELECT COUNT(*) AS exists FROM group_members WHERE group_id = ? AND user_id = ?`,
    [group.id, tenantId],
  );
  if (exists > 0)
    throw new AppError("You are already a member of this group", 400);

  await db.execute(
    `INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, NOW())`,
    [group.id, tenantId],
  );

  await NotificationService.create({
    recipientId: ic.landlord_id,
    senderId: tenantId,
    type: "new_tenant",
    message: `${req.user.full_name || req.user.username} joined the group for ${ic.plaza_name}`,
    referenceId: group.id,
    io: req.app.get("io"),
  });

  await logActivity(
    tenantId,
    "group_joined",
    `Joined group "${group.name}" (ID: ${group.id})`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Joined group successfully",
    group_id: group.id,
    group_name: group.name,
  });
});

// DELETE /api/tenant/groups/:group_id/leave
const leaveGroup = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const groupId = parseId(req.params.group_id);
  if (!groupId) throw new AppError("Invalid group ID", 400);

  const [[{ exists }]] = await db.execute(
    `SELECT COUNT(*) AS exists FROM group_members WHERE group_id = ? AND user_id = ?`,
    [groupId, tenantId],
  );
  if (!exists) throw new AppError("You are not a member of this group", 400);

  await db.execute(
    `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`,
    [groupId, tenantId],
  );

  const [plazaRows] = await db.execute(
    `SELECT p.landlord_id, pg.name AS group_name
     FROM plaza_groups pg JOIN plazas p ON p.id = pg.plaza_id WHERE pg.id = ?`,
    [groupId],
  );
  if (plazaRows.length) {
    await NotificationService.create({
      recipientId: plazaRows[0].landlord_id,
      senderId: tenantId,
      type: "general",
      message: `${req.user.full_name || req.user.username} left the group "${plazaRows[0].group_name}"`,
      referenceId: groupId,
      io: req.app.get("io"),
    });
  }

  await logActivity(tenantId, "group_left", `Left group ${groupId}`, {
    ip: req.ip,
  });

  return res.json({ success: true, message: "Left group successfully" });
});

// GET /api/tenant/groups/:group_id/messages
const getGroupMessages = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const groupId = parseId(req.params.group_id);
  if (!groupId) throw new AppError("Invalid group ID", 400);

  const [[{ exists }]] = await db.execute(
    `SELECT COUNT(*) AS exists FROM group_members WHERE group_id = ? AND user_id = ?`,
    [groupId, tenantId],
  );
  if (!exists) throw new AppError("You are not a member of this group", 403);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const offset = (page - 1) * limit;

  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM group_messages WHERE group_id = ?`,
    [groupId],
  );

  const [messages] = await db.query(
    `SELECT
       gm.id, gm.group_id, gm.sender_id, gm.content,
       gm.file_url, gm.file_type, gm.created_at,
       u.full_name  AS sender_name,
       u.avatar_url AS sender_avatar
     FROM group_messages gm
     JOIN users u ON u.id = gm.sender_id
     WHERE gm.group_id = ?
     ORDER BY gm.created_at ASC
     LIMIT ? OFFSET ?`,
    [groupId, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: messages, total, page, limit }),
  });
});

// POST /api/tenant/groups/:group_id/messages
// Body: { content? } + optional file field "file"
const sendGroupMessage = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const groupId = parseId(req.params.group_id);
  if (!groupId) throw new AppError("Invalid group ID", 400);

  const { content } = req.body;
  if (!content?.trim() && !req.file)
    throw new AppError("A message or file attachment is required", 400);

  let file_url = null,
    file_type = null;
  if (req.file) {
    if (!ALLOWED_FILE_TYPES.includes(req.file.mimetype))
      throw new AppError(
        "Unsupported file type. Allowed: images, PDF, DOC, DOCX",
        400,
      );
    file_url = `uploads/group_messages/${req.file.filename}`;
    file_type = resolveFileType(req.file.mimetype);
  }

  const [[{ exists }]] = await db.execute(
    `SELECT COUNT(*) AS exists FROM group_members WHERE group_id = ? AND user_id = ?`,
    [groupId, tenantId],
  );
  if (!exists) throw new AppError("You are not a member of this group", 403);

  await db.execute(
    `INSERT INTO group_messages (group_id, sender_id, content, file_url, file_type, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [groupId, tenantId, content?.trim() || null, file_url, file_type],
  );

  const [members] = await db.execute(
    `SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?`,
    [groupId, tenantId],
  );
  if (members.length) {
    await NotificationService.createBulk({
      recipientIds: members.map((m) => m.user_id),
      senderId: tenantId,
      type: "new_message",
      message: `New message in your group from ${req.user.full_name || req.user.username}`,
      groupedKey: `group_msg_${groupId}`,
      io: req.app.get("io"),
    });
  }

  await logActivity(
    tenantId,
    "message_sent",
    `Sent message to group ${groupId}`,
    { ip: req.ip },
  );

  return res
    .status(201)
    .json({ success: true, message: "Message sent successfully" });
});

module.exports = {
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
};
