// controllers/tenantController.js
// ============================================================
// All tenant-scoped actions not covered by a dedicated controller.
// Covers: Dashboard, Lease, Plaza, Groups, Rent Payment
// ============================================================

const axios = require("axios");
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

  return res.json({
    success: true,
    data: {
      lease,
      payment_summary: paymentSummary,
      is_overdue: lease ? !!lease.is_overdue : false,
      rent_covered_until: lease ? lease.rent_covered_until : null,
      open_maintenance,
      unread_notifications,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// LEASE
// ═══════════════════════════════════════════════════════════════

const getMyLease = asyncHandler(async (req, res) => {
  const lease = await LeaseService.getActiveLease(req.user.id);
  if (!lease) throw new AppError("No active lease found", 404);
  return res.json({ success: true, data: lease });
});

const getLeaseHistory = asyncHandler(async (req, res) => {
  const result = await LeaseService.getByTenant(req.user.id, req.query);
  return res.json({ success: true, ...result });
});

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
// RENT PAYMENT
// ═══════════════════════════════════════════════════════════════

// POST /api/tenant/rent/initialize
// Body: { months }
const initializeRentPayment = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const months = parseInt(req.body.months, 10);

  if (!months || months < 1) {
    throw new AppError("Please select a valid number of months", 400);
  }

  const lease = await LeaseService.getActiveLease(tenantId);
  if (!lease) throw new AppError("No active lease found", 404);

  if (!lease.rent_amount) {
    throw new AppError("Rent amount is not set for this tenancy", 400);
  }
  if (!lease.tenant_email) {
    throw new AppError("No email on file for this account", 400);
  }

  const totalAmount = lease.rent_amount * months;
  const amountInPesewas = Math.round(totalAmount * 100);

  const paystackResponse = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email: lease.tenant_email,
      amount: amountInPesewas,
      metadata: {
        tenant_id: tenantId,
        tenancy_id: lease.id,
        months_paid: months,
      },
    },
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } },
  );

  return res.status(200).json({
    success: true,
    authorization_url: paystackResponse.data.data.authorization_url,
    reference: paystackResponse.data.data.reference,
  });
});

