// paymentService.js
// ============================================================
// Payment service — all business logic for the payments table.
// Handles payment processing, verification, receipts, history,
// and late fee tracking.
//
// Schema tables used:
//   payments, receipts, late_fees, tenancies, users
// Schema views used:
//   v_payment_summary
// ============================================================

const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");
const {
  generateReference,
  generateReceiptNumber,
  generateTransactionId,
} = require("./generateId");
const { logActivity } = require("../utils/activitylogger");
const { buildPaginationResponse } = require("../utils/pagination");
const { toISODate, getCurrentMonthRange } = require("../utils/formatdate");

// Schema ENUMs — must match exactly
const VALID_PAYMENT_METHODS = ["card", "momo", "bank"];
const VALID_MOMO_PROVIDERS = ["MTN", "Vodafone", "AirtelTigo"];
const VALID_PAYMENT_STATUSES = ["paid", "pending", "failed"];
const VALID_RECEIPT_TYPES = ["rent", "deposit", "other"];
const DEFAULT_CURRENCY = "GHS";
const DEFAULT_LIMIT = 20;

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

class PaymentService {
  // ── processPayment ────────────────────────────────────────
  // Core payment processor — creates payment + receipt atomically.
  // Must be called inside a transaction (pass connection).
  // Locks the tenancy row to prevent race conditions.
  //
  // @param {object} connection   — active DB connection (from db.transaction)
  // @param {object} tenancy      — tenancy row (id, plaza_name, location, rent_amount)
  // @param {number} tenantId     — ID of the paying tenant
  // @param {number} amount       — amount to pay (GHS)
  // @param {string} paymentMethod— 'card' | 'momo' | 'bank'
  // @param {object} momoDetails  — { provider, number } — required for momo
  // @param {object} cardDetails  — { number, brand }   — required for card
  // @param {string} notes        — optional payment notes
  // @param {string} receiptType  — 'rent' | 'deposit' | 'other' (default 'rent')
  //
  // Usage (inside db.transaction):
  //   const result = await db.transaction(async (conn) => {
  //     return PaymentService.processPayment({ connection: conn, tenancy, tenantId, amount, paymentMethod });
  //   });
  static async processPayment({
    connection,
    tenancy,
    tenantId,
    amount,
    paymentMethod,
    momoDetails = {},
    cardDetails = {},
    notes = null,
    receiptType = "rent",
    issuedBy = null,
  }) {
    // ── Validate ────────────────────────────────────────────
    if (!parseId(tenantId)) throw new AppError("Invalid tenant ID", 400);
    if (!tenancy?.id) throw new AppError("Tenancy is required", 400);
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      throw new AppError(
        `Invalid payment method. Must be one of: ${VALID_PAYMENT_METHODS.join(", ")}`,
        400,
      );
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new AppError("Payment amount must be a positive number", 400);
    }

    if (!VALID_RECEIPT_TYPES.includes(receiptType)) {
      throw new AppError(
        `Invalid receipt type. Must be one of: ${VALID_RECEIPT_TYPES.join(", ")}`,
        400,
      );
    }

    // ── Method-specific field validation ────────────────────
    let momo_provider = null;
    let momo_number = null;
    let card_last4 = null;
    let card_brand = null;

    if (paymentMethod === "momo") {
      if (
        !momoDetails?.provider ||
        !VALID_MOMO_PROVIDERS.includes(momoDetails.provider)
      ) {
        throw new AppError(
          `MoMo provider required. Must be one of: ${VALID_MOMO_PROVIDERS.join(", ")}`,
          400,
        );
      }
      if (!momoDetails?.number) {
        throw new AppError("MoMo number is required", 400);
      }
      momo_provider = momoDetails.provider;
      momo_number = String(momoDetails.number).trim();
    }

    if (paymentMethod === "card") {
      if (!cardDetails?.number || !cardDetails?.brand) {
        throw new AppError("Card number and brand are required", 400);
      }
      card_last4 = String(cardDetails.number).replace(/\s/g, "").slice(-4);
      card_brand = String(cardDetails.brand).trim();
    }

