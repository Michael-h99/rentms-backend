// leaseService.js
// ============================================================
// Lease service — all business logic for the tenancies table.
// The DB table is called "tenancies" but the app calls them
// "leases" to be more user-friendly. This service is the
// single source of truth for all lease operations.
//
// Uses schema views where available:
//   v_expiring_leases   — leases expiring within N days
//
// NOTE: v_overdue_tenants is no longer used by this service.
// Its definition ("no payment this month") is incompatible with
// advance/multi-month rent payments — a tenant who pays 6 months
// ahead would incorrectly show as overdue in month 2. getOverdue()
// below now computes overdue status directly from
// tenancies.rent_covered_until instead. The view can be left
// unused or dropped; nothing else in this file depends on it.
//
// REQUIRES MIGRATION (not yet applied — run before deploying
// rent payment feature):
//   ALTER TABLE tenancies ADD COLUMN rent_covered_until DATE NULL;
//
// All methods throw AppError so controllers can forward
// errors directly to globalErrorHandler via asyncHandler.
// ============================================================

const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");
const { getDaysUntil, toISODate, addDays } = require("../utils/formatdate");
const { buildPaginationResponse } = require("../utils/pagination");

// Schema ENUM('active','expired')
const VALID_STATUSES = ["active", "expired"];

const DEFAULT_LIMIT = 20;

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

// ── LeaseService ─────────────────────────────────────────────
class LeaseService {
  // ── create ───────────────────────────────────────────────
  // Create a new lease (tenancy record).
  // Normally called by authController after invite code claim,
  // but also available for admin/landlord direct creation.
  //
  // Usage:
  //   const leaseId = await LeaseService.create({ tenant_id, plaza_id, ... });
  static async create({
    tenant_id,
    plaza_id,
    invite_code_id = null,
    unit_number = null,
    rent_amount,
    security_deposit = 0.0,
    lease_start,
    lease_end,
    connection = null, // pass for atomic operations
  }) {
    if (!tenant_id || !plaza_id || !rent_amount || !lease_start || !lease_end) {
      throw new AppError(
        "tenant_id, plaza_id, rent_amount, lease_start, and lease_end are required",
        400,
      );
    }

    if (!parseId(tenant_id) || !parseId(plaza_id)) {
      throw new AppError(
        "tenant_id and plaza_id must be valid numeric IDs",
        400,
      );
    }

    const amount = parseFloat(rent_amount);
    if (isNaN(amount) || amount <= 0) {
      throw new AppError("rent_amount must be a positive number", 400);
    }

    const start = new Date(lease_start);
    const end = new Date(lease_end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new AppError(
        "lease_start and lease_end must be valid dates (YYYY-MM-DD)",
        400,
      );
    }
    if (end <= start) {
      throw new AppError("lease_end must be after lease_start", 400);
    }

    const executor = connection || db;
    const [result] = await executor.execute(
      `INSERT INTO tenancies
         (tenant_id, plaza_id, invite_code_id, unit_number, rent_amount,
          security_deposit, lease_start, lease_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
      [
        tenant_id,
        plaza_id,
        invite_code_id ? parseId(invite_code_id) : null,
        unit_number || null,
        amount,
        parseFloat(security_deposit) || 0.0,
        toISODate(start),
        toISODate(end),
      ],
    );

    return result.insertId;
  }

  // ── getById ──────────────────────────────────────────────
  // Fetch a single lease by ID with full context (tenant, plaza, landlord).
  static async getById(id) {
    const leaseId = parseId(id);
    if (!leaseId) throw new AppError("Invalid lease ID", 400);

    const [rows] = await db.execute(
      `SELECT
         t.id, t.tenant_id, t.plaza_id, t.invite_code_id,
         t.unit_number, t.rent_amount, t.security_deposit,
         t.lease_start, t.lease_end, t.renewal_date,
         t.rent_covered_until,
         (t.rent_covered_until IS NULL OR t.rent_covered_until < CURDATE()) AS is_overdue,
         t.status, t.created_at, t.updated_at,
         -- Tenant details
         u.username     AS tenant_username,
         u.full_name    AS tenant_name,
         u.email        AS tenant_email,
         u.phone        AS tenant_phone,
         u.avatar_url   AS tenant_avatar,
         -- Plaza details
         p.name         AS plaza_name,
         p.location     AS plaza_location,
         p.landlord_id,
         -- Landlord details
         l.username     AS landlord_username,
         l.full_name    AS landlord_name,
         l.email        AS landlord_email
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       JOIN users  l ON l.id = p.landlord_id
       WHERE t.id = ?`,
      [leaseId],
    );

    if (!rows.length) throw new AppError("Lease not found", 404);
    return rows[0];
  }

  // ── getActiveLease ───────────────────────────────────────
  // Get the active lease for a specific tenant.
  // A tenant should only have one active lease at a time.
  static async getActiveLease(tenant_id) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new AppError("Invalid tenant ID", 400);

    const [rows] = await db.execute(
      `SELECT
         t.id, t.tenant_id, t.plaza_id, t.unit_number, t.rent_amount,
         t.security_deposit, t.lease_start, t.lease_end, t.renewal_date,
         t.rent_covered_until,
         (t.rent_covered_until IS NULL OR t.rent_covered_until < CURDATE()) AS is_overdue,
         t.status, t.created_at,
         u.full_name    AS tenant_name,
         u.email        AS tenant_email,
         u.phone        AS tenant_phone,
         p.name         AS plaza_name,
         p.location     AS plaza_location,
         p.landlord_id,
         l.full_name    AS landlord_name,
         l.email        AS landlord_email,
         l.phone        AS landlord_phone
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       JOIN users  l ON l.id = p.landlord_id
       WHERE t.tenant_id = ? AND t.status = 'active'
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [tenantId],
    );

    return rows[0] || null;
  }

