// models/receiptModel.js
// ============================================================
// Pure static utility — returns plain objects from all methods.
// All methods interact with the `receipts` table.
//
// Schema (rentms_full_schema.sql — Section 7):
//   receipts.payment_id     : INT NOT NULL
//   receipts.receipt_number : VARCHAR(50) NOT NULL UNIQUE
//   receipts.receipt_type   : ENUM('rent','deposit','other') DEFAULT 'rent'
//   receipts.file_url       : VARCHAR(500) NULL  (PDF path)
//   receipts.issued_by      : INT NULL           (FK → users.id)
//   receipts.issued_at      : TIMESTAMP          (not issued_date / created_at)
//   — NO pdf_path, NO issued_date columns
//
// Import path from controllers:
//   require("../models/receiptModel")
// ============================================================

const crypto = require("crypto");
const db = require("../utils/db");

const DEFAULT_LIMIT = 20;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// Schema-aligned receipt_type values
const VALID_RECEIPT_TYPES = ["rent", "deposit", "other"];

// Safe join columns shared across find methods
const RECEIPT_JOIN_SELECT = `
  r.id, r.payment_id, r.receipt_number,
  r.receipt_type, r.file_url, r.issued_by, r.issued_at
`.trim();

class Receipt {
  // ════════════════════════════════════════════════════════════
  // Receipt.generateReceiptNumber
  // Format: RCT-<timestamp>-<8-hex-chars>
  // 4 bytes = 4 billion possible values — collision-safe.
  // ════════════════════════════════════════════════════════════
  static generateReceiptNumber() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();
    return `RCT-${timestamp}-${random}`;
  }

  // ════════════════════════════════════════════════════════════
  // Receipt.create
  // file_url is the path to a generated PDF stored on disk.
  // issued_by is the user ID of whoever triggered generation (optional).
  // receipt_type defaults to 'rent' to match schema DEFAULT.
  // ════════════════════════════════════════════════════════════
  static async create({
    payment_id,
    file_url,
    issued_by,
    receipt_type = "rent",
  }) {
    const paymentId = parseId(payment_id);
    if (!paymentId) throw new Error("payment_id must be a valid numeric ID");

    if (!VALID_RECEIPT_TYPES.includes(receipt_type)) {
      throw new Error(
        `Invalid receipt_type. Must be: ${VALID_RECEIPT_TYPES.join(", ")}`,
      );
    }

    // Verify payment exists before inserting
    const [[payment]] = await db.execute(
      `SELECT id FROM payments WHERE id = ?`,
      [paymentId],
    );
    if (!payment)
      throw new Error(`Payment ${paymentId} not found — cannot create receipt`);

    const receipt_number = Receipt.generateReceiptNumber();
    const issuedBy = parseId(issued_by) || null;
    const fileUrl = file_url?.trim() || null;

    const [result] = await db.execute(
      `INSERT INTO receipts
         (payment_id, receipt_number, receipt_type, file_url, issued_by, issued_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [paymentId, receipt_number, receipt_type, fileUrl, issuedBy],
    );

    return {
      id: result.insertId,
      payment_id: paymentId,
      receipt_number,
      receipt_type,
      file_url: fileUrl,
      issued_by: issuedBy,
      issued_at: new Date(),
    };
  }

  // ════════════════════════════════════════════════════════════
  // Receipt.findById
  // Returns full receipt with payment, tenancy, tenant, plaza context.
  // ════════════════════════════════════════════════════════════
  static async findById(id) {
    const receiptId = parseId(id);
    if (!receiptId) throw new Error("Invalid receipt ID");

    const [rows] = await db.execute(
      `SELECT
         ${RECEIPT_JOIN_SELECT},
         py.amount, py.payment_method, py.payment_date,
         py.status   AS payment_status,
         t.unit_number, t.tenant_id, t.plaza_id,
         u.full_name AS tenant_name,
         u.email     AS tenant_email,
         p.name      AS plaza_name,
         p.location  AS plaza_location,
         ib.full_name AS issued_by_name
       FROM receipts r
       JOIN payments  py ON py.id = r.payment_id
       JOIN tenancies t  ON t.id  = py.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    p  ON p.id  = t.plaza_id
       LEFT JOIN users ib ON ib.id = r.issued_by
       WHERE r.id = ?`,
      [receiptId],
    );

    return rows.length ? rows[0] : null;
  }

  // ════════════════════════════════════════════════════════════
  // Receipt.findByPayment
  // One payment = one receipt — returns single object or null.
  // ════════════════════════════════════════════════════════════
  static async findByPayment(payment_id) {
    const paymentId = parseId(payment_id);
    if (!paymentId) throw new Error("Invalid payment ID");

    const [rows] = await db.execute(
      `SELECT
         ${RECEIPT_JOIN_SELECT},
         py.amount, py.payment_method, py.payment_date,
         py.status AS payment_status
       FROM receipts r
       JOIN payments py ON py.id = r.payment_id
       WHERE r.payment_id = ?`,
      [paymentId],
    );

    return rows.length ? rows[0] : null;
  }

  // ════════════════════════════════════════════════════════════
  // Receipt.findByTenant
  // All receipts for a tenant — paginated, newest first.
  // ════════════════════════════════════════════════════════════
  static async findByTenant(
    tenant_id,
    { page = 1, limit = DEFAULT_LIMIT } = {},
  ) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new Error("Invalid tenant ID");

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM receipts r
       JOIN payments  py ON py.id = r.payment_id
       JOIN tenancies t  ON t.id  = py.tenancy_id
       WHERE t.tenant_id = ?`,
      [tenantId],
    );

    const [rows] = await db.query(
    `SELECT
         ${RECEIPT_JOIN_SELECT},
         py.amount, py.payment_method, py.payment_date,
         py.status   AS payment_status,
         p.name      AS plaza_name,
         p.location  AS plaza_location,
         t.unit_number
       FROM receipts r
       JOIN payments  py ON py.id = r.payment_id
       JOIN tenancies t  ON t.id  = py.tenancy_id
       JOIN plazas    p  ON p.id  = t.plaza_id
       WHERE t.tenant_id = ?
       ORDER BY r.issued_at DESC
       LIMIT ? OFFSET ?`,
      [tenantId, safeLimit, offset],
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
  // Receipt.findByLandlord
  // All receipts across a landlord's plazas — paginated, newest first.
  // ════════════════════════════════════════════════════════════
  static async findByLandlord(
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
       FROM receipts r
       JOIN payments  py ON py.id = r.payment_id
       JOIN tenancies t  ON t.id  = py.tenancy_id
       JOIN plazas    p  ON p.id  = t.plaza_id
       WHERE p.landlord_id = ?`,
      [landlordId],
    );

    const [rows] = await db.query(
    `SELECT
         ${RECEIPT_JOIN_SELECT},
         py.amount, py.payment_method, py.payment_date,
         py.status   AS payment_status,
         u.full_name AS tenant_name,
         u.email     AS tenant_email,
         p.id        AS plaza_id,
         p.name      AS plaza_name,
         t.unit_number
       FROM receipts r
       JOIN payments  py ON py.id = r.payment_id
       JOIN tenancies t  ON t.id  = py.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    p  ON p.id  = t.plaza_id
       WHERE p.landlord_id = ?
       ORDER BY r.issued_at DESC
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
  // Receipt.findByPlaza
  // All receipts for a single plaza — paginated, newest first.
  // ════════════════════════════════════════════════════════════
  static async findByPlaza(plaza_id, { page = 1, limit = DEFAULT_LIMIT } = {}) {
    const plazaId = parseId(plaza_id);
    if (!plazaId) throw new Error("Invalid plaza ID");

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM receipts r
       JOIN payments  py ON py.id = r.payment_id
       JOIN tenancies t  ON t.id  = py.tenancy_id
       WHERE t.plaza_id = ?`,
      [plazaId],
    );

    const [rows] = await db.query(
    `SELECT
         ${RECEIPT_JOIN_SELECT},
         py.amount, py.payment_method, py.payment_date,
         py.status   AS payment_status,
         u.full_name AS tenant_name,
         u.email     AS tenant_email,
         t.unit_number
       FROM receipts r
       JOIN payments  py ON py.id = r.payment_id
       JOIN tenancies t  ON t.id  = py.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       WHERE t.plaza_id = ?
       ORDER BY r.issued_at DESC
       LIMIT ? OFFSET ?`,
      [plazaId, safeLimit, offset],
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
  // Receipt.delete
  // Hard delete — receipts have no deleted_at column.
  // CASCADE on payments(id) means this also fires if the
  // parent payment is deleted, but explicit delete is here
  // for admin use.
  // ════════════════════════════════════════════════════════════
  static async delete(id) {
    const receiptId = parseId(id);
    if (!receiptId) throw new Error("Invalid receipt ID");

    const [result] = await db.execute(`DELETE FROM receipts WHERE id = ?`, [
      receiptId,
    ]);
    if (!result.affectedRows) throw new Error("Receipt not found");
    return true;
  }
}

module.exports = Receipt;