    // ── Generate references ──────────────────────────────────
    const reference = generateReference();
    const transactionId = generateTransactionId();
    const receiptNumber = generateReceiptNumber();

    // ── Lock tenancy row — prevents double payment race ──────
    await connection.execute(
      `SELECT id FROM tenancies WHERE id = ? FOR UPDATE`,
      [tenancy.id],
    );

    // ── Insert payment ───────────────────────────────────────
    const [paymentResult] = await connection.execute(
      `INSERT INTO payments
         (tenancy_id, amount, currency, payment_method,
          momo_provider, momo_number, card_last4, card_brand,
          status, reference, transaction_id, notes,
          payment_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
      [
        tenancy.id,
        parsedAmount,
        DEFAULT_CURRENCY,
        paymentMethod,
        momo_provider,
        momo_number,
        card_last4,
        card_brand,
        "paid",
        reference,
        transactionId,
        notes || null,
      ],
    );

    const paymentId = paymentResult.insertId;

    // ── Insert receipt ───────────────────────────────────────
    await connection.execute(
      `INSERT INTO receipts
         (payment_id, receipt_number, receipt_type, issued_by, issued_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [
        paymentId,
        receiptNumber,
        receiptType,
        issuedBy ? parseId(issuedBy) : null,
      ],
    );

    // ── Activity log (non-fatal if fails) ───────────────────
    await logActivity(
      tenantId,
      "payment_created",
      `Paid ${DEFAULT_CURRENCY} ${parsedAmount.toFixed(2)} via ${paymentMethod.toUpperCase()} (Ref: ${reference})`,
      { connection },
    );

    return {
      paymentId,
      reference,
      transactionId,
      receiptNumber,
      amount: parsedAmount,
      currency: DEFAULT_CURRENCY,
      status: "paid",
    };
  }

  // ── getById ───────────────────────────────────────────────
  // Fetch a single payment with receipt and tenant context.
  static async getById(id) {
    const paymentId = parseId(id);
    if (!paymentId) throw new AppError("Invalid payment ID", 400);

    const [rows] = await db.execute(
      `SELECT
         p.id, p.tenancy_id, p.amount, p.currency, p.payment_method,
         p.momo_provider, p.momo_number, p.card_last4, p.card_brand,
         p.status, p.reference, p.transaction_id, p.notes,
         p.verified_at, p.verified_by, p.payment_date, p.created_at,
         -- Receipt
         r.id             AS receipt_id,
         r.receipt_number,
         r.receipt_type,
         r.file_url       AS receipt_url,
         r.issued_at,
         -- Tenant
         u.id             AS tenant_id,
         u.full_name      AS tenant_name,
         u.email          AS tenant_email,
         -- Plaza
         pl.name          AS plaza_name,
         pl.location      AS plaza_location,
         t.unit_number
       FROM payments p
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE p.id = ?`,
      [paymentId],
    );

    if (!rows.length) throw new AppError("Payment not found", 404);
    return rows[0];
  }

  // ── getByReference ────────────────────────────────────────
  // Fetch payment by its unique reference string.
  static async getByReference(reference) {
    if (!reference) throw new AppError("Reference is required", 400);

    const [rows] = await db.execute(
      `SELECT p.*, r.receipt_number, r.file_url AS receipt_url
       FROM payments p
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE p.reference = ?`,
      [String(reference).trim()],
    );

    if (!rows.length) throw new AppError("Payment not found", 404);
    return rows[0];
  }