  // ── getByTenant ──────────────────────────────────────────
  // All leases (active + expired) for a tenant, paginated.
  static async getByTenant(
    tenant_id,
    { page = 1, limit = DEFAULT_LIMIT } = {},
  ) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new AppError("Invalid tenant ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM tenancies WHERE tenant_id = ?`,
      [tenantId],
    );

    const [rows] = await db.execute(
      `SELECT
         t.id, t.unit_number, t.rent_amount, t.security_deposit,
         t.lease_start, t.lease_end, t.renewal_date, t.status, t.created_at,
         p.name AS plaza_name, p.location AS plaza_location,
         p.landlord_id,
         l.full_name AS landlord_name, l.email AS landlord_email
       FROM tenancies t
       JOIN plazas p ON p.id = t.plaza_id
       JOIN users  l ON l.id = p.landlord_id
       WHERE t.tenant_id = ?
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [tenantId, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── getByLandlord ────────────────────────────────────────
  // All leases across all plazas owned by a landlord, paginated.
  static async getByLandlord(
    landlord_id,
    { page = 1, limit = DEFAULT_LIMIT, status = null, plaza_id = null } = {},
  ) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["p.landlord_id = ?"];
    const params = [landlordId];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (plaza_id && parseId(plaza_id)) {
      conditions.push("t.plaza_id = ?");
      params.push(parseId(plaza_id));
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM tenancies t JOIN plazas p ON p.id = t.plaza_id
       WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         t.id, t.tenant_id, t.plaza_id, t.unit_number, t.rent_amount,
         t.security_deposit, t.lease_start, t.lease_end, t.renewal_date,
         t.rent_covered_until,
         (t.rent_covered_until IS NULL OR t.rent_covered_until < CURDATE()) AS is_overdue,
         t.status, t.created_at,
         u.full_name  AS tenant_name,
         u.email      AS tenant_email,
         u.phone      AS tenant_phone,
         u.avatar_url AS tenant_avatar,
         p.name       AS plaza_name,
         p.location   AS plaza_location
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       WHERE ${WHERE}
       ORDER BY t.created_at DESC
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
  // All leases in a specific plaza, paginated.
  static async getByPlaza(
    plaza_id,
    { page = 1, limit = DEFAULT_LIMIT, status = null } = {},
  ) {
    const plazaId = parseId(plaza_id);
    if (!plazaId) throw new AppError("Invalid plaza ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["t.plaza_id = ?"];
    const params = [plazaId];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push("t.status = ?");
      params.push(status);
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM tenancies t WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         t.id, t.tenant_id, t.unit_number, t.rent_amount,
         t.security_deposit, t.lease_start, t.lease_end,
         t.rent_covered_until,
         (t.rent_covered_until IS NULL OR t.rent_covered_until < CURDATE()) AS is_overdue,
         t.status, t.created_at,
         u.full_name  AS tenant_name,
         u.email      AS tenant_email,
         u.phone      AS tenant_phone,
         u.avatar_url AS tenant_avatar
       FROM tenancies t
       JOIN users u ON u.id = t.tenant_id
       WHERE ${WHERE}
       ORDER BY t.unit_number ASC
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
  // Admin only — all leases system-wide with filters, paginated.
  static async getAll({
    page = 1,
    limit = DEFAULT_LIMIT,
    status = null,
    search = null,
  } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = [];
    const params = [];

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (search) {
      conditions.push(
        "(u.full_name LIKE ? OR u.email LIKE ? OR p.name LIKE ? OR t.unit_number LIKE ?)",
      );
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         t.id, t.tenant_id, t.plaza_id, t.unit_number, t.rent_amount,
         t.security_deposit, t.lease_start, t.lease_end,
         t.rent_covered_until,
         (t.rent_covered_until IS NULL OR t.rent_covered_until < CURDATE()) AS is_overdue,
         t.status, t.created_at,
         u.full_name    AS tenant_name,
         u.email        AS tenant_email,
         p.name         AS plaza_name,
         p.location     AS plaza_location,
         p.landlord_id,
         l.full_name    AS landlord_name
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       JOIN users  l ON l.id = p.landlord_id
       ${WHERE}
       ORDER BY t.created_at DESC
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

  // ── getExpiring ──────────────────────────────────────────
  // Leases expiring within N days — uses schema view v_expiring_leases.
  // Default 30 days — used by cron jobs and email alerts.
  // (Unrelated to rent payment — this tracks lease_end, the contract
  // end date, not rent_covered_until.)
  static async getExpiring(daysAhead = 30) {
    const days = parseInt(daysAhead, 10);
    if (isNaN(days) || days < 1)
      throw new AppError("daysAhead must be a positive integer", 400);

    const [rows] = await db.execute(
      `SELECT * FROM v_expiring_leases
       WHERE days_remaining <= ?
       ORDER BY days_remaining ASC`,
      [days],
    );

    // Attach formatted days_remaining label
    return rows.map((row) => ({
      ...row,
      days_remaining_label:
        row.days_remaining === 0
          ? "Expires today"
          : row.days_remaining === 1
            ? "Expires tomorrow"
            : `Expires in ${row.days_remaining} days`,
    }));
  }

  // ── getOverdue ───────────────────────────────────────────
  // Tenants whose rent coverage has lapsed.
  //
  // UPDATED: previously queried the v_overdue_tenants view, which
  // defined "overdue" as "no payment recorded this calendar month."
  // That broke as soon as multi-month/advance payments were
  // supported — a tenant who paid 6 months ahead would still show
  // as overdue in month 2. Now computed directly from
  // tenancies.rent_covered_until, which tracks the date rent is
  // actually paid through, regardless of which month payment landed in.
  static async getOverdue(landlord_id = null) {
    const conditions = [
      "t.status = 'active'",
      "(t.rent_covered_until IS NULL OR t.rent_covered_until < CURDATE())",
    ];
    const params = [];

    if (landlord_id) {
      const landlordId = parseId(landlord_id);
      if (!landlordId) throw new AppError("Invalid landlord ID", 400);
      conditions.push("p.landlord_id = ?");
      params.push(landlordId);
    }

    const [rows] = await db.execute(
      `SELECT
         t.id AS tenancy_id, t.tenant_id, t.unit_number, t.rent_amount,
         t.rent_covered_until,
         u.full_name AS tenant_name, u.email AS tenant_email, u.phone AS tenant_phone,
         p.id AS plaza_id, p.name AS plaza_name, p.landlord_id
       FROM tenancies t
       JOIN users  u ON u.id = t.tenant_id
       JOIN plazas p ON p.id = t.plaza_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.rent_covered_until ASC`,
      params,
    );
    return rows;
  }

  // ── update ───────────────────────────────────────────────
  // Update allowed lease fields. Validates each field before update.
  static async update(id, fields = {}, connection = null) {
    const leaseId = parseId(id);
    if (!leaseId) throw new AppError("Invalid lease ID", 400);

    const allowed = [
      "unit_number",
      "rent_amount",
      "security_deposit",
      "lease_end",
      "renewal_date",
    ];

    const updates = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }

    if (Object.keys(updates).length === 0) {
      throw new AppError("No valid update fields provided", 400);
    }

    if (updates.rent_amount !== undefined) {
      const amount = parseFloat(updates.rent_amount);
      if (isNaN(amount) || amount <= 0)
        throw new AppError("rent_amount must be a positive number", 400);
      updates.rent_amount = amount;
    }

    if (updates.lease_end !== undefined) {
      if (isNaN(new Date(updates.lease_end).getTime())) {
        throw new AppError("lease_end must be a valid date (YYYY-MM-DD)", 400);
      }
      updates.lease_end = toISODate(new Date(updates.lease_end));
    }

    if (updates.renewal_date !== undefined && updates.renewal_date !== null) {
      if (isNaN(new Date(updates.renewal_date).getTime())) {
        throw new AppError(
          "renewal_date must be a valid date (YYYY-MM-DD)",
          400,
        );
      }
      updates.renewal_date = toISODate(new Date(updates.renewal_date));
    }

    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const values = [...Object.values(updates), leaseId];

    const executor = connection || db;
    const [result] = await executor.execute(
      `UPDATE tenancies SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      values,
    );