// GET /api/tenant/rent/verify/:reference
const verifyRentPayment = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const { reference } = req.params;

  if (!reference) throw new AppError("Payment reference is required", 400);

  const verifyResponse = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } },
  );

  const { status, metadata } = verifyResponse.data.data;

  if (status !== "success") {
    throw new AppError("Payment was not successful", 400);
  }

  const metaTenantId = parseId(metadata?.tenant_id);
  const tenancyId = parseId(metadata?.tenancy_id);
  const monthsPaid = parseInt(metadata?.months_paid, 10);

  if (!metaTenantId || metaTenantId !== tenantId) {
    throw new AppError(
      "This payment reference does not belong to your account",
      403,
    );
  }

  if (!tenancyId || !monthsPaid || monthsPaid < 1) {
    throw new AppError("Payment metadata is invalid or incomplete", 400);
  }

  const lease = await LeaseService.getActiveLease(tenantId);
  if (!lease || lease.id !== tenancyId) {
    throw new AppError(
      "Tenancy mismatch — payment does not match your active lease",
      403,
    );
  }

  const amountPaid = lease.rent_amount * monthsPaid;

  const newCoveredUntil = await LeaseService.updateRentCoverage(
    tenancyId,
    monthsPaid,
  );

  // ASSUMPTION: `payments` table has (or can have) `reference` and
  // `months_covered` columns — still unconfirmed.
  await db.execute(
    `INSERT INTO payments (tenancy_id, amount, status, payment_date, reference, months_covered, created_at)
     VALUES (?, ?, 'paid', CURDATE(), ?, ?, NOW())`,
    [tenancyId, amountPaid, reference, monthsPaid],
  );

  if (lease.landlord_id) {
    await NotificationService.create({
      recipientId: lease.landlord_id,
      senderId: tenantId,
      type: "payment_received",
      message: `${lease.tenant_name || req.user.username} paid rent for ${monthsPaid} month(s).`,
      referenceId: tenancyId,
      io: req.app.get("io"),
    });
  }

  await logActivity(
    tenantId,
    "payment_verified",
    `Paid rent for ${monthsPaid} month(s), reference ${reference}`,
    { ip: req.ip },
  );

  return res.status(200).json({
    success: true,
    message: "Payment verified and rent updated successfully",
    data: {
      rent_covered_until: newCoveredUntil,
      months_paid: monthsPaid,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════════════════════════

// GET /api/tenant/groups
// FIX: original query used group_members JOIN but if tenant hasn't
// formally joined via group_members, they'd see no groups.
// Now also returns groups for their plaza directly as a fallback.
const getMyGroups = asyncHandler(async (req, res) => {
  const tenantId = Number(req.user.id);

  const [[tenancy]] = await db.execute(
    `SELECT t.plaza_id FROM tenancies t
     WHERE t.tenant_id = ? AND t.status = 'active'
     LIMIT 1`,
    [tenantId],
  );

  if (!tenancy) return res.json({ success: true, groups: [] });

  const [groups] = await db.execute(
    `SELECT pg.id, pg.name, pg.plaza_id, pg.created_at,
       p.name AS plaza_name, p.location AS plaza_location
     FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id
     WHERE pg.plaza_id = ? AND p.deleted_at IS NULL
     ORDER BY pg.created_at DESC`,
    [tenancy.plaza_id],
  );

  if (!groups.length) return res.json({ success: true, groups: [] });

  const enriched = await Promise.all(
    groups.map(async (g) => {
      let last_message = null,
        last_message_at = null;
      try {
        const [[lastMsg]] = await db.execute(
          `SELECT content AS last_message, created_at AS last_message_at
         FROM group_messages WHERE group_id = ?
         ORDER BY created_at DESC LIMIT 1`,
          [g.id],
        );
        if (lastMsg) {
          last_message = lastMsg.last_message;
          last_message_at = lastMsg.last_message_at;
        }
      } catch {}

      let member_count = 0;
      try {
        const [[cnt]] = await db.execute(
          `SELECT COUNT(DISTINCT user_id) AS member_count FROM group_members WHERE group_id = ?`,
          [g.id],
        );
        member_count = cnt?.member_count || 0;
      } catch {}

      return { ...g, last_message, last_message_at, member_count };
    }),
  );

  return res.json({ success: true, groups: enriched });
});

// POST /api/tenant/groups/join
// Body: { invite_code }
const joinGroup = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const invite_code = (req.body.invite_code || "").trim().toUpperCase();

  if (!invite_code) throw new AppError("invite_code is required", 400);

  const [[group]] = await db.execute(
    `SELECT
       pg.id, pg.name, pg.plaza_id, pg.invite_code,
       p.landlord_id, p.name AS plaza_name,
       p.deleted_at
     FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id
     WHERE UPPER(pg.invite_code) = ?
       AND p.deleted_at IS NULL`,
    [invite_code],
  );

  if (!group) throw new AppError("Invalid or expired invite code", 400);

  const [[tenancy]] = await db.execute(
    `SELECT id FROM tenancies
     WHERE tenant_id = ? AND plaza_id = ? AND status = 'active'
     LIMIT 1`,
    [tenantId, group.plaza_id],
  );

  if (!tenancy)
    throw new AppError(
      "You must be an active tenant in this plaza to join its group",
      403,
    );

  const [[{ already_member }]] = await db.execute(
    `SELECT COUNT(*) AS already_member FROM group_members
     WHERE group_id = ? AND user_id = ?`,
    [group.id, tenantId],
  );

  if (already_member > 0) {
    return res.status(200).json({
      success: true,
      message: "You are already a member of this group",
      group: { id: group.id, name: group.name, plaza_name: group.plaza_name },
    });
  }

  await db.execute(
    `INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, NOW())`,
    [group.id, tenantId],
  );

  await NotificationService.create({
    recipientId: group.landlord_id,
    senderId: tenantId,
    type: "new_tenant",
    message: `${req.user.full_name || req.user.username} joined the group for ${group.plaza_name}`,
    referenceId: group.id,
    io: req.app.get("io"),
  });

  await logActivity(
    tenantId,
    "group_joined",
    `Joined group "${group.name}" (ID: ${group.id}) for plaza "${group.plaza_name}"`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Joined group successfully",
    group: { id: group.id, name: group.name, plaza_name: group.plaza_name },
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
     FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id
     WHERE pg.id = ?`,
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

  const [[{ is_member }]] = await db.execute(
    `SELECT COUNT(*) AS is_member
     FROM plaza_groups pg
     JOIN plazas p    ON p.id  = pg.plaza_id
     JOIN tenancies t ON t.plaza_id = p.id
     WHERE pg.id = ? AND t.tenant_id = ? AND t.status = 'active'
     LIMIT 1`,
    [groupId, tenantId],
  );
  if (!is_member) throw new AppError("You are not a member of this group", 403);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const offset = (page - 1) * limit;

  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM group_messages WHERE group_id = ?`,
    [groupId],
  );

  const [messages] = await db.query(
    `SELECT
       gm.id, gm.group_id, gm.sender_id,
       gm.content,
       gm.content AS message,
       gm.file_url, gm.file_type, gm.created_at,
       COALESCE(u.full_name, u.username) AS sender_name,
       u.email       AS sender_email,
       u.avatar_url  AS sender_avatar
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
const sendGroupMessage = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const groupId = parseId(req.params.group_id);
  if (!groupId) throw new AppError("Invalid group ID", 400);

  const content = (req.body.content || req.body.message || "").trim();

  if (!content && !req.file)
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

  const [[{ is_member }]] = await db.execute(
    `SELECT COUNT(*) AS is_member
     FROM plaza_groups pg
     JOIN plazas p    ON p.id  = pg.plaza_id
     JOIN tenancies t ON t.plaza_id = p.id
     WHERE pg.id = ? AND t.tenant_id = ? AND t.status = 'active'
     LIMIT 1`,
    [groupId, tenantId],
  );
  if (!is_member) throw new AppError("You are not a member of this group", 403);

  const [result] = await db.execute(
    `INSERT INTO group_messages (group_id, sender_id, content, file_url, file_type, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [groupId, tenantId, content || null, file_url, file_type],
  );

  const io = req.app.get("io");
  if (io) {
    io.to(`group_${groupId}`).emit("group_message", {
      id: result.insertId,
      group_id: groupId,
      sender_id: tenantId,
      content: content || null,
      message: content || null,
      file_url,
      created_at: new Date().toISOString(),
    });
  }

  const [members] = await db.execute(
    `SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?`,
    [groupId, tenantId],
  );

  const [[plazaRow]] = await db.execute(
    `SELECT p.landlord_id FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id WHERE pg.id = ?`,
    [groupId],
  );

  const recipientIds = [
    ...new Set([
      ...members.map((m) => m.user_id),
      ...(plazaRow ? [plazaRow.landlord_id] : []),
    ]),
  ].filter((id) => id !== tenantId);

  if (recipientIds.length) {
    await NotificationService.createBulk({
      recipientIds,
      senderId: tenantId,
      type: "new_message",
      message: `New message in your group from ${req.user.full_name || req.user.username}`,
      groupedKey: `group_msg_${groupId}`,
      io,
    });
  }

  await logActivity(
    tenantId,
    "message_sent",
    `Sent message to group ${groupId}`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Message sent successfully",
    message_id: result.insertId,
  });
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
  initializeRentPayment,
  verifyRentPayment,
};
