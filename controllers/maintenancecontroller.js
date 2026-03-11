// controllers/maintenanceController.js
// ============================================================
// All maintenance request endpoints.
//
// Schema enums (rentms_full_schema.sql — Section 8):
//   maintenance_requests.priority : 'low' | 'medium' | 'high'
//   maintenance_requests.status   : 'pending' | 'in_progress'
//                                   | 'resolved' | 'rejected'
//
// Import path from routes:
//   require("../controllers/maintenanceController")
// ============================================================

const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");
const { buildPaginationResponse } = require("../utils/pagination");

// ── Schema-aligned constants ─────────────────────────────────
const VALID_PRIORITIES = ["low", "medium", "high"];
const VALID_STATUSES = ["pending", "in_progress", "resolved", "rejected"];

const DEFAULT_LIMIT = 20;
const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// ═══════════════════════════════════════════════════════════════
// TENANT — SUBMIT
// ═══════════════════════════════════════════════════════════════

// POST /api/maintenance
// Tenant submits a new maintenance request.
// Looks up the active tenancy to find plaza + landlord.
// Body: { title, description, priority? } + optional file "attachment"
const createRequest = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const { title, description, priority = "medium" } = req.body;

  if (!title?.trim()) throw new AppError("title is required", 400);
  if (!description?.trim()) throw new AppError("description is required", 400);
  if (!VALID_PRIORITIES.includes(priority)) {
    throw new AppError(
      `Invalid priority. Must be: ${VALID_PRIORITIES.join(", ")}`,
      400,
    );
  }

  // Confirm active tenancy
  const [[tenancy]] = await db.execute(
    `SELECT t.id AS tenancy_id, t.plaza_id, p.landlord_id
     FROM tenancies t JOIN plazas p ON p.id = t.plaza_id
     WHERE t.tenant_id = ? AND t.status = 'active'
     LIMIT 1`,
    [tenantId],
  );
  if (!tenancy)
    throw new AppError(
      "No active tenancy found. Cannot submit a request.",
      403,
    );

  const attachment_url = req.file
    ? `uploads/maintenance/${req.file.filename}`
    : null;

  const [result] = await db.execute(
    `INSERT INTO maintenance_requests
       (tenant_id, plaza_id, title, description, priority, attachment_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
    [
      tenantId,
      tenancy.plaza_id,
      title.trim(),
      description.trim(),
      priority,
      attachment_url,
    ],
  );

  // Notify landlord — non-fatal
  await NotificationService.create({
    recipientId: tenancy.landlord_id,
    senderId: tenantId,
    type: "maintenance_request",
    message: `New maintenance request: "${title.trim()}" (${priority} priority)`,
    referenceId: result.insertId,
    io: req.app.get("io"),
  });

  await logActivity(
    tenantId,
    "maintenance_created",
    `Submitted maintenance request "${title.trim()}" (ID: ${result.insertId})`,
    { ip: req.ip },
  );

  return res.status(201).json({
    success: true,
    message: "Maintenance request submitted successfully",
    request_id: result.insertId,
  });
});

// ═══════════════════════════════════════════════════════════════
// TENANT — VIEW + EDIT + DELETE OWN REQUESTS
// ═══════════════════════════════════════════════════════════════

// GET /api/maintenance/my
// Tenant's own requests, paginated.
// Query params: page, limit, status, priority
const getTenantRequests = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { status, priority } = req.query;

  if (status && !VALID_STATUSES.includes(status))
    throw new AppError(
      `Invalid status. Must be: ${VALID_STATUSES.join(", ")}`,
      400,
    );
  if (priority && !VALID_PRIORITIES.includes(priority))
    throw new AppError(
      `Invalid priority. Must be: ${VALID_PRIORITIES.join(", ")}`,
      400,
    );

  const conditions = ["mr.tenant_id = ?"];
  const params = [tenantId];

  if (status) {
    conditions.push("mr.status = ?");
    params.push(status);
  }
  if (priority) {
    conditions.push("mr.priority = ?");
    params.push(priority);
  }

  const WHERE = conditions.join(" AND ");

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM maintenance_requests mr WHERE ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT
       mr.id, mr.title, mr.description, mr.priority, mr.status,
       mr.attachment_url, mr.resolved_at, mr.created_at, mr.updated_at,
       p.name AS plaza_name, p.location
     FROM maintenance_requests mr
     JOIN plazas p ON p.id = mr.plaza_id
     WHERE ${WHERE}
     ORDER BY FIELD(mr.priority,'high','medium','low'), mr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// GET /api/maintenance/:id
// Single request — scoped by role.
// Tenant can only view own; landlord must own the plaza; admin sees all.
const getRequestById = asyncHandler(async (req, res) => {
  const requestId = parseId(req.params.id);
  if (!requestId) throw new AppError("Invalid request ID", 400);

  const [[row]] = await db.execute(
    `SELECT
       mr.id, mr.tenant_id, mr.plaza_id, mr.title, mr.description,
       mr.priority, mr.status, mr.attachment_url,
       mr.resolved_at, mr.created_at, mr.updated_at,
       p.name AS plaza_name, p.location, p.landlord_id,
       u.full_name AS tenant_name, u.email AS tenant_email,
       u.phone    AS tenant_phone
     FROM maintenance_requests mr
     JOIN plazas p ON p.id  = mr.plaza_id
     JOIN users  u ON u.id  = mr.tenant_id
     WHERE mr.id = ?`,
    [requestId],
  );

  if (!row) throw new AppError("Maintenance request not found", 404);

  if (req.user.role === "tenant" && row.tenant_id !== req.user.id)
    throw new AppError("Access denied", 403);
  if (req.user.role === "landlord" && row.landlord_id !== req.user.id)
    throw new AppError("Access denied", 403);

  return res.json({ success: true, data: row });
});

// PUT /api/maintenance/:id
// Tenant edits their own request — only while status is 'pending'.
// Body: { title?, description?, priority? }
const updateRequest = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const requestId = parseId(req.params.id);
  if (!requestId) throw new AppError("Invalid request ID", 400);

  const [[row]] = await db.execute(
    `SELECT id, status, tenant_id FROM maintenance_requests WHERE id = ?`,
    [requestId],
  );
  if (!row) throw new AppError("Maintenance request not found", 404);
  if (row.tenant_id !== tenantId) throw new AppError("Access denied", 403);
  if (row.status !== "pending")
    throw new AppError("Only pending requests can be edited", 400);

  const { title, description, priority } = req.body;

  if (priority && !VALID_PRIORITIES.includes(priority)) {
    throw new AppError(
      `Invalid priority. Must be: ${VALID_PRIORITIES.join(", ")}`,
      400,
    );
  }

  const fields = [];
  const params = [];

  if (title?.trim()) {
    fields.push("title = ?");
    params.push(title.trim());
  }
  if (description?.trim()) {
    fields.push("description = ?");
    params.push(description.trim());
  }
  if (priority) {
    fields.push("priority = ?");
    params.push(priority);
  }

  if (!fields.length) throw new AppError("No fields to update", 400);

  fields.push("updated_at = NOW()");
  params.push(requestId);

  await db.execute(
    `UPDATE maintenance_requests SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );

  await logActivity(
    tenantId,
    "maintenance_updated",
    `Updated maintenance request ${requestId}`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Maintenance request updated successfully",
  });
});