    if (result.affectedRows === 0) throw new AppError("Lease not found", 404);
    return true;
  }

  // ── updateStatus ─────────────────────────────────────────
  // Update lease status. Schema only allows 'active' or 'expired'.
  static async updateStatus(id, status, connection = null) {
    const leaseId = parseId(id);
    if (!leaseId) throw new AppError("Invalid lease ID", 400);

    if (!status || !VALID_STATUSES.includes(status)) {
      throw new AppError(
        `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        400,
      );
    }

    const executor = connection || db;
    const [result] = await executor.execute(
      `UPDATE tenancies SET status = ?, updated_at = NOW() WHERE id = ?`,
      [status, leaseId],
    );

    if (result.affectedRows === 0) throw new AppError("Lease not found", 404);
    return true;
  }

  // ── updateRentCoverage ───────────────────────────────────
  // NEW: extends rent_covered_until by monthsPaid, anchored to
  // whichever is later — today, or the tenant's existing coverage
  // date — so paying ahead stacks instead of resetting.
  // Called by tenantController.verifyRentPayment after a
  // successful Paystack verification. Returns the new
  // rent_covered_until date.
  static async updateRentCoverage(id, monthsPaid, connection = null) {
    const leaseId = parseId(id);
    if (!leaseId) throw new AppError("Invalid lease ID", 400);

    const months = parseInt(monthsPaid, 10);
    if (isNaN(months) || months < 1) {
      throw new AppError("monthsPaid must be a positive integer", 400);
    }

    const executor = connection || db;

    const [result] = await executor.execute(
      `UPDATE tenancies
       SET rent_covered_until = DATE_ADD(
             GREATEST(COALESCE(rent_covered_until, CURDATE()), CURDATE()),
             INTERVAL ? MONTH
           ),
           updated_at = NOW()
       WHERE id = ?`,
      [months, leaseId],
    );

    if (result.affectedRows === 0) throw new AppError("Lease not found", 404);

    const [[updated]] = await executor.execute(
      `SELECT rent_covered_until FROM tenancies WHERE id = ?`,
      [leaseId],
    );

    return updated?.rent_covered_until || null;
  }

  // ── renew ────────────────────────────────────────────────
  // Renew a lease by extending the end date and setting renewal_date.
  // Atomically updates status to 'active' if it was expired.
  static async renew(
    id,
    { new_lease_end, renewal_date = null, connection = null } = {},
  ) {
    const leaseId = parseId(id);
    if (!leaseId) throw new AppError("Invalid lease ID", 400);

    if (!new_lease_end)
      throw new AppError("new_lease_end is required for renewal", 400);

    const newEnd = new Date(new_lease_end);
    if (isNaN(newEnd.getTime()))
      throw new AppError("new_lease_end must be a valid date", 400);

    // Fetch current lease to validate extension
    const lease = await LeaseService.getById(leaseId);
    if (new Date(new_lease_end) <= new Date(lease.lease_end)) {
      throw new AppError(
        "new_lease_end must be after the current lease_end",
        400,
      );
    }

    const executor = connection || db;
    await executor.execute(
      `UPDATE tenancies
       SET lease_end = ?, renewal_date = ?, status = 'active', updated_at = NOW()
       WHERE id = ?`,
      [
        toISODate(newEnd),
        renewal_date ? toISODate(new Date(renewal_date)) : toISODate(newEnd),
        leaseId,
      ],
    );

    return true;
  }

  // ── autoExpire ───────────────────────────────────────────
  // Mark all leases past their lease_end as 'expired'.
  // Called by a scheduled cron job (or admin endpoint).
  // Returns the count of leases that were updated.
  static async autoExpire() {
    const [result] = await db.execute(
      `UPDATE tenancies
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'active'
         AND lease_end < CURDATE()`,
    );
    return result.affectedRows;
  }

  // ── getSummary ───────────────────────────────────────────
  // Quick stats for a landlord's dashboard.
  static async getSummary(landlord_id) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const [[stats]] = await db.execute(
      `SELECT
         COUNT(*)                                    AS total_leases,
         SUM(t.status = 'active')                   AS active_leases,
         SUM(t.status = 'expired')                  AS expired_leases,
         COALESCE(SUM(t.rent_amount), 0)            AS total_monthly_rent,
         SUM(t.lease_end < CURDATE()
           AND t.status = 'active')                 AS needs_expiry_update,
         SUM(t.lease_end BETWEEN CURDATE()
           AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
           AND t.status = 'active')                 AS expiring_soon,
         SUM((t.rent_covered_until IS NULL OR t.rent_covered_until < CURDATE())
           AND t.status = 'active')                 AS overdue_tenants
       FROM tenancies t
       JOIN plazas p ON p.id = t.plaza_id
       WHERE p.landlord_id = ?`,
      [landlordId],
    );

    return stats;
  }

  // ── delete ───────────────────────────────────────────────
  // Hard delete a lease. Use with caution — cascades to payments.
  // Prefer updateStatus('expired') for soft deactivation.
  static async delete(id) {
    const leaseId = parseId(id);
    if (!leaseId) throw new AppError("Invalid lease ID", 400);

    const [result] = await db.execute(`DELETE FROM tenancies WHERE id = ?`, [
      leaseId,
    ]);

    if (result.affectedRows === 0) throw new AppError("Lease not found", 404);
    return true;
  }
}

module.exports = LeaseService;
