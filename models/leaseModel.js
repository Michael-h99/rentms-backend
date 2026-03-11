// models/leaseModel.js
// ============================================================
// Pure static utility — no constructor needed.
// All methods interact with the `tenancies` table.
//
// Schema (rentms_full_schema.sql — Section 4):
//   tenancies.status       : ENUM('active','expired')   (not pending/terminated/renewed)
//   tenancies.invite_code_id : INT NULL
//   tenancies.updated_at   : DATETIME NULL ON UPDATE
//   tenancies.lease_start  : DATE NULL
//   tenancies.lease_end    : DATE NULL
//   tenancies.renewal_date : DATE NULL
//   tenancies.security_deposit : DECIMAL(10,2) NULL DEFAULT 0.00
//   — NO deleted_at column on tenancies
//
// Methods:
//   Lease.create({ ... })
//   Lease.getById(id)
//   Lease.getByTenant(tenant_id, { page, limit, status })
//   Lease.getByLandlord(landlord_id, { page, limit, status, plaza_id })
//   Lease.getByPlaza(plaza_id, { page, limit, status })
//   Lease.getExpiring(daysAhead)
//   Lease.update(id, fields)
//   Lease.updateStatus(id, status)
// ============================================================

const db = require("../utils/db");

// Schema-aligned — ENUM('active','expired') only
const VALID_STATUSES = ["active", "expired"];
const DEFAULT_LIMIT = 20;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// Shared join SELECT used by getById, getByLandlord, getByPlaza
const LEASE_JOIN_COLS = `
  t.id, t.tenant_id, t.plaza_id, t.invite_code_id,
  t.unit_number, t.rent_amount, t.security_deposit,
  t.lease_start, t.lease_end, t.renewal_date,
  t.status, t.created_at, t.updated_at
`.trim();

class Lease {
  // ════════════════════════════════════════════════════════════
  // Lease.create
  // invite_code_id is optional — tenancies can also be created
  // directly by a landlord without an invite flow.
  // Initial status is always 'active' (schema DEFAULT).
  // ════════════════════════════════════════════════════════════
  static async create({
    tenant_id,
    plaza_id,
    invite_code_id,
    unit_number,
    rent_amount,
    security_deposit,
    lease_start,
    lease_end,
    renewal_date,
  }) {
    const tenantId = parseId(tenant_id);
    const plazaId = parseId(plaza_id);
    if (!tenantId) throw new Error("tenant_id must be a valid numeric ID");
    if (!plazaId) throw new Error("plaza_id must be a valid numeric ID");

    const parsedAmount = parseFloat(rent_amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error("rent_amount must be a positive number");
    }

    // Date validation — both optional per schema, but if provided must be valid
    if (lease_start && isNaN(new Date(lease_start).getTime())) {
      throw new Error("lease_start must be a valid date");
    }
    if (lease_end && isNaN(new Date(lease_end).getTime())) {
      throw new Error("lease_end must be a valid date");
    }
    if (
      lease_start &&
      lease_end &&
      new Date(lease_end) <= new Date(lease_start)
    ) {
      throw new Error("lease_end must be after lease_start");
    }
    if (renewal_date && isNaN(new Date(renewal_date).getTime())) {
      throw new Error("renewal_date must be a valid date");
    }

    const parsedDeposit = security_deposit ? parseFloat(security_deposit) : 0;
    const parsedInviteCodeId = parseId(invite_code_id) || null;

    const [result] = await db.execute(
      `INSERT INTO tenancies
         (tenant_id, plaza_id, invite_code_id, unit_number, rent_amount,
          security_deposit, lease_start, lease_end, renewal_date,
          status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW())`,
      [
        tenantId,
        plazaId,
        parsedInviteCodeId,
        unit_number?.trim() || null,
        parsedAmount,
        parsedDeposit,
        lease_start || null,
        lease_end || null,
        renewal_date || null,
      ],
    );

    return result.insertId;
  }

  // ════════════════════════════════════════════════════════════
  // Lease.getById
  // Full context — tenant name, plaza name, landlord_id.
  // ════════════════════════════════════════════════════════════
  static async getById(id) {
    const leaseId = parseId(id);
    if (!leaseId) throw new Error("Invalid lease ID");

    const [rows] = await db.execute(
      `SELECT
         ${LEASE_JOIN_COLS},
         u.full_name AS tenant_name,
         u.email     AS tenant_email,
         u.phone     AS tenant_phone,
         p.name      AS plaza_name,
         p.location  AS plaza_location,
         p.landlord_id
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       WHERE t.id = ?`,
      [leaseId],
    );

    return rows.length ? rows[0] : null;
  }