// DELETE /api/maintenance/:id
// Tenant deletes their own request — only while status is 'pending'.
const deleteRequest = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const requestId = parseId(req.params.id);
  if (!requestId) throw new AppError("Invalid request ID", 400);

  const [[row]] = await db.execute(
    `SELECT id, status, tenant_id FROM maintenance_requests WHERE id = ?`,
    [requestId],
  );
  if (!row) throw new AppError("Maintenance request not found", 404);
  if (row.tenant_id !== tenantId) throw new AppError("Access denied", 403);
  if (row.status !== "pending")
    throw new AppError("Only pending requests can be deleted", 400);

  await db.execute(`DELETE FROM maintenance_requests WHERE id = ?`, [
    requestId,
  ]);

  await logActivity(
    tenantId,
    "maintenance_updated",
    `Deleted maintenance request ${requestId}`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Maintenance request deleted successfully",
  });
});

// ═══════════════════════════════════════════════════════════════
// LANDLORD — OWN PLAZAS
// ═══════════════════════════════════════════════════════════════

// GET /api/maintenance/landlord
// All requests across the landlord's plazas — paginated.
// Query params: page, limit, status, priority, plaza_id
const getLandlordRequests = asyncHandler(async (req, res) => {
  const landlordId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { status, priority } = req.query;
  const plazaId = parseId(req.query.plaza_id);

  if (status && !VALID_STATUSES.includes(status))
    throw new AppError(
      `Invalid status. Must be: ${VALID_STATUSES.join(", ")}`,
      400,
    );
  if (priority && !VALID_PRIORITIES.includes(priority))
    throw new AppError(
      `Invalid priority. Must be: ${VALID_PRIORITIES.join(", ")}`,
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
    params.push(plazaId);
  }

  const WHERE = conditions.join(" AND ");

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM maintenance_requests mr JOIN plazas p ON p.id = mr.plaza_id
     WHERE ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT
       mr.id, mr.title, mr.description, mr.priority, mr.status,
       mr.attachment_url, mr.resolved_at, mr.created_at, mr.updated_at,
       p.id AS plaza_id, p.name AS plaza_name,
       u.full_name AS tenant_name, u.email AS tenant_email
     FROM maintenance_requests mr
     JOIN plazas p ON p.id = mr.plaza_id
     JOIN users  u ON u.id = mr.tenant_id
     WHERE ${WHERE}
     ORDER BY FIELD(mr.priority,'high','medium','low'), mr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — ALL REQUESTS
// ═══════════════════════════════════════════════════════════════

// GET /api/maintenance/admin
// Platform-wide, fully filterable — paginated.
// Query params: page, limit, status, priority, plaza_id, tenant_id
const getAllRequests = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { status, priority } = req.query;
  const plazaId = parseId(req.query.plaza_id);
  const tenantId = parseId(req.query.tenant_id);

  if (status && !VALID_STATUSES.includes(status))
    throw new AppError(
      `Invalid status. Must be: ${VALID_STATUSES.join(", ")}`,
      400,
    );
  if (priority && !VALID_PRIORITIES.includes(priority))
    throw new AppError(
      `Invalid priority. Must be: ${VALID_PRIORITIES.join(", ")}`,
      400,
    );

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push("mr.status = ?");
    params.push(status);
  }
  if (priority) {
    conditions.push("mr.priority = ?");
    params.push(priority);
  }
  if (plazaId) {
    conditions.push("mr.plaza_id = ?");
    params.push(plazaId);
  }
  if (tenantId) {
    conditions.push("mr.tenant_id = ?");
    params.push(tenantId);
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM maintenance_requests mr ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT
       mr.id, mr.title, mr.priority, mr.status,
       mr.attachment_url, mr.resolved_at, mr.created_at, mr.updated_at,
       p.id AS plaza_id, p.name AS plaza_name,
       l.full_name AS landlord_name,
       u.full_name AS tenant_name, u.email AS tenant_email
     FROM maintenance_requests mr
     JOIN plazas p ON p.id = mr.plaza_id
     JOIN users  l ON l.id = p.landlord_id
     JOIN users  u ON u.id = mr.tenant_id
     ${WHERE}
     ORDER BY FIELD(mr.priority,'high','medium','low'), mr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ═══════════════════════════════════════════════════════════════
// LANDLORD + ADMIN — UPDATE STATUS
// ═══════════════════════════════════════════════════════════════

// PATCH /api/maintenance/:id/status
// Update status of a request. Landlord must own the request's plaza.
// Sets resolved_at automatically when status = 'resolved'.
// Body: { status, note? }
const updateMaintenanceStatus = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const requestId = parseId(req.params.id);
  if (!requestId) throw new AppError("Invalid request ID", 400);

  const { status, note } = req.body;
  if (!status || !VALID_STATUSES.includes(status)) {
    throw new AppError(
      `Invalid status. Must be: ${VALID_STATUSES.join(", ")}`,
      400,
    );
  }

  const [[row]] = await db.execute(
    `SELECT mr.id, mr.status AS old_status, mr.tenant_id,
            mr.title, p.landlord_id
     FROM maintenance_requests mr
     JOIN plazas p ON p.id = mr.plaza_id
     WHERE mr.id = ?`,
    [requestId],
  );
  if (!row) throw new AppError("Maintenance request not found", 404);

  // Landlord ownership check
  if (req.user.role === "landlord" && row.landlord_id !== userId) {
    throw new AppError("Access denied — not your plaza", 403);
  }

  if (row.old_status === status) {
    return res.json({
      success: true,
      message: "Status already set to the requested value",
    });
  }

  const resolvedAt = status === "resolved" ? ", resolved_at = NOW()" : "";

  await db.execute(
    `UPDATE maintenance_requests
     SET status = ?, updated_at = NOW() ${resolvedAt}
     WHERE id = ?`,
    [status, requestId],
  );

  // Log status change in maintenance_logs
  await db.execute(
    `INSERT INTO maintenance_logs
       (maintenance_id, changed_by, old_status, new_status, note, changed_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [requestId, userId, row.old_status, status, note || null],
  );

  // Notify tenant
  await NotificationService.create({
    recipientId: row.tenant_id,
    senderId: userId,
    type: "maintenance_update",
    message: `Your request "${row.title}" has been updated to "${status}"`,
    referenceId: requestId,
    io: req.app.get("io"),
  });

  await logActivity(
    userId,
    "maintenance_status_updated",
    `Updated maintenance request ${requestId}: "${row.old_status}" → "${status}"`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: "Maintenance status updated successfully",
  });
});

// ═══════════════════════════════════════════════════════════════
// SHARED — STATUS HISTORY + ADMIN SUMMARY
// ═══════════════════════════════════════════════════════════════

// GET /api/maintenance/:id/logs
// Status change history for a request.
// Tenant scoped to own requests; landlord scoped to own plazas; admin sees all.
const getMaintenanceLogs = asyncHandler(async (req, res) => {
  const requestId = parseId(req.params.id);
  if (!requestId) throw new AppError("Invalid request ID", 400);

  const [[row]] = await db.execute(
    `SELECT mr.id, mr.tenant_id, p.landlord_id
     FROM maintenance_requests mr JOIN plazas p ON p.id = mr.plaza_id
     WHERE mr.id = ?`,
    [requestId],
  );
  if (!row) throw new AppError("Maintenance request not found", 404);

  if (req.user.role === "tenant" && row.tenant_id !== req.user.id)
    throw new AppError("Access denied", 403);
  if (req.user.role === "landlord" && row.landlord_id !== req.user.id)
    throw new AppError("Access denied", 403);

  const [logs] = await db.execute(
    `SELECT
       ml.id, ml.old_status, ml.new_status, ml.note, ml.changed_at,
       u.full_name AS changed_by_name, u.role AS changed_by_role
     FROM maintenance_logs ml
     JOIN users u ON u.id = ml.changed_by
     WHERE ml.maintenance_id = ?
     ORDER BY ml.changed_at DESC`,
    [requestId],
  );

  return res.json({ success: true, data: logs });
});

// GET /api/maintenance/summary
// Admin — monthly breakdown by status and priority.
// Query params: month (1–12), year (YYYY)
const getMonthlySummary = asyncHandler(async (req, res) => {
  const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();

  if (month < 1 || month > 12)
    throw new AppError("month must be between 1 and 12", 400);

  const [[byStatus]] = await db.execute(
    `SELECT
       SUM(status = 'pending')     AS pending,
       SUM(status = 'in_progress') AS in_progress,
       SUM(status = 'resolved')    AS resolved,
       SUM(status = 'rejected')    AS rejected,
       COUNT(*)                    AS total
     FROM maintenance_requests
     WHERE MONTH(created_at) = ? AND YEAR(created_at) = ?`,
    [month, year],
  );

  const [byPriority] = await db.execute(
    `SELECT priority, COUNT(*) AS count
     FROM maintenance_requests
     WHERE MONTH(created_at) = ? AND YEAR(created_at) = ?
     GROUP BY priority
     ORDER BY FIELD(priority,'high','medium','low')`,
    [month, year],
  );

  const [[avgResolution]] = await db.execute(
    `SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, created_at, resolved_at)), 1) AS avg_resolution_hours
     FROM maintenance_requests
     WHERE status = 'resolved'
       AND MONTH(resolved_at) = ? AND YEAR(resolved_at) = ?`,
    [month, year],
  );

  return res.json({
    success: true,
    data: {
      period: { month, year },
      by_status: byStatus,
      by_priority: byPriority,
      resolution: avgResolution,
    },
  });
});

module.exports = {
  // Tenant
  createRequest,
  getTenantRequests,
  getRequestById,
  updateRequest,
  deleteRequest,
  // Landlord
  getLandlordRequests,
  // Admin
  getAllRequests,
  getMonthlySummary,
  // Shared (Landlord + Admin)
  updateMaintenanceStatus,
  getMaintenanceLogs,
};
