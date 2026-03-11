// models/paymentModel.js
// ============================================================
// Pure static utility — returns plain objects from all methods.
// All methods interact with the `payments` table.
//
// Schema (rentms_full_schema.sql — Section 6):
//   payments.status         : ENUM('paid','pending','failed')
//   payments.payment_method : ENUM('card','momo','bank')
//   payments.currency       : VARCHAR(10) DEFAULT 'GHS'
//   payments.momo_provider  : ENUM('MTN','Vodafone','AirtelTigo') NULL
//   payments.momo_number    : VARCHAR(20) NULL
//   payments.card_last4     : CHAR(4) NULL
//   payments.card_brand     : VARCHAR(50) NULL
//   payments.transaction_id : VARCHAR(150) NULL
//   payments.verified_at    : DATETIME NULL
//   payments.verified_by    : INT NULL
//   payments.notes          : TEXT NULL
//   payments.payment_date   : TIMESTAMP DEFAULT NOW()
//   payments.updated_at     : DATETIME NULL ON UPDATE
//   — NO completed, refunded, mobile_money, bank_transfer values
//
// Import path from controllers:
//   require("../models/paymentModel")
// ============================================================

const db = require("../utils/db");

// Schema-aligned constants
const VALID_STATUSES = ["paid", "pending", "failed"];
const VALID_PAYMENT_METHODS = ["card", "momo", "bank"];
const VALID_MOMO_PROVIDERS = ["MTN", "Vodafone", "AirtelTigo"];
const DEFAULT_LIMIT = 20;
const DEFAULT_CURRENCY = "GHS";

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};
const isValidDate = (v) => v && !isNaN(Date.parse(v));

class Payment {
  // ════════════════════════════════════════════════════════════
  // Payment.create
  // reference must be unique (schema UNIQUE KEY).
  // currency defaults to 'GHS'. All momo/card fields optional.
  // ════════════════════════════════════════════════════════════
  static async create({
    tenancy_id,
    amount,
    payment_method,
    status,
    reference,
    currency,
    transaction_id,
    notes,
    momo_provider,
    momo_number,
    card_last4,
    card_brand,
  }) {
    const tenancyId = parseId(tenancy_id);
    if (!tenancyId) throw new Error("tenancy_id must be a valid numeric ID");

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error("amount must be a positive number");
    }

