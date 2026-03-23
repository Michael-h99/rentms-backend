const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");
const { buildPaginationResponse } = require("../utils/pagination");
const { generateInviteCode } = require("../utils/generateid");

const MAINTENANCE_STATUSES = ["pending", "in_progress", "resolved", "rejected"];
const PAYMENT_STATUSES = ["paid", "pending", "failed"];
const DEFAULT_LIMIT = 20;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

const requirePlazaOwnership = async (plazaId, landlordId) => {
  const [[plaza]] = await db.execute(
    "SELECT id, name, location, total_units FROM plazas WHERE id = ? AND landlord_id = ? AND deleted_at IS NULL",
    [Number(plazaId), Number(landlordId)],
  );
  if (!plaza) throw new AppError("Plaza not found or access denied", 403);
  return plaza;
};

// ============================================================
// PLAZAS
// ============================================================

const getLandlordPlazas = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = Number((page - 1) * limit);

  const [[{ total }]] = await db.execute(
    "SELECT COUNT(*) AS total FROM plazas WHERE landlord_id = ? AND deleted_at IS NULL",
    [landlordId],
  );

  const [rows] = await db.query(
    `SELECT p.id, p.name, p.location, p.total_units, p.created_at,
       COUNT(CASE WHEN t.status = 'active' THEN 1 END) AS occupied_units,
       p.total_units - COUNT(CASE WHEN t.status = 'active' THEN 1 END) AS vacant_units
     FROM plazas p
     LEFT JOIN tenancies t ON t.plaza_id = p.id
     WHERE p.landlord_id = ? AND p.deleted_at IS NULL
     GROUP BY p.id
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [landlordId, Number(limit), Number(offset)],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

const getPlazaById = asyncHandler(async (req, res) => {
  const plazaId = parseId(req.params.id);
  if (!plazaId) throw new AppError("Invalid plaza ID", 400);

  const plaza = await requirePlazaOwnership(plazaId, req.user.id);

  const [[stats]] = await db.query(
    `SELECT
       COUNT(CASE WHEN t.status = 'active' THEN 1 END)   AS active_tenants,
       COUNT(CASE WHEN t.status = 'expired' THEN 1 END)  AS expired_tenants,
       COALESCE(SUM(CASE WHEN py.status = 'paid'
         AND YEAR(py.payment_date)  = YEAR(CURDATE())
         AND MONTH(py.payment_date) = MONTH(CURDATE())
         THEN py.amount END), 0)                          AS revenue_this_month,
       COUNT(CASE WHEN mr.status IN ('pending','in_progress') THEN 1 END) AS open_maintenance
     FROM tenancies t
     LEFT JOIN payments py ON py.tenancy_id = t.id
     LEFT JOIN maintenance_requests mr ON mr.plaza_id = t.plaza_id
     WHERE t.plaza_id = ?`,
    [Number(plazaId)],
  );

  return res.json({ success: true, data: { ...plaza, stats } });
});

const createPlaza = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const { name, location, total_units } = req.body;

  if (!name?.trim() || !location?.trim() || !total_units)
    throw new AppError("name, location, and total_units are required", 400);

  const units = parseInt(total_units, 10);
  if (isNaN(units) || units <= 0)
    throw new AppError("total_units must be a positive integer", 400);

  const [result] = await db.execute(
    "INSERT INTO plazas (landlord_id, name, location, total_units, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())",
    [landlordId, name.trim(), location.trim(), units],
  );

  await logActivity(
    landlordId,
    "plaza_created",
    `Created plaza "${name.trim()}" (ID: ${result.insertId})`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Plaza created successfully",
    plaza_id: result.insertId,
  });
});

const updatePlaza = asyncHandler(async (req, res) => {
  const plazaId = parseId(req.params.id);
  if (!plazaId) throw new AppError("Invalid plaza ID", 400);
  await requirePlazaOwnership(plazaId, req.user.id);

  const { name, location, total_units } = req.body;
  const fields = [],
    params = [];

  if (name?.trim()) {
    fields.push("name = ?");
    params.push(name.trim());
  }
  if (location?.trim()) {
    fields.push("location = ?");
    params.push(location.trim());
  }
  if (total_units) {
    const units = parseInt(total_units, 10);
    if (isNaN(units) || units <= 0)
      throw new AppError("total_units must be a positive integer", 400);
    fields.push("total_units = ?");
    params.push(units);
  }

  if (!fields.length) throw new AppError("No fields to update", 400);
  fields.push("updated_at = NOW()");
  params.push(Number(plazaId));

  await db.execute(
    `UPDATE plazas SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
  await logActivity(
    Number(req.user.id),
    "plaza_updated",
    `Updated plaza ${plazaId}`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Plaza updated successfully" });
});

