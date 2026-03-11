// models/plazaModel.js
// ============================================================
// Pure static utility — returns plain objects from all methods.
// All methods interact with the `plazas` table.
//
// Schema (rentms_full_schema.sql — Section 2):
//   plazas.location    : VARCHAR(255) NULL   (not required)
//   plazas.total_units : INT NULL DEFAULT 0  (not required, allows 0)
//   plazas.deleted_at  : DATETIME NULL       (soft-delete)
//   maintenance_requests.plaza_id : INT      (no tenancy_id FK)
//
// Import path from controllers:
//   require("../models/plazaModel")
// ============================================================

const db = require("../utils/db");

const DEFAULT_LIMIT = 20;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

class Plaza {
  // ════════════════════════════════════════════════════════════
  // Plaza.create
  // location and total_units are optional (schema NULLable).
  // ════════════════════════════════════════════════════════════
  static async create({ landlord_id, name, location, total_units }) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new Error("landlord_id must be a valid numeric ID");
    if (!name?.trim())
      throw new Error("name is required and must be a non-empty string");

    const units = total_units !== undefined ? parseInt(total_units, 10) : null;
    if (units !== null && (isNaN(units) || units < 0)) {
      throw new Error("total_units must be a non-negative integer");
    }

    const [result] = await db.execute(
      `INSERT INTO plazas (landlord_id, name, location, total_units, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [landlordId, name.trim(), location?.trim() || null, units],
    );

    return {
      id: result.insertId,
      landlord_id: landlordId,
      name: name.trim(),
      location: location?.trim() || null,
      total_units: units,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  // ════════════════════════════════════════════════════════════
  // Plaza.getById
  // Excludes soft-deleted plazas.
  // ════════════════════════════════════════════════════════════
  static async getById(id) {
    const plazaId = parseId(id);
    if (!plazaId) throw new Error("Invalid plaza ID");

    const [rows] = await db.execute(
      `SELECT id, landlord_id, name, location,
              total_units, created_at, updated_at
       FROM plazas
       WHERE id = ? AND deleted_at IS NULL`,
      [plazaId],
    );

    return rows.length ? rows[0] : null;
  }

  // ════════════════════════════════════════════════════════════
  // Plaza.getAll
  // Paginated + filterable — admin use.
  // Excludes soft-deleted plazas.
  // Query options: landlord_id, location (partial match), search (name)
  // ════════════════════════════════════════════════════════════
  static async getAll({
    page = 1,
    limit = DEFAULT_LIMIT,
    landlord_id,
    location,
    search,
  } = {}) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["p.deleted_at IS NULL"];
    const params = [];

    if (landlord_id) {
      const lid = parseId(landlord_id);
      if (!lid) throw new Error("Invalid landlord_id filter");
      conditions.push("p.landlord_id = ?");
      params.push(lid);
    }
    if (location) {
      conditions.push("p.location LIKE ?");
      params.push(`%${location}%`);
    }
    if (search) {
      conditions.push("p.name LIKE ?");
      params.push(`%${search}%`);
    }

    const WHERE = `WHERE ${conditions.join(" AND ")}`;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM plazas p ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         p.id, p.landlord_id, p.name, p.location,
         p.total_units, p.created_at, p.updated_at,
         u.full_name        AS landlord_name,
         u.email            AS landlord_email,
         COUNT(t.id)        AS occupied_units,
         COALESCE(p.total_units - COUNT(t.id), 0) AS vacant_units
       FROM plazas p
       LEFT JOIN users     u ON u.id = p.landlord_id
       LEFT JOIN tenancies t ON t.plaza_id = p.id AND t.status = 'active'
       ${WHERE}
       GROUP BY p.id, p.landlord_id, p.name, p.location,
                p.total_units, p.created_at, p.updated_at,
                u.full_name, u.email
       ORDER BY p.name ASC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return {
      data: rows,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        total_pages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  // Plaza.getByLandlord
  // All plazas owned by a landlord with occupancy stats.
  // Excludes soft-deleted plazas.
  // ════════════════════════════════════════════════════════════
  static async getByLandlord(
    landlord_id,
    { page = 1, limit = DEFAULT_LIMIT } = {},
  ) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new Error("Invalid landlord ID");

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM plazas WHERE landlord_id = ? AND deleted_at IS NULL`,
      [landlordId],
    );

    const [rows] = await db.execute(
      `SELECT
         p.id, p.landlord_id, p.name, p.location,
         p.total_units, p.created_at, p.updated_at,
         COUNT(t.id)                                         AS occupied_units,
         COALESCE(p.total_units - COUNT(t.id), 0)            AS vacant_units,
         ROUND(
           (COUNT(t.id) / NULLIF(p.total_units, 0)) * 100, 1
         )                                                   AS occupancy_rate,
         COALESCE(SUM(t.rent_amount), 0)                     AS total_monthly_rent
       FROM plazas p
       LEFT JOIN tenancies t ON t.plaza_id = p.id AND t.status = 'active'
       WHERE p.landlord_id = ? AND p.deleted_at IS NULL
       GROUP BY p.id, p.landlord_id, p.name, p.location,
                p.total_units, p.created_at, p.updated_at
       ORDER BY p.name ASC
       LIMIT ? OFFSET ?`,
      [landlordId, safeLimit, offset],
    );

