// receiptService.js
// ============================================================
// Receipt service — generates formatted text receipts and
// saves them to disk, then inserts a record into the receipts
// table linked to the payment.
//
// Schema: receipts(id, payment_id, receipt_number, receipt_type,
//                  file_url, issued_by, issued_at)
//
// File storage: uploads/receipts/<receipt_number>.txt
// DB file_url : "uploads/receipts/<receipt_number>.txt"
// ============================================================

const fs = require("fs/promises");
const path = require("path");

const db = require("../utils/db");
const { generateReceiptNumber } = require("../utils/generateid");
const { AppError } = require("../utils/errorhandler");
const { formatGhanaDateTime, toISODate } = require("../utils/formatdate");
const { buildPaginationResponse } = require("../utils/pagination");

// Receipts folder — relative to backend root
const RECEIPTS_DIR = path.join(__dirname, "uploads", "receipts");

// Schema ENUM
const VALID_RECEIPT_TYPES = ["rent", "deposit", "other"];

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

// ── ReceiptService ───────────────────────────────────────────
class ReceiptService {
  // ── generate ─────────────────────────────────────────────
  // Generate a .txt receipt file on disk AND insert a row into
  // the receipts table linked to the payment.
  // Returns { receiptNumber, fileUrl, receiptId }
  //
  // Usage (inside paymentController after inserting payment):
  //   const receipt = await ReceiptService.generate({
  //     payment_id    : paymentId,
  //     tenant_name   : "Jane Asante",
  //     tenant_email  : "jane@example.com",
  //     plaza_name    : "Sunrise Apartments",
  //     location      : "Spintex Road, Accra",
  //     unit_number   : "A1",
  //     amount        : 1500.00,
  //     payment_method: "momo",
  //     momo_provider : "MTN",
  //     reference     : "PMT-1234-ABCD",
  //     receipt_type  : "rent",
  //     issued_by     : req.user.id,    // optional
  //     connection    : conn,           // optional — for transactions
  //   });
  static async generate({
    payment_id,
    tenant_name,
    tenant_email = null,
    plaza_name,
    location = null,
    unit_number = null,
    amount,
    payment_method,
    momo_provider = null,
    momo_number = null,
    reference,
    receipt_type = "rent",
    issued_by = null,
    connection = null,
  }) {
    // ── Validate inputs ──────────────────────────────────
    if (!parseId(payment_id))
      throw new AppError("Valid payment_id is required", 400);
    if (!amount || parseFloat(amount) <= 0)
      throw new AppError("amount must be a positive number", 400);
    if (!payment_method) throw new AppError("payment_method is required", 400);
    if (!reference) throw new AppError("payment reference is required", 400);

    const type = VALID_RECEIPT_TYPES.includes(receipt_type)
      ? receipt_type
      : "rent";
    const formattedAmount = parseFloat(amount).toFixed(2);
    const receiptNumber = generateReceiptNumber();
    const issuedAt = new Date();
    const fileName = `${receiptNumber}.txt`;
    const fileUrl = `uploads/receipts/${fileName}`;
    const fullPath = path.join(RECEIPTS_DIR, fileName);

    // ── Build receipt text ───────────────────────────────
    const methodLabel = ReceiptService._formatPaymentMethod(
      payment_method,
      momo_provider,
      momo_number,
    );

    const content = [
      "╔══════════════════════════════════════════════╗",
      "║           RENT PAYMENT RECEIPT               ║",
      "║          RentMS — Ghana Property Mgmt        ║",
      "╚══════════════════════════════════════════════╝",
      "",
      `  Receipt No.    : ${receiptNumber}`,
      `  Payment Ref    : ${reference}`,
      `  Receipt Type   : ${type.toUpperCase()}`,
      "  ──────────────────────────────────────────",
      `  Tenant         : ${tenant_name || "N/A"}`,
      tenant_email ? `  Email          : ${tenant_email}` : null,
      unit_number ? `  Unit           : ${unit_number}` : null,
      `  Plaza          : ${plaza_name || "N/A"}`,
      location ? `  Location       : ${location}` : null,
      "  ──────────────────────────────────────────",
      `  Amount Paid    : GHS ${formattedAmount}`,
      `  Payment Method : ${methodLabel}`,
      `  Status         : PAID ✓`,
      `  Date & Time    : ${formatGhanaDateTime(issuedAt)}`,
      "  ──────────────────────────────────────────",
      "",
      "  Thank you for your payment.",
      "  Please keep this receipt for your records.",
      "",
      "  RentMS | rentms.com | support@rentms.com",
      "╚══════════════════════════════════════════════╝",
    ]
      .filter((line) => line !== null)
      .join("\n");

    // ── Write file ───────────────────────────────────────
    try {
      await fs.mkdir(RECEIPTS_DIR, { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");
    } catch (err) {
      throw new AppError(`Failed to write receipt file: ${err.message}`, 500);
    }

    // ── Insert into receipts table ───────────────────────
    const executor = connection || db;
    const [result] = await executor.execute(
      `INSERT INTO receipts
         (payment_id, receipt_number, receipt_type, file_url, issued_by, issued_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        parseId(payment_id),
        receiptNumber,
        type,
        fileUrl,
        issued_by ? parseId(issued_by) : null,
      ],
    );

    return {
      receiptId: result.insertId,
      receiptNumber,
      fileUrl,
      receiptType: type,
      issuedAt: issuedAt.toISOString(),
    };
  }

  // ── getById ──────────────────────────────────────────────
  // Fetch a receipt record by its DB id.
  static async getById(id) {
    const receiptId = parseId(id);
    if (!receiptId) throw new AppError("Invalid receipt ID", 400);

    const [rows] = await db.execute(
      `SELECT
         r.id, r.payment_id, r.receipt_number, r.receipt_type,
         r.file_url, r.issued_by, r.issued_at,
         p.amount, p.payment_method, p.reference, p.status AS payment_status,
         t.unit_number,
         u.full_name  AS tenant_name,
         u.email      AS tenant_email,
         pl.name      AS plaza_name,
         pl.location  AS plaza_location
       FROM receipts r
       JOIN payments  p  ON p.id  = r.payment_id
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       WHERE r.id = ?`,
      [receiptId],
    );

    if (!rows.length) throw new AppError("Receipt not found", 404);
    return rows[0];
  }

  // ── getByReceiptNumber ───────────────────────────────────
  // Fetch by receipt number string e.g. "RCT-1740000000000-A1B2C3D4"
  static async getByReceiptNumber(receiptNumber) {
    if (!receiptNumber) throw new AppError("Receipt number is required", 400);

    const [rows] = await db.execute(
      `SELECT
         r.id, r.payment_id, r.receipt_number, r.receipt_type,
         r.file_url, r.issued_at,
         p.amount, p.payment_method, p.reference,
         u.full_name AS tenant_name,
         pl.name     AS plaza_name
       FROM receipts r
       JOIN payments  p  ON p.id  = r.payment_id
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       WHERE r.receipt_number = ?`,
      [receiptNumber.trim()],
    );

    if (!rows.length) throw new AppError("Receipt not found", 404);
    return rows[0];
  }

  // ── getByPayment ─────────────────────────────────────────
  // Get receipt linked to a specific payment.
  static async getByPayment(payment_id) {
    const pid = parseId(payment_id);
    if (!pid) throw new AppError("Invalid payment ID", 400);

    const [rows] = await db.execute(
      `SELECT r.id, r.receipt_number, r.receipt_type, r.file_url, r.issued_at
       FROM receipts r
       WHERE r.payment_id = ?`,
      [pid],
    );

    return rows[0] || null;
  }

  // ── getByTenant ──────────────────────────────────────────
  // All receipts for a tenant, paginated.
  static async getByTenant(tenant_id, { page = 1, limit = 20 } = {}) {
    const tenantId = parseId(tenant_id);
    if (!tenantId) throw new AppError("Invalid tenant ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || 20);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM receipts r
       JOIN payments  p ON p.id = r.payment_id
       JOIN tenancies t ON t.id = p.tenancy_id
       WHERE t.tenant_id = ?`,
      [tenantId],
    );

    const [rows] = await db.execute(
      `SELECT
         r.id, r.receipt_number, r.receipt_type, r.file_url, r.issued_at,
         p.amount, p.payment_method, p.reference, p.payment_date,
         pl.name AS plaza_name, t.unit_number
       FROM receipts r
       JOIN payments  p  ON p.id  = r.payment_id
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       WHERE t.tenant_id = ?
       ORDER BY r.issued_at DESC
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
  // All receipts across a landlord's plazas, paginated.
  static async getByLandlord(landlord_id, { page = 1, limit = 20 } = {}) {
    const landlordId = parseId(landlord_id);
    if (!landlordId) throw new AppError("Invalid landlord ID", 400);

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || 20);
    const offset = (safePage - 1) * safeLimit;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM receipts r
       JOIN payments  p  ON p.id  = r.payment_id
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       WHERE pl.landlord_id = ?`,
      [landlordId],
    );

    const [rows] = await db.execute(
      `SELECT
         r.id, r.receipt_number, r.receipt_type, r.file_url, r.issued_at,
         p.amount, p.payment_method, p.reference, p.payment_date,
         u.full_name AS tenant_name,
         pl.name     AS plaza_name,
         t.unit_number
       FROM receipts r
       JOIN payments  p  ON p.id  = r.payment_id
       JOIN tenancies t  ON t.id  = p.tenancy_id
       JOIN users     u  ON u.id  = t.tenant_id
       JOIN plazas    pl ON pl.id = t.plaza_id
       WHERE pl.landlord_id = ?
       ORDER BY r.issued_at DESC
       LIMIT ? OFFSET ?`,
      [landlordId, safeLimit, offset],
    );

    return buildPaginationResponse({
      data: rows,
      total,
      page: safePage,
      limit: safeLimit,
    });
  }

  // ── readFile ─────────────────────────────────────────────
  // Read the .txt file content from disk for download/display.
  // Returns null if file doesn't exist (don't throw — handle gracefully).
  static async readFile(fileUrl) {
    if (!fileUrl) return null;
    try {
      const fullPath = path.join(__dirname, fileUrl);
      return await fs.readFile(fullPath, "utf8");
    } catch {
      return null;
    }
  }

  // ── deleteFile ───────────────────────────────────────────
  // Remove the receipt file from disk (admin/cleanup use).
  // Non-fatal — logs warning if file doesn't exist.
  static async deleteFile(fileUrl) {
    if (!fileUrl) return;
    try {
      const fullPath = path.join(__dirname, fileUrl);
      await fs.unlink(fullPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("⚠️  Could not delete receipt file:", err.message);
      }
    }
  }

  // ── _formatPaymentMethod ─────────────────────────────────
  // Internal helper — human-readable payment method string.
  static _formatPaymentMethod(method, momoProvider = null, momoNumber = null) {
    switch (method) {
      case "momo": {
        const provider = momoProvider ? ` (${momoProvider})` : "";
        const number = momoNumber ? ` — ${momoNumber}` : "";
        return `Mobile Money${provider}${number}`;
      }
      case "bank":
        return "Bank Transfer";
      case "card":
        return "Card Payment";
      default:
        return method.toUpperCase();
    }
  }
}

module.exports = ReceiptService;