    if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
      throw new Error(
        `Invalid payment_method. Must be: ${VALID_PAYMENT_METHODS.join(", ")}`,
      );
    }

    const resolvedStatus = status || "pending";
    if (!VALID_STATUSES.includes(resolvedStatus)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    if (momo_provider && !VALID_MOMO_PROVIDERS.includes(momo_provider)) {
      throw new Error(
        `Invalid momo_provider. Must be: ${VALID_MOMO_PROVIDERS.join(", ")}`,
      );
    }

    const [result] = await db.execute(
      `INSERT INTO payments
         (tenancy_id, amount, currency, payment_method, momo_provider,
          momo_number, card_last4, card_brand, status, reference,
          transaction_id, notes, payment_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        tenancyId,
        parsedAmount,
        currency || DEFAULT_CURRENCY,
        payment_method,
        momo_provider || null,
        momo_number || null,
        card_last4 || null,
        card_brand || null,
        resolvedStatus,
        reference || null,
        transaction_id || null,
        notes || null,
      ],
    );

    return {
      id: result.insertId,
      tenancy_id: tenancyId,
      amount: parsedAmount,
      currency: currency || DEFAULT_CURRENCY,
      payment_method,
      status: resolvedStatus,
      reference: reference || null,
      payment_date: new Date(),
    };
  }

  // ════════════════════════════════════════════════════════════
  // Payment.findById
  // Full context — tenant, plaza, landlord.
  // ════════════════════════════════════════════════════════════
  static async findById(id) {
    const paymentId = parseId(id);
    if (!paymentId) throw new Error("Invalid payment ID");

    const [rows] = await db.execute(
      `SELECT
         py.id, py.tenancy_id, py.amount, py.currency,
         py.payment_method, py.momo_provider, py.momo_number,
         py.card_last4, py.card_brand,
         py.status, py.reference, py.transaction_id,
         py.notes, py.verified_at, py.verified_by,
         py.payment_date, py.created_at,
         t.unit_number, t.tenant_id, t.plaza_id,
         u.full_name  AS tenant_name,
         u.email      AS tenant_email,
         p.name       AS plaza_name,
         p.location   AS plaza_location,
         p.landlord_id,
         l.full_name  AS landlord_name
       FROM payments py
       JOIN tenancies t ON t.id = py.tenancy_id
       JOIN users     u ON u.id = t.tenant_id
       JOIN plazas    p ON p.id = t.plaza_id
       JOIN users     l ON l.id = p.landlord_id
       WHERE py.id = ?`,
      [paymentId],
    );

    return rows.length ? rows[0] : null;
  }

  // ════════════════════════════════════════════════════════════
  // Payment.findByTenancy
  // Paginated payment history for a single tenancy.
  // ════════════════════════════════════════════════════════════
  static async findByTenancy(
    tenancy_id,
    { page = 1, limit = DEFAULT_LIMIT } = {},
  ) {
    const tenancyId = parseId(tenancy_id);
    if (!tenancyId) throw new Error("Invalid tenancy ID");

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM payments WHERE tenancy_id = ?`,
      [tenancyId],
    );

    const [rows] = await db.query(
    `SELECT
         py.id, py.tenancy_id, py.amount, py.currency,
         py.payment_method, py.status, py.reference,
         py.transaction_id, py.payment_date, py.created_at
       FROM payments py
       WHERE py.tenancy_id = ?
       ORDER BY py.payment_date DESC
       LIMIT ? OFFSET ?`,
      [tenancyId, safeLimit, offset],
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
  // Payment.findByTenant
  // All payments for a tenant — paginated with optional date filter.
  // ════════════════════════════════════════════════════════════
  static async findByTenant(
    tenant_id,
    { page = 1, limit = DEFAULT_LIMIT, from, to, status } = {},
  ) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new Error("Invalid tenant ID");

    if (from && !isValidDate(from))
      throw new Error("Invalid 'from' date. Use YYYY-MM-DD");
    if (to && !isValidDate(to))
      throw new Error("Invalid 'to' date. Use YYYY-MM-DD");
    if (status && !VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["t.tenant_id = ?"];
    const params = [tenantId];

    if (from) {
      conditions.push("DATE(py.payment_date) >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("DATE(py.payment_date) <= ?");
      params.push(to);
    }
    if (status) {
      conditions.push("py.status = ?");
      params.push(status);
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
       FROM payments py JOIN tenancies t ON t.id = py.tenancy_id
       WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.query(
    `SELECT
         py.id, py.tenancy_id, py.amount, py.currency,
         py.payment_method, py.status, py.reference,
         py.transaction_id, py.verified_at, py.payment_date,
         p.name      AS plaza_name,
         p.location  AS plaza_location,
         t.unit_number
       FROM payments py
       JOIN tenancies t ON t.id = py.tenancy_id
       JOIN plazas    p ON p.id = t.plaza_id
       WHERE ${WHERE}
       ORDER BY py.payment_date DESC
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
  // Payment.findByLandlord
  // All payments across a landlord's plazas — paginated.
  // ════════════════════════════════════════════════════════════
  static async findByLandlord(
    landlord_id,
    { page = 1, limit = DEFAULT_LIMIT, from, to, plaza_id, status } = {},
  ) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new Error("Invalid landlord ID");

    if (from && !isValidDate(from))
      throw new Error("Invalid 'from' date. Use YYYY-MM-DD");
    if (to && !isValidDate(to))
      throw new Error("Invalid 'to' date. Use YYYY-MM-DD");
    if (status && !VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["p.landlord_id = ?"];
    const params = [landlordId];

    if (from) {
      conditions.push("DATE(py.payment_date) >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("DATE(py.payment_date) <= ?");
      params.push(to);
    }
    if (status) {
      conditions.push("py.status = ?");
      params.push(status);
    }
    if (plaza_id) {
      const pid = parseId(plaza_id);
      if (!pid) throw new Error("Invalid plaza_id");
      conditions.push("p.id = ?");
      params.push(pid);
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
       FROM payments py
       JOIN tenancies t ON t.id = py.tenancy_id
       JOIN plazas    p ON p.id = t.plaza_id
       WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.query(
    `SELECT
         py.id, py.tenancy_id, py.amount, py.currency,
         py.payment_method, py.status, py.reference,
         py.transaction_id, py.verified_at, py.payment_date,
         t.unit_number, t.tenant_id,
         u.full_name  AS tenant_name,
         u.email      AS tenant_email,
         p.id         AS plaza_id,
         p.name       AS plaza_name
       FROM payments py
       JOIN tenancies t ON t.id = py.tenancy_id
       JOIN plazas    p ON p.id = t.plaza_id
       JOIN users     u ON u.id = t.tenant_id
       WHERE ${WHERE}
       ORDER BY py.payment_date DESC
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
  // Payment.updateStatus
  // Schema ENUM: 'paid' | 'pending' | 'failed'
  // Sets verified_at when marking as 'paid'.
  // ════════════════════════════════════════════════════════════
  static async updateStatus(id, status, verifiedBy = null) {
    const paymentId = parseId(id);
    if (!paymentId) throw new Error("Invalid payment ID");
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const verifiedById = parseId(verifiedBy) || null;

    // Set verified_at + verified_by when marking as paid
    const extraFields =
      status === "paid"
        ? ", verified_at = NOW(), verified_by = ?"
        : ", verified_at = NULL, verified_by = NULL";
    const extraParams = status === "paid" ? [verifiedById] : [];

    const [result] = await db.execute(
      `UPDATE payments
       SET status = ?, updated_at = NOW() ${extraFields}
       WHERE id = ?`,
      [status, ...extraParams, paymentId],
    );
    if (!result.affectedRows) throw new Error("Payment not found");
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // Payment.getMonthlyTotal
  // Monthly revenue summary for a landlord.
  // Returns a single flat summary object (not grouped by status).
  // ════════════════════════════════════════════════════════════
  static async getMonthlyTotal(landlord_id, month, year) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new Error("Invalid landlord ID");

    const monthNum = parseInt(month, 10);
    const yearNum = parseInt(year, 10);

    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12)
      throw new Error("month must be 1–12");
    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100)
      throw new Error("year must be a valid 4-digit year");

    const [[row]] = await db.execute(
      `SELECT
         COUNT(*)                                     AS total_payments,
         COALESCE(SUM(CASE WHEN py.status = 'paid'
           THEN py.amount ELSE 0 END), 0)             AS total_collected,
         COALESCE(SUM(CASE WHEN py.status = 'pending'
           THEN py.amount ELSE 0 END), 0)             AS total_pending,
         COALESCE(SUM(CASE WHEN py.status = 'failed'
           THEN py.amount ELSE 0 END), 0)             AS total_failed
       FROM payments py
       JOIN tenancies t ON t.id = py.tenancy_id
       JOIN plazas    p ON p.id = t.plaza_id
       WHERE p.landlord_id = ?
         AND MONTH(py.payment_date) = ?
         AND YEAR(py.payment_date)  = ?`,
      [landlordId, monthNum, yearNum],
    );

    return {
      month: monthNum,
      year: yearNum,
      total_payments: Number(row.total_payments) || 0,
      total_collected: Number(row.total_collected) || 0,
      total_pending: Number(row.total_pending) || 0,
      total_failed: Number(row.total_failed) || 0,
    };
  }
}

module.exports = Payment;
