// maintenanceService.js
// ============================================================
// Maintenance service — all business logic for the
// maintenance_requests table.
//
// Schema columns (rentms_full_schema.sql):
//   id, tenant_id, plaza_id, title, description,
//   priority ENUM('low','medium','high'),
//   attachment_url, status ENUM('pending','in_progress','resolved','rejected'),
//   resolved_at, created_at, updated_at
// ============================================================

const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");
const { buildPaginationResponse } = require("../utils/pagination");
const NotificationService = require("../services/notificationservice");

const VALID_STATUSES = ["pending", "in_progress", "resolved", "rejected"];
const VALID_PRIORITIES = ["low", "medium", "high"];
const DEFAULT_LIMIT = 20;

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

class MaintenanceService {
  // ── create ───────────────────────────────────────────────
  // Tenant submits a new maintenance request.
  // Sends a notification to the landlord automatically.
  //
  // Usage:
  //   const id = await MaintenanceService.create({
  //     tenant_id, plaza_id, title, description,
  //     priority, attachment_url, io
  //   });
  static async create({
    tenant_id,
    plaza_id,
    title,
    description,
    priority = "medium",
    attachment_url = null,
    io = null,
  }) {
    if (!parseId(tenant_id)) throw new AppError("Invalid tenant ID", 400);
    if (!parseId(plaza_id)) throw new AppError("Invalid plaza ID", 400);
    if (!title?.trim()) throw new AppError("Title is required", 400);
    if (!description?.trim())
      throw new AppError("Description is required", 400);

    if (!VALID_PRIORITIES.includes(priority)) {
      throw new AppError(
        `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}`,
        400,
      );
    }

    const [result] = await db.execute(
      `INSERT INTO maintenance_requests
         (tenant_id, plaza_id, title, description, priority,
          attachment_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
      [
        parseId(tenant_id),
        parseId(plaza_id),
        title.trim(),
        description.trim(),
        priority,
        attachment_url || null,
      ],
    );

    const requestId = result.insertId;

    // Notify landlord
    try {
      const [[plaza]] = await db.execute(
        `SELECT landlord_id, name FROM plazas WHERE id = ?`,
        [parseId(plaza_id)],
      );
      const [[tenant]] = await db.execute(
        `SELECT full_name FROM users WHERE id = ?`,
        [parseId(tenant_id)],
      );

      if (plaza?.landlord_id) {
        await NotificationService.create({
          recipientId: plaza.landlord_id,
          senderId: parseId(tenant_id),
          type: "maintenance_request",
          message: `New maintenance request from ${tenant?.full_name || "a tenant"}: ${title.trim()}`,
          referenceId: requestId,
          io,
        });
      }
    } catch (notifErr) {
      console.warn(
        "⚠️  MaintenanceService.create: notification failed —",
        notifErr.message,
      );
    }

    return requestId;
  }

  // ── getById ──────────────────────────────────────────────
  // Fetch a single request with full tenant and plaza context.
  static async getById(id) {
    const reqId = parseId(id);
    if (!reqId) throw new AppError("Invalid maintenance request ID", 400);

    const [rows] = await db.execute(
      `SELECT
         m.id, m.tenant_id, m.plaza_id, m.title, m.description,
         m.priority, m.attachment_url, m.status,
         m.resolved_at, m.created_at, m.updated_at,
         -- Tenant
         t.full_name    AS tenant_name,
         t.email        AS tenant_email,
         t.phone        AS tenant_phone,
         t.avatar_url   AS tenant_avatar,
         -- Plaza
         p.name         AS plaza_name,
         p.location     AS plaza_location,
         p.landlord_id,
         -- Landlord
         l.full_name    AS landlord_name,
         l.email        AS landlord_email
       FROM maintenance_requests m
       JOIN users  t ON t.id = m.tenant_id
       JOIN plazas p ON p.id = m.plaza_id
       JOIN users  l ON l.id = p.landlord_id
       WHERE m.id = ?`,
      [reqId],
    );

    if (!rows.length) throw new AppError("Maintenance request not found", 404);
    return rows[0];
  }

  // ── getByTenant ──────────────────────────────────────────
  // All requests submitted by a tenant, paginated.
  static async getByTenant(
    tenant_id,
    { page = 1, limit = DEFAULT_LIMIT, status = null } = {},
  ) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new AppError("Invalid tenant ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["m.tenant_id = ?"];
    const params = [tenantId];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push("m.status = ?");
      params.push(status);
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM maintenance_requests m WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         m.id, m.title, m.description, m.priority, m.status,
         m.attachment_url, m.resolved_at, m.created_at, m.updated_at,
         p.name AS plaza_name, p.location AS plaza_location
       FROM maintenance_requests m
       JOIN plazas p ON p.id = m.plaza_id
       WHERE ${WHERE}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── getByLandlord ────────────────────────────────────────
  // All requests across all plazas owned by a landlord, paginated.
  // Filterable by status, priority, plaza_id.
  static async getByLandlord(
    landlord_id,
    {
      page = 1,
      limit = DEFAULT_LIMIT,
      status = null,
      priority = null,
      plaza_id = null,
    } = {},
  ) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["p.landlord_id = ?"];
    const params = [landlordId];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push("m.status = ?");
      params.push(status);
    }
    if (priority && VALID_PRIORITIES.includes(priority)) {
      conditions.push("m.priority = ?");
      params.push(priority);
    }
    if (plaza_id && parseId(plaza_id)) {
      conditions.push("m.plaza_id = ?");
      params.push(parseId(plaza_id));
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM maintenance_requests m
       JOIN plazas p ON p.id = m.plaza_id
       WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         m.id, m.tenant_id, m.plaza_id, m.title, m.description,
         m.priority, m.status, m.attachment_url,
         m.resolved_at, m.created_at, m.updated_at,
         t.full_name    AS tenant_name,
         t.email        AS tenant_email,
         t.phone        AS tenant_phone,
         t.avatar_url   AS tenant_avatar,
         p.name         AS plaza_name,
         p.location     AS plaza_location
       FROM maintenance_requests m
       JOIN users  t ON t.id = m.tenant_id
       JOIN plazas p ON p.id = m.plaza_id
       WHERE ${WHERE}
       ORDER BY
         FIELD(m.priority, 'high', 'medium', 'low'),
         m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── getByPlaza ───────────────────────────────────────────
  // All requests in a specific plaza, paginated.
  static async getByPlaza(
    plaza_id,
    { page = 1, limit = DEFAULT_LIMIT, status = null } = {},
  ) {
    const plazaId = parseId(plaza_id);
    if (!plazaId) throw new AppError("Invalid plaza ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["m.plaza_id = ?"];
    const params = [plazaId];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push("m.status = ?");
      params.push(status);
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM maintenance_requests m WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         m.id, m.tenant_id, m.title, m.priority, m.status,
         m.created_at, m.updated_at,
         t.full_name AS tenant_name, t.avatar_url AS tenant_avatar
       FROM maintenance_requests m
       JOIN users t ON t.id = m.tenant_id
       WHERE ${WHERE}
       ORDER BY FIELD(m.priority, 'high', 'medium', 'low'), m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── getAll ───────────────────────────────────────────────
  // Admin only — system-wide with filters and search.
  static async getAll({
    page = 1,
    limit = DEFAULT_LIMIT,
    status = null,
    priority = null,
    search = null,
  } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = [];
    const params = [];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push("m.status = ?");
      params.push(status);
    }
    if (priority && VALID_PRIORITIES.includes(priority)) {
      conditions.push("m.priority = ?");
      params.push(priority);
    }
    if (search) {
      conditions.push(
        "(m.title LIKE ? OR t.full_name LIKE ? OR p.name LIKE ?)",
      );
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM maintenance_requests m
       JOIN users  t ON t.id = m.tenant_id
       JOIN plazas p ON p.id = m.plaza_id
       ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         m.id, m.title, m.priority, m.status,
         m.created_at, m.updated_at,
         t.full_name  AS tenant_name,
         t.email      AS tenant_email,
         p.name       AS plaza_name,
         p.location   AS plaza_location,
         p.landlord_id,
         l.full_name  AS landlord_name
       FROM maintenance_requests m
       JOIN users  t ON t.id = m.tenant_id
       JOIN plazas p ON p.id = m.plaza_id
       JOIN users  l ON l.id = p.landlord_id
       ${WHERE}
       ORDER BY FIELD(m.priority, 'high', 'medium', 'low'), m.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── updateStatus ─────────────────────────────────────────
  // Landlord updates request status.
  // Auto-sets resolved_at when status becomes 'resolved'.
  // Notifies the tenant of the status change.
  static async updateStatus(
    id,
    status,
    { landlord_id = null, io = null } = {},
  ) {
    const reqId = parseId(id);
    if (!reqId) throw new AppError("Invalid maintenance request ID", 400);

    if (!status || !VALID_STATUSES.includes(status)) {
      throw new AppError(
        `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        400,
      );
    }