    return {
      data: rows,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        total_pages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  // Plaza.getWithStats
  // Single plaza with live stats — used by plaza-details page.
  // maintenance_requests joins on plaza_id (no tenancy_id FK).
  // ════════════════════════════════════════════════════════════
  static async getWithStats(id) {
    const plazaId = parseId(id);
    if (!plazaId) throw new Error("Invalid plaza ID");

    const [rows] = await db.execute(
      `SELECT
         p.id, p.landlord_id, p.name, p.location,
         p.total_units, p.created_at, p.updated_at,
         u.full_name                                         AS landlord_name,
         u.email                                             AS landlord_email,
         COUNT(DISTINCT t.id)                                AS occupied_units,
         COALESCE(p.total_units - COUNT(DISTINCT t.id), 0)   AS vacant_units,
         ROUND(
           (COUNT(DISTINCT t.id) / NULLIF(p.total_units, 0)) * 100, 1
         )                                                   AS occupancy_rate,
         COALESCE(SUM(t.rent_amount), 0)                     AS total_monthly_rent,
         COUNT(DISTINCT mr.id)                               AS open_maintenance_requests
       FROM plazas p
       LEFT JOIN users    u  ON u.id  = p.landlord_id
       LEFT JOIN tenancies t ON t.plaza_id = p.id AND t.status = 'active'
       LEFT JOIN maintenance_requests mr
         ON mr.plaza_id = p.id
         AND mr.status IN ('pending', 'in_progress')
       WHERE p.id = ? AND p.deleted_at IS NULL
       GROUP BY p.id, p.landlord_id, p.name, p.location,
                p.total_units, p.created_at, p.updated_at,
                u.full_name, u.email`,
      [plazaId],
    );

    return rows.length ? rows[0] : null;
  }

  // ════════════════════════════════════════════════════════════
  // Plaza.getOccupancy
  // All active tenants in a plaza — used by plaza-details unit grid.
  // ════════════════════════════════════════════════════════════
  static async getOccupancy(plaza_id) {
    const plazaId = parseId(plaza_id);
    if (!plazaId) throw new Error("Invalid plaza ID");

    const [rows] = await db.execute(
      `SELECT
         t.id          AS tenancy_id,
         t.unit_number,
         t.rent_amount,
         t.lease_start,
         t.lease_end,
         t.status      AS tenancy_status,
         u.id          AS tenant_id,
         u.full_name   AS tenant_name,
         u.email       AS tenant_email,
         u.phone       AS tenant_phone
       FROM tenancies t
       JOIN users u ON u.id = t.tenant_id
       WHERE t.plaza_id = ? AND t.status = 'active'
       ORDER BY t.unit_number ASC`,
      [plazaId],
    );

    return rows;
  }

  // ════════════════════════════════════════════════════════════
  // Plaza.update
  // Dynamic partial update — only provided fields are changed.
  // Returns the updated plaza row via getById.
  // ════════════════════════════════════════════════════════════
  static async update(id, fields = {}) {
    const plazaId = parseId(id);
    if (!plazaId) throw new Error("Invalid plaza ID");

    const ALLOWED = ["name", "location", "total_units"];
    const updates = {};

    for (const key of ALLOWED) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (!Object.keys(updates).length)
      throw new Error("No valid update fields provided");

    if (updates.name !== undefined) {
      if (!updates.name?.trim())
        throw new Error("name must be a non-empty string");
      updates.name = updates.name.trim();
    }
    if (updates.location !== undefined) {
      updates.location = updates.location?.trim() || null;
    }
    if (updates.total_units !== undefined) {
      const units = parseInt(updates.total_units, 10);
      if (isNaN(units) || units < 0)
        throw new Error("total_units must be a non-negative integer");
      updates.total_units = units;
    }

    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const params = [...Object.values(updates), plazaId];

    const [result] = await db.execute(
      `UPDATE plazas SET ${setClauses}, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      params,
    );
    if (!result.affectedRows) throw new Error("Plaza not found");

    return Plaza.getById(plazaId);
  }

  // ════════════════════════════════════════════════════════════
  // Plaza.softDelete
  // Sets deleted_at = NOW(). Hard delete is not used —
  // plazas have related tenancies and maintenance history.
  // Controller should check for active tenancies before calling this.
  // ════════════════════════════════════════════════════════════
  static async softDelete(id) {
    const plazaId = parseId(id);
    if (!plazaId) throw new Error("Invalid plaza ID");

    const [result] = await db.execute(
      `UPDATE plazas SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [plazaId],
    );
    if (!result.affectedRows)
      throw new Error("Plaza not found or already deleted");
    return true;
  }
}

module.exports = Plaza;