const deletePlaza = asyncHandler(async (req, res) => {
  const plazaId = parseId(req.params.id);
  if (!plazaId) throw new AppError("Invalid plaza ID", 400);
  await requirePlazaOwnership(plazaId, req.user.id);

  const [[{ active }]] = await db.execute(
    "SELECT COUNT(*) AS active FROM tenancies WHERE plaza_id = ? AND status = 'active'",
    [Number(plazaId)],
  );
  if (active > 0)
    throw new AppError("Cannot delete a plaza with active tenancies", 400);

  await db.execute("UPDATE plazas SET deleted_at = NOW() WHERE id = ?", [
    Number(plazaId),
  ]);
  await logActivity(
    Number(req.user.id),
    "plaza_deleted",
    `Deleted plaza ${plazaId}`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Plaza deleted successfully" });
});

// ============================================================
// TENANTS
// ============================================================

const getPlazaTenants = asyncHandler(async (req, res) => {
  const plazaId = parseId(req.params.id);
  if (!plazaId) throw new AppError("Invalid plaza ID", 400);
  await requirePlazaOwnership(plazaId, req.user.id);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = Number((page - 1) * limit);
  const { status } = req.query;

  const conditions = ["t.plaza_id = ?"];
  const params = [Number(plazaId)];

  if (status && ["active", "expired"].includes(status)) {
    conditions.push("t.status = ?");
    params.push(status);
  }

  const WHERE = conditions.join(" AND ");

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM tenancies t WHERE ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    /* FIX: added plaza_name join so frontend can display it */
    `SELECT t.id, t.tenant_id, t.unit_number, t.rent_amount,
       t.lease_start, t.lease_end, t.status, t.created_at,
       u.full_name, u.email, u.phone, u.avatar_url,
       p.name AS plaza_name
     FROM tenancies t
     JOIN users u ON u.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id
     WHERE ${WHERE}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

const inviteTenant = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const plazaId = parseId(req.params.id);
  if (!plazaId) throw new AppError("Invalid plaza ID", 400);

  const plaza = await requirePlazaOwnership(plazaId, landlordId);

  const {
    unit_number,
    rent_amount,
    lease_start,
    lease_end,
    max_uses = 1,
    expires_days = 30,
  } = req.body;

  if (!unit_number || !rent_amount || !lease_start || !lease_end)
    throw new AppError(
      "unit_number, rent_amount, lease_start, and lease_end are required",
      400,
    );

  const rentAmt = parseFloat(rent_amount);
  if (isNaN(rentAmt) || rentAmt <= 0)
    throw new AppError("rent_amount must be a positive number", 400);

  /* FIX: validate that unit_number doesn't already have an active invite code */
  const [[existingCode]] = await db.execute(
    "SELECT id FROM invite_codes WHERE plaza_id = ? AND unit_number = ? AND status = 'active' AND expires_at > NOW()",
    [Number(plazaId), unit_number],
  );
  if (existingCode)
    throw new AppError(
      `Unit ${unit_number} already has an active invite code`,
      400,
    );

  const code = generateInviteCode();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + parseInt(expires_days, 10));

  const [result] = await db.execute(
    "INSERT INTO invite_codes (code, landlord_id, plaza_id, unit_number, rent_amount, lease_start, lease_end, max_uses, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW())",
    [
      code,
      landlordId,
      Number(plazaId),
      unit_number,
      rentAmt,
      lease_start,
      lease_end,
      parseInt(max_uses, 10),
      expiresAt,
    ],
  );

  await logActivity(
    landlordId,
    "invite_code_created",
    `Generated invite code ${code} for plaza "${plaza.name}", unit ${unit_number}`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Invite code generated successfully",
    invite_code: code,
    invite_id: result.insertId,
    expires_at: expiresAt.toISOString(),
  });
});

const removeTenant = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const tenancyId = parseId(req.params.id);
  if (!tenancyId) throw new AppError("Invalid tenancy ID", 400);

  const [[tenancy]] = await db.execute(
    `SELECT t.id, t.tenant_id, t.status,
       u.full_name AS tenant_name, p.name AS plaza_name
     FROM tenancies t
     JOIN plazas p ON p.id = t.plaza_id
     JOIN users  u ON u.id = t.tenant_id
     WHERE t.id = ? AND p.landlord_id = ?`,
    [Number(tenancyId), landlordId],
  );

  if (!tenancy) throw new AppError("Tenancy not found or access denied", 403);
  if (tenancy.status === "expired")
    throw new AppError("Tenancy is already expired", 400);

  await db.execute(
    "UPDATE tenancies SET status = 'expired', updated_at = NOW() WHERE id = ?",
    [Number(tenancyId)],
  );

  await NotificationService.create({
    recipientId: tenancy.tenant_id,
    senderId: landlordId,
    type: "tenancy_update",
    message: `Your tenancy at ${tenancy.plaza_name} has been ended by your landlord.`,
    referenceId: tenancyId,
    io: req.app.get("io"),
  });

  await logActivity(
    landlordId,
    "tenant_removed",
    `Expired tenancy ${tenancyId} for tenant "${tenancy.tenant_name}"`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Tenancy ended successfully" });
});

// ============================================================
// PAYMENTS
// ============================================================

const getRentPayments = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = Number((page - 1) * limit);
  const { from, to, status } = req.query;
  const plazaId = parseId(req.query.plaza_id);

  /* FIX: also support tenant_id filter so tenant-details page works */
  const tenantId = parseId(req.query.tenant_id);

  if (from && isNaN(Date.parse(from)))
    throw new AppError("Invalid 'from' date. Use YYYY-MM-DD", 400);
  if (to && isNaN(Date.parse(to)))
    throw new AppError("Invalid 'to' date. Use YYYY-MM-DD", 400);
  if (status && !PAYMENT_STATUSES.includes(status))
    throw new AppError(
      `Invalid status. Must be: ${PAYMENT_STATUSES.join(", ")}`,
      400,
    );

  const conditions = ["p.landlord_id = ?"];
  const params = [landlordId];

  if (from) {
    conditions.push("DATE(pay.payment_date) >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("DATE(pay.payment_date) <= ?");
    params.push(to);
  }
  if (status) {
    conditions.push("pay.status = ?");
    params.push(status);
  }
  if (plazaId) {
    conditions.push("p.id = ?");
    params.push(Number(plazaId));
  }
  if (tenantId) {
    conditions.push("t.tenant_id = ?");
    params.push(Number(tenantId));
  }

  const WHERE = conditions.join(" AND ");

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM payments pay
     JOIN tenancies t ON t.id = pay.tenancy_id
     JOIN plazas p    ON p.id = t.plaza_id
     WHERE ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT pay.id, pay.amount, pay.currency, pay.payment_method,
       pay.status, pay.reference, pay.payment_date, pay.verified_at,
       t.id AS tenancy_id, t.unit_number,
       u.id AS tenant_id, u.full_name AS tenant_name, u.email AS tenant_email,
       p.id AS plaza_id, p.name AS plaza_name
     FROM payments pay
     JOIN tenancies t ON t.id = pay.tenancy_id
     JOIN plazas p    ON p.id = t.plaza_id
     JOIN users u     ON u.id = t.tenant_id
     WHERE ${WHERE}
     ORDER BY pay.payment_date DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ============================================================
// MAINTENANCE
// ============================================================

const getMaintenanceRequests = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = Number((page - 1) * limit);
  const { status, priority } = req.query;
  const plazaId = parseId(req.query.plaza_id);

  /* FIX: also support tenant_id filter */
  const tenantId = parseId(req.query.tenant_id);

  if (status && !MAINTENANCE_STATUSES.includes(status))
    throw new AppError(
      `Invalid status. Must be: ${MAINTENANCE_STATUSES.join(", ")}`,
      400,
    );

  const conditions = ["p.landlord_id = ?"];
  const params = [landlordId];

  if (status) {
    conditions.push("mr.status = ?");
    params.push(status);
  }
  if (priority) {
    conditions.push("mr.priority = ?");
    params.push(priority);
  }
  if (plazaId) {
    conditions.push("p.id = ?");
    params.push(Number(plazaId));
  }
  if (tenantId) {
    conditions.push("mr.tenant_id = ?");
    params.push(Number(tenantId));
  }

  const WHERE = conditions.join(" AND ");

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM maintenance_requests mr
     JOIN plazas p ON p.id = mr.plaza_id
     WHERE ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT mr.id, mr.title, mr.description, mr.priority, mr.status,
       mr.attachment_url, mr.resolved_at, mr.created_at, mr.updated_at,
       p.id AS plaza_id, p.name AS plaza_name,
       t.unit_number,
       u.id AS tenant_id, u.full_name AS tenant_name, u.email AS tenant_email
     FROM maintenance_requests mr
     JOIN plazas p ON p.id = mr.plaza_id
     /* FIX: join tenancies to get unit_number */
     LEFT JOIN tenancies t ON t.tenant_id = mr.tenant_id AND t.plaza_id = mr.plaza_id AND t.status = 'active'
     JOIN users u ON u.id = mr.tenant_id
     WHERE ${WHERE}
     ORDER BY
       CASE mr.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       mr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

const updateMaintenanceStatus = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const requestId = parseId(req.params.id);
  if (!requestId) throw new AppError("Invalid request ID", 400);

  const { status, note } = req.body;

  /* FIX: also accept PATCH body with just { status } from the quick-update dropdown */
  const finalStatus = status || req.body.status;
  if (!finalStatus || !MAINTENANCE_STATUSES.includes(finalStatus))
    throw new AppError(
      `Invalid status. Must be: ${MAINTENANCE_STATUSES.join(", ")}`,
      400,
    );

  const [[row]] = await db.execute(
    `SELECT mr.id, mr.status AS old_status, mr.tenant_id, mr.title, p.landlord_id
     FROM maintenance_requests mr
     JOIN plazas p ON p.id = mr.plaza_id
     WHERE mr.id = ?`,
    [Number(requestId)],
  );

  if (!row) throw new AppError("Maintenance request not found", 404);
  if (Number(row.landlord_id) !== landlordId)
    throw new AppError("Access denied", 403);
  if (row.old_status === finalStatus)
    return res.json({
      success: true,
      message: "Status already set to the requested value",
    });

  const resolvedAt = finalStatus === "resolved" ? ", resolved_at = NOW()" : "";
  await db.execute(
    `UPDATE maintenance_requests SET status = ?, updated_at = NOW() ${resolvedAt} WHERE id = ?`,
    [finalStatus, Number(requestId)],
  );

  await db.execute(
    "INSERT INTO maintenance_logs (maintenance_id, changed_by, old_status, new_status, note, changed_at) VALUES (?, ?, ?, ?, ?, NOW())",
    [Number(requestId), landlordId, row.old_status, finalStatus, note || null],
  );

  await NotificationService.create({
    recipientId: row.tenant_id,
    senderId: landlordId,
    type: "maintenance_update",
    message: `Your request "${row.title}" has been updated to "${finalStatus}"`,
    referenceId: requestId,
    io: req.app.get("io"),
  });

  await logActivity(
    landlordId,
    "maintenance_status_updated",
    `Updated request ${requestId}: "${row.old_status}" to "${finalStatus}"`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Maintenance status updated successfully",
  });
});

// ============================================================
// GROUPS / MESSAGES
// ============================================================

const createPlazaGroup = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const { plaza_id, name, invite_code } = req.body;

  if (!plaza_id || !name?.trim())
    throw new AppError("plaza_id and name are required", 400);

  const plazaId = parseId(plaza_id);
  if (!plazaId) throw new AppError("Invalid plaza_id", 400);
  await requirePlazaOwnership(plazaId, landlordId);

  /* FIX: use provided invite_code if given, otherwise generate one */
  const groupInviteCode = invite_code?.trim() || generateInviteCode();

  /* FIX: check for duplicate invite_code */
  if (invite_code?.trim()) {
    const [[existing]] = await db.execute(
      "SELECT id FROM plaza_groups WHERE invite_code = ?",
      [invite_code.trim()],
    );
    if (existing) throw new AppError("That invite code is already in use", 400);
  }

  const [result] = await db.execute(
    "INSERT INTO plaza_groups (plaza_id, name, invite_code, created_at) VALUES (?, ?, ?, NOW())",
    [Number(plazaId), name.trim(), groupInviteCode],
  );

  await logActivity(
    landlordId,
    "group_created",
    `Created group "${name.trim()}" (ID: ${result.insertId}) for plaza ${plazaId}`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Group created successfully",
    data: {
      id: result.insertId,
      name: name.trim(),
      invite_code: groupInviteCode,
      plaza_id: plazaId,
    },
  });
});

const getLandlordGroups = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const plazaId = parseId(req.query.plaza_id);

  const conditions = ["p.landlord_id = ?"];
  const params = [landlordId];

  if (plazaId) {
    conditions.push("p.id = ?");
    params.push(Number(plazaId));
  }

  const [rows] = await db.execute(
    /* FIX: added member_count (distinct tenant members who have joined)
       and last_message / last_message_at for the group list preview */
    `SELECT
       pg.id, pg.name, pg.invite_code, pg.created_at,
       p.id AS plaza_id, p.name AS plaza_name,
       COUNT(DISTINCT gm.id)        AS message_count,
       COUNT(DISTINCT gm.sender_id) AS member_count,
       (SELECT content FROM group_messages
        WHERE group_id = pg.id ORDER BY created_at DESC LIMIT 1) AS last_message,
       (SELECT created_at FROM group_messages
        WHERE group_id = pg.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
     FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id
     LEFT JOIN group_messages gm ON gm.group_id = pg.id
     WHERE ${conditions.join(" AND ")}
     GROUP BY pg.id
     ORDER BY pg.created_at DESC`,
    params,
  );

  return res.json({ success: true, data: rows });
});

const getGroupMessages = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const groupId = parseId(req.params.id);
  if (!groupId) throw new AppError("Invalid group ID", 400);

  /* FIX: ownership check inline — ownershipMiddleware("group") was causing 500
     because it may not handle plaza_groups table correctly */
  const [[group]] = await db.execute(
    `SELECT pg.id, pg.name, pg.invite_code, p.id AS plaza_id
     FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id
     WHERE pg.id = ? AND p.landlord_id = ?`,
    [Number(groupId), landlordId],
  );
  if (!group) throw new AppError("Group not found or access denied", 403);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = Number((page - 1) * limit);

  const [[{ total }]] = await db.execute(
    "SELECT COUNT(*) AS total FROM group_messages WHERE group_id = ?",
    [Number(groupId)],
  );

  const [messages] = await db.execute(
    /* FIX: return 'message' alias alongside 'content' for frontend compatibility */
    `SELECT
       gm.id, gm.sender_id,
       gm.content,
       gm.content AS message,
       gm.file_url, gm.file_type, gm.created_at,
       u.full_name   AS sender_name,
       u.avatar_url  AS sender_avatar,
       u.role        AS sender_role
     FROM group_messages gm
     JOIN users u ON u.id = gm.sender_id
     WHERE gm.group_id = ?
     ORDER BY gm.created_at ASC
     LIMIT ? OFFSET ?`,
    [Number(groupId), Number(limit), Number(offset)],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: messages, total, page, limit }),
  });
});

const sendGroupMessageLandlord = asyncHandler(async (req, res) => {
  const landlordId = Number(req.user.id);
  const groupId = parseId(req.params.id);
  if (!groupId) throw new AppError("Invalid group ID", 400);

  /* FIX: accept both 'content' and 'message' field names from frontend */
  const content = (req.body.content || req.body.message || "").trim();

  if (!content && !req.file)
    throw new AppError("A message or file attachment is required", 400);

  const [[group]] = await db.execute(
    `SELECT pg.id, pg.name, p.id AS plaza_id
     FROM plaza_groups pg
     JOIN plazas p ON p.id = pg.plaza_id
     WHERE pg.id = ? AND p.landlord_id = ?`,
    [Number(groupId), landlordId],
  );
  if (!group) throw new AppError("Group not found or access denied", 403);

  const file_url = req.file
    ? `uploads/group_messages/${req.file.filename}`
    : null;
  const file_type = req.file
    ? req.file.mimetype.startsWith("image/")
      ? "image"
      : req.file.mimetype === "application/pdf"
        ? "pdf"
        : "doc"
    : null;

  const [result] = await db.execute(
    "INSERT INTO group_messages (group_id, sender_id, content, file_url, file_type, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
    [Number(groupId), landlordId, content || null, file_url, file_type],
  );

  const io = req.app.get("io");
  if (io)
    io.to(`group_${groupId}`).emit("group_message", {
      id: result.insertId,
      group_id: groupId,
      sender_id: landlordId,
      content: content || null,
      message: content || null,
      file_url,
      created_at: new Date().toISOString(),
    });

  /* Notify all active tenants in this plaza */
  const [tenants] = await db.execute(
    "SELECT DISTINCT t.tenant_id AS user_id FROM tenancies t WHERE t.plaza_id = ? AND t.status = 'active'",
    [Number(group.plaza_id)],
  );

  if (tenants.length)
    await NotificationService.createBulk({
      recipientIds: tenants.map((m) => m.user_id),
      senderId: landlordId,
      type: "new_message",
      message: `New message from your landlord in group "${group.name}"`,
      groupedKey: `group_msg_${groupId}`,
      io,
    });

  await logActivity(
    landlordId,
    "message_sent",
    `Sent message to group ${groupId} (message ID: ${result.insertId})`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Message sent successfully",
    message_id: result.insertId,
  });
});

module.exports = {
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
  sendGroupMessageLandlord,
};