  // ── getByTenant ───────────────────────────────────────────
  // Payment history for a tenant, paginated.
  static async getByTenant(
    tenant_id,
    { page = 1, limit = DEFAULT_LIMIT, status = null } = {},
  ) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new AppError("Invalid tenant ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["t.tenant_id = ?"];
    const params = [tenantId];

    if (status && VALID_PAYMENT_STATUSES.includes(status)) {
      conditions.push("p.status = ?");
      params.push(status);
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM payments p JOIN tenancies t ON t.id = p.tenancy_id
       WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         p.id, p.amount, p.currency, p.payment_method, p.momo_provider,
         p.status, p.reference, p.payment_date,
         r.receipt_number, r.file_url AS receipt_url,
         pl.name AS plaza_name, t.unit_number
       FROM payments p
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE ${WHERE}
       ORDER BY p.payment_date DESC
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

  // ── getByLandlord ─────────────────────────────────────────
  // All payments across a landlord's plazas, paginated.
  static async getByLandlord(
    landlord_id,
    { page = 1, limit = DEFAULT_LIMIT, status = null, plaza_id = null } = {},
  ) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || DEFAULT_LIMIT);
    const offset = (safePage - 1) * safeLimit;

    const conditions = ["pl.landlord_id = ?"];
    const params = [landlordId];

    if (status && VALID_PAYMENT_STATUSES.includes(status)) {
      conditions.push("p.status = ?");
      params.push(status);
    }
    if (plaza_id && parseId(plaza_id)) {
      conditions.push("t.plaza_id = ?");
      params.push(parseId(plaza_id));
    }

    const WHERE = conditions.join(" AND ");

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM payments p
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         p.id, p.amount, p.currency, p.payment_method, p.momo_provider,
         p.status, p.reference, p.transaction_id, p.payment_date,
         p.verified_at,
         u.full_name  AS tenant_name,
         u.email      AS tenant_email,
         pl.name      AS plaza_name,
         t.unit_number,
         r.receipt_number
       FROM payments p
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       LEFT JOIN receipts r ON r.payment_id = p.id
       WHERE ${WHERE}
       ORDER BY p.payment_date DESC
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

  // ── getAll ────────────────────────────────────────────────
  // Admin — all payments system-wide with filters, paginated.
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

    if (status && VALID_PAYMENT_STATUSES.includes(status)) {
      conditions.push("p.status = ?");
      params.push(status);
    }
    if (search) {
      conditions.push(
        "(u.full_name LIKE ? OR p.reference LIKE ? OR pl.name LIKE ?)",
      );
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM payments p
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       ${WHERE}`,
      params,
    );

    const [rows] = await db.execute(
      `SELECT
         p.id, p.amount, p.currency, p.payment_method, p.status,
         p.reference, p.payment_date, p.verified_at,
         u.full_name  AS tenant_name,
         u.email      AS tenant_email,
         pl.name      AS plaza_name,
         pl.location  AS plaza_location,
         t.unit_number,
         l.full_name  AS landlord_name
       FROM payments p
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       JOIN users     l  ON l.id  = pl.landlord_id
       ${WHERE}
       ORDER BY p.payment_date DESC
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

  // ── getMonthlyRevenue ─────────────────────────────────────
  // Total paid revenue for a landlord in a given month.
  // Defaults to current month.
  static async getMonthlyRevenue(landlord_id, year = null, month = null) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const now = new Date();
    const targetYear = parseInt(year, 10) || now.getFullYear();
    const targetMonth = parseInt(month, 10) || now.getMonth() + 1;

    const [[result]] = await db.execute(
      `SELECT
         COALESCE(SUM(p.amount), 0) AS total_revenue,
         COUNT(p.id)                AS payment_count
       FROM payments p
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       WHERE pl.landlord_id = ?
         AND p.status       = 'paid'
         AND YEAR(p.payment_date)  = ?
         AND MONTH(p.payment_date) = ?`,
      [landlordId, targetYear, targetMonth],
    );

    return {
      total_revenue: parseFloat(result.total_revenue),
      payment_count: result.payment_count,
      currency: DEFAULT_CURRENCY,
      year: targetYear,
      month: targetMonth,
    };
  }

  // ── verify ────────────────────────────────────────────────
  // Admin/landlord marks a payment as verified.
  static async verify(paymentId, verifiedBy) {
    const pid = parseId(paymentId);
    const vid = parseId(verifiedBy);
    if (!pid) throw new AppError("Invalid payment ID", 400);
    if (!vid) throw new AppError("Invalid verifier ID", 400);

    const [result] = await db.execute(
      `UPDATE payments
       SET verified_at = NOW(), verified_by = ?, updated_at = NOW()
       WHERE id = ? AND status = 'paid'`,
      [vid, pid],
    );

    if (result.affectedRows === 0) {
      throw new AppError("Payment not found or not in paid status", 404);
    }

    await logActivity(vid, "payment_verified", `Verified payment ID ${pid}`);
    return true;
  }

  // ── updateStatus ──────────────────────────────────────────
  // Update payment status (admin use).
  static async updateStatus(paymentId, status, updatedBy = null) {
    const pid = parseId(paymentId);
    if (!pid) throw new AppError("Invalid payment ID", 400);

    if (!VALID_PAYMENT_STATUSES.includes(status)) {
      throw new AppError(
        `Invalid status. Must be one of: ${VALID_PAYMENT_STATUSES.join(", ")}`,
        400,
      );
    }

    const [result] = await db.execute(
      `UPDATE payments SET status = ?, updated_at = NOW() WHERE id = ?`,
      [status, pid],
    );

    if (result.affectedRows === 0) throw new AppError("Payment not found", 404);

    if (updatedBy) {
      await logActivity(
        updatedBy,
        "payment_status_updated",
        `Payment ID ${pid} status updated to ${status}`,
      );
    }

    return true;
  }

  // ── hasPaidThisMonth ──────────────────────────────────────
  // Check if a tenancy has a paid payment in the current month.
  // Used by overdue detection and notification triggers.
  static async hasPaidThisMonth(tenancy_id) {
    const tid = parseId(tenancy_id);
    if (!tid) return false;

    const { start, end } = getCurrentMonthRange();

    const [[{ count }]] = await db.execute(
      `SELECT COUNT(*) AS count FROM payments
       WHERE tenancy_id = ?
         AND status = 'paid'
         AND DATE(payment_date) BETWEEN ? AND ?`,
      [tid, start, end],
    );

    return count > 0;
  }

  // ── getSummary ────────────────────────────────────────────
  // Payment summary stats for a tenancy — uses v_payment_summary view.
  static async getSummary(tenancy_id) {
    const tid = parseId(tenancy_id);
    if (!tid) throw new AppError("Invalid tenancy ID", 400);

    const [rows] = await db.execute(
      `SELECT * FROM v_payment_summary WHERE tenancy_id = ?`,
      [tid],
    );

    return rows[0] || null;
  }

  // ── applyLateFee ──────────────────────────────────────────
  // Apply a late fee to a tenancy for the current month.
  // Idempotent — skips if a fee already exists for this month.
  static async applyLateFee(tenancy_id, amount, connection = null) {
    const tid = parseId(tenancy_id);
    if (!tid) throw new AppError("Invalid tenancy ID", 400);

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new AppError("Late fee amount must be a positive number", 400);
    }

    const appliedMonth = toISODate(new Date()).slice(0, 7) + "-01"; // first of month
    const executor = connection || db;

    // Check if fee already applied this month
    const [[{ existing }]] = await executor.execute(
      `SELECT COUNT(*) AS existing FROM late_fees
       WHERE tenancy_id = ? AND applied_month = ?`,
      [tid, appliedMonth],
    );

    if (existing > 0)
      return { skipped: true, reason: "Late fee already applied this month" };

    await executor.execute(
      `INSERT INTO late_fees (tenancy_id, amount, applied_month, status, created_at)
       VALUES (?, ?, ?, 'pending', NOW())`,
      [tid, parsedAmount, appliedMonth],
    );

    return { skipped: false, amount: parsedAmount, appliedMonth };
  }

  // ── getLateFees ───────────────────────────────────────────
  // Get all late fees for a tenancy.
  static async getLateFees(tenancy_id) {
    const tid = parseId(tenancy_id);
    if (!tid) throw new AppError("Invalid tenancy ID", 400);

    const [rows] = await db.execute(
      `SELECT id, tenancy_id, amount, applied_month, status, created_at
       FROM late_fees
       WHERE tenancy_id = ?
       ORDER BY applied_month DESC`,
      [tid],
    );

    return rows;
  }
}

module.exports = PaymentService;