    // Verify landlord owns the plaza if landlord_id is provided
    if (landlord_id) {
      const lid = parseId(landlord_id);
      const [[ownership]] = await db.execute(
        `SELECT m.id FROM maintenance_requests m
         JOIN plazas p ON p.id = m.plaza_id
         WHERE m.id = ? AND p.landlord_id = ?`,
        [reqId, lid],
      );
      if (!ownership)
        throw new AppError(
          "Maintenance request not found or access denied",
          403,
        );
    }

    const resolvedAt = status === "resolved" ? "NOW()" : "NULL";

    const [result] = await db.execute(
      `UPDATE maintenance_requests
       SET status = ?, resolved_at = ${resolvedAt}, updated_at = NOW()
       WHERE id = ?`,
      [status, reqId],
    );

    if (result.affectedRows === 0)
      throw new AppError("Maintenance request not found", 404);

    // Notify tenant
    try {
      const [[req]] = await db.execute(
        `SELECT tenant_id, title FROM maintenance_requests WHERE id = ?`,
        [reqId],
      );

      const statusLabels = {
        pending: "is pending review",
        in_progress: "is now in progress",
        resolved: "has been resolved ✅",
        rejected: "has been rejected",
      };

      if (req?.tenant_id) {
        await NotificationService.create({
          recipientId: req.tenant_id,
          senderId: landlord_id ? parseId(landlord_id) : null,
          type: "maintenance_update",
          message: `Your maintenance request "${req.title}" ${statusLabels[status] || `status updated to ${status}`}`,
          referenceId: reqId,
          io,
        });
      }
    } catch (notifErr) {
      console.warn(
        "⚠️  MaintenanceService.updateStatus: notification failed —",
        notifErr.message,
      );
    }