  // ════════════════════════════════════════════════════════════
  // Lease.getByTenant
  // All leases for a tenant — paginated, newest first.
  // Optional status filter.
  // ════════════════════════════════════════════════════════════
  static async getByTenant(
    tenant_id,
    { page = 1, limit = DEFAULT_LIMIT, status } = {},
  ) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new Error("Invalid tenant ID");
    if (status && !VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["t.tenant_id = ?"];
    const params = [tenantId];
    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM tenancies t WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.query(
    `SELECT
         ${LEASE_JOIN_COLS},
         p.name      AS plaza_name,
         p.location  AS plaza_location,
         p.landlord_id
       FROM tenancies t
       JOIN plazas p ON p.id = t.plaza_id
       WHERE ${WHERE}
       ORDER BY t.created_at DESC
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
  // Lease.getByLandlord
  // All leases across a landlord's plazas — paginated.
  // Optional status and plaza_id filters.
  // ════════════════════════════════════════════════════════════
  static async getByLandlord(
    landlord_id,
    { page = 1, limit = DEFAULT_LIMIT, status, plaza_id } = {},
  ) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new Error("Invalid landlord ID");
    if (status && !VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["p.landlord_id = ?"];
    const params = [landlordId];
    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (plaza_id) {
      const pid = parseId(plaza_id);
      if (!pid) throw new Error("Invalid plaza_id");
      conditions.push("t.plaza_id = ?");
      params.push(pid);
    }
    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
       FROM tenancies t JOIN plazas p ON p.id = t.plaza_id
       WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.query(
    `SELECT
         ${LEASE_JOIN_COLS},
         u.full_name AS tenant_name,
         u.email     AS tenant_email,
         p.name      AS plaza_name,
         p.location  AS plaza_location
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       WHERE ${WHERE}
       ORDER BY t.created_at DESC
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
  // Lease.getByPlaza
  // All leases for a single plaza — paginated.
  // Optional status filter.
  // ════════════════════════════════════════════════════════════
  static async getByPlaza(
    plaza_id,
    { page = 1, limit = DEFAULT_LIMIT, status } = {},
  ) {
    const plazaId = parseId(plaza_id);
    if (!plazaId) throw new Error("Invalid plaza ID");
    if (status && !VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["t.plaza_id = ?"];
    const params = [plazaId];
    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM tenancies t WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.query(
    `SELECT
         ${LEASE_JOIN_COLS},
         u.full_name AS tenant_name,
         u.email     AS tenant_email,
         p.name      AS plaza_name
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       WHERE ${WHERE}
       ORDER BY t.created_at DESC
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
  // Lease.getExpiring
  // Active leases expiring within N days — used by email digest.
  // ════════════════════════════════════════════════════════════
  static async getExpiring(daysAhead = 30) {
    const days = parseInt(daysAhead, 10);
    if (isNaN(days) || days < 1)
      throw new Error("daysAhead must be a positive integer");

    const [rows] = await db.execute(
      `SELECT
         ${LEASE_JOIN_COLS},
         u.full_name AS tenant_name,
         u.email     AS tenant_email,
         p.name      AS plaza_name,
         p.landlord_id
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       WHERE t.status = 'active'
         AND t.lease_end IS NOT NULL
         AND t.lease_end BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
       ORDER BY t.lease_end ASC`,
      [days],
    );

    return rows;
  }

  // ════════════════════════════════════════════════════════════
  // Lease.update
  // Partial update of allowed fields. Sets updated_at = NOW().
  // ════════════════════════════════════════════════════════════
  static async update(id, fields = {}) {
    const leaseId = parseId(id);
    if (!leaseId) throw new Error("Invalid lease ID");

    const ALLOWED = [
      "unit_number",
      "rent_amount",
      "security_deposit",
      "lease_start",
      "lease_end",
      "renewal_date",
    ];

    const updates = {};
    for (const key of ALLOWED) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (!Object.keys(updates).length)
      throw new Error("No valid update fields provided");

    if (updates.rent_amount !== undefined) {
      const amt = parseFloat(updates.rent_amount);
      if (isNaN(amt) || amt <= 0)
        throw new Error("rent_amount must be a positive number");
      updates.rent_amount = amt;
    }
    if (updates.security_deposit !== undefined) {
      const dep = parseFloat(updates.security_deposit);
      if (isNaN(dep) || dep < 0)
        throw new Error("security_deposit must be a non-negative number");
      updates.security_deposit = dep;
    }
    if (updates.lease_start && isNaN(new Date(updates.lease_start).getTime())) {
      throw new Error("lease_start must be a valid date");
    }
    if (updates.lease_end && isNaN(new Date(updates.lease_end).getTime())) {
      throw new Error("lease_end must be a valid date");
    }
    if (
      updates.renewal_date &&
      isNaN(new Date(updates.renewal_date).getTime())
    ) {
      throw new Error("renewal_date must be a valid date");
    }
    if (updates.unit_number !== undefined) {
      updates.unit_number = updates.unit_number?.trim() || null;
    }

    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const params = [...Object.values(updates), leaseId];

    const [result] = await db.execute(
      `UPDATE tenancies SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      params,
    );
    if (!result.affectedRows) throw new Error("Lease not found");
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // Lease.updateStatus
  // Schema ENUM: 'active' | 'expired'
  // ════════════════════════════════════════════════════════════
  static async updateStatus(id, status) {
    const leaseId = parseId(id);
    if (!leaseId) throw new Error("Invalid lease ID");
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const [result] = await db.execute(
      `UPDATE tenancies SET status = ?, updated_at = NOW() WHERE id = ?`,
      [status, leaseId],
    );
    if (!result.affectedRows) throw new Error("Lease not found");
    return true;
  }
}

module.exports = Lease;