    return true;
  }

  // ── update ───────────────────────────────────────────────
  // Tenant edits their own pending request (title, description, priority).
  // Only allowed while status is still 'pending'.
  static async update(id, tenantId, fields = {}) {
    const reqId = parseId(id);
    const tid = parseId(tenantId);
    if (!reqId || !tid) throw new AppError("Invalid ID", 400);

    // Confirm ownership and pending status
    const [[existing]] = await db.execute(
      `SELECT id, status FROM maintenance_requests
       WHERE id = ? AND tenant_id = ?`,
      [reqId, tid],
    );

    if (!existing)
      throw new AppError("Maintenance request not found or access denied", 403);
    if (existing.status !== "pending") {
      throw new AppError("Only pending requests can be edited", 400);
    }

    const allowed = ["title", "description", "priority", "attachment_url"];
    const updates = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }

    if (Object.keys(updates).length === 0) {
      throw new AppError("No valid update fields provided", 400);
    }

    if (updates.priority && !VALID_PRIORITIES.includes(updates.priority)) {
      throw new AppError(
        `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}`,
        400,
      );
    }

    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    await db.execute(
      `UPDATE maintenance_requests SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      [...Object.values(updates), reqId],
    );

    return true;
  }

  // ── delete ───────────────────────────────────────────────
  // Tenant deletes their own pending request.
  // Only 'pending' requests can be deleted.
  static async delete(id, tenantId) {
    const reqId = parseId(id);
    const tid = parseId(tenantId);
    if (!reqId || !tid) throw new AppError("Invalid ID", 400);

    const [result] = await db.execute(
      `DELETE FROM maintenance_requests
       WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
      [reqId, tid],
    );

    if (result.affectedRows === 0) {
      throw new AppError(
        "Request not found, access denied, or not in pending status",
        403,
      );
    }
    return true;
  }

  // ── getSummary ───────────────────────────────────────────
  // Stats for a landlord's maintenance dashboard panel.
  static async getSummary(landlord_id) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const [[stats]] = await db.execute(
      `SELECT
         COUNT(*)                              AS total,
         SUM(m.status = 'pending')             AS pending,
         SUM(m.status = 'in_progress')         AS in_progress,
         SUM(m.status = 'resolved')            AS resolved,
         SUM(m.status = 'rejected')            AS rejected,
         SUM(m.priority = 'high'
           AND m.status NOT IN ('resolved','rejected')) AS open_high_priority
       FROM maintenance_requests m
       JOIN plazas p ON p.id = m.plaza_id
       WHERE p.landlord_id = ?`,
      [landlordId],
    );

    return stats;
  }

  // ── getRecentActivity ────────────────────────────────────
  // Last N resolved/updated requests — for the landlord activity feed.
  static async getRecentActivity(landlord_id, limit = 5) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const safeLimit = Math.min(20, parseInt(limit, 10) || 5);

    const [rows] = await db.execute(
      `SELECT
         m.id, m.title, m.status, m.priority,
         m.updated_at, m.resolved_at,
         t.full_name  AS tenant_name,
         p.name       AS plaza_name
       FROM maintenance_requests m
       JOIN users  t ON t.id = m.tenant_id
       JOIN plazas p ON p.id = m.plaza_id
       WHERE p.landlord_id = ?
         AND m.status IN ('resolved', 'rejected', 'in_progress')
       ORDER BY m.updated_at DESC
       LIMIT ?`,
      [landlordId, safeLimit],
    );

    return rows;
  }
}

module.exports = MaintenanceService;
