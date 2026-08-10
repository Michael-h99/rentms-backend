// controllers/paymentcontroller.js
// ============================================================
// All payment endpoints. Delegates heavy lifting to
// paymentService.js where available.
//
// Schema enums (rentms_full_schema.sql):
//   payments.status         : 'paid' | 'pending' | 'failed'
//   payments.payment_method : 'card' | 'momo'    | 'bank'
//
// Import path from routes:
//   require("../controllers/paymentController")
// ============================================================

const db = require("../utils/db");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");
const PaystackService = require("../services/paystackservice");
const {
  generateReference,
  generateReceiptNumber,
  generateTransactionId,
} = require("../utils/generateid");
const { buildPaginationResponse } = require("../utils/pagination");
const { formatDate, formatGhanaDateTime } = require("../utils/formatdate");

// ── Schema-aligned constants ─────────────────────────────────
const VALID_PAYMENT_METHODS = ["card", "momo", "bank"];
const VALID_PAYMENT_STATUSES = ["paid", "pending", "failed"];
const DEFAULT_LIMIT = 20;

// ── Paystack → schema mapping ────────────────────────────────
// Paystack's transaction `channel` doesn't line up 1:1 with our
// payment_method ENUM('card','momo','bank') — map the closest fit.
const mapPaystackChannelToPaymentMethod = (channel) => {
  if (channel === "card") return "card";
  if (channel === "mobile_money") return "momo";
  return "bank"; // bank, bank_transfer, ussd, qr, eft
};

// Paystack returns the mobile network under authorization.bank for
// momo channel transactions in Ghana — normalise to our momo_provider
// ENUM('MTN','Vodafone','AirtelTigo'). Unrecognised → null (nullable field).
const PAYSTACK_MOMO_NETWORK_MAP = {
  mtn: "MTN",
  vodafone: "Vodafone",
  telecel: "Vodafone", // Vodafone GH rebranded to Telecel — schema still uses 'Vodafone'
  airteltigo: "AirtelTigo",
  airtel: "AirtelTigo",
  tigo: "AirtelTigo",
};

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// ── PDF receipt generator ────────────────────────────────────
// Creates a PDF file on disk, returns relative path for DB storage.
const generatePDFReceipt = async ({
  receiptNumber,
  reference,
  tenantName,
  plazaName,
  location,
  unitNumber,
  amount,
  paymentMethod,
  paymentDate,
}) => {
  const receiptsDir = process.env.RECEIPTS_PATH
    ? path.join(__dirname, "..", process.env.RECEIPTS_PATH)
    : path.join(__dirname, "..", "uploads", "receipts");

  if (!fs.existsSync(receiptsDir))
    fs.mkdirSync(receiptsDir, { recursive: true });

  const fileName = `${receiptNumber}.pdf`;
  const fullPath = path.join(receiptsDir, fileName);
  const relativePath = `uploads/receipts/${fileName}`;

  const doc = new PDFDocument({ margin: 50 });
  const writeStream = fs.createWriteStream(fullPath);
  doc.pipe(writeStream);

  // Header
  doc
    .fontSize(20)
    .fillColor("#1e40af")
    .text("RENTMS GHANA", { align: "center" });
  doc
    .fontSize(14)
    .fillColor("#374151")
    .text("RENT PAYMENT RECEIPT", { align: "center" });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor("#e5e7eb").stroke();
  doc.moveDown(0.5);

  // Fields
  const field = (label, value) => {
    doc
      .fontSize(11)
      .fillColor("#6b7280")
      .text(label, { continued: true, width: 200 });
    doc.fillColor("#111827").text(String(value || "—"));
  };

  field("Receipt Number :", receiptNumber);
  field("Payment Ref    :", reference);
  field("Tenant         :", tenantName);
  field("Plaza          :", plazaName);
  field("Location       :", location);
  field("Unit           :", unitNumber || "N/A");
  field(
    "Amount Paid    :",
    `GHS ${parseFloat(amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })}`,
  );
  field("Payment Method :", paymentMethod.toUpperCase());
  field("Date           :", formatGhanaDateTime(paymentDate));

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor("#e5e7eb").stroke();
  doc.moveDown(0.5);
  doc
    .fontSize(10)
    .fillColor("#9ca3af")
    .text("This is a computer-generated receipt. No signature required.", {
      align: "center",
    });
  doc.text(`RentMS Ghana © ${new Date().getFullYear()}`, { align: "center" });

  doc.end();

  return new Promise((resolve, reject) => {
    writeStream.on("finish", () => resolve(relativePath));
    writeStream.on("error", reject);
  });
};

// ═══════════════════════════════════════════════════════════════
// TENANT — MAKE PAYMENT
// ═══════════════════════════════════════════════════════════════

// POST /api/payments
// Tenant submits a rent payment. Validates tenancy ownership,
// inserts payment + receipt in a transaction, notifies landlord.
// Body: { tenancy_id, amount, payment_method, momo_provider?,
//         momo_number?, card_last4?, card_brand?, notes? }
const makePayment = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const {
    tenancy_id,
    amount,
    payment_method,
    momo_provider,
    momo_number,
    card_last4,
    card_brand,
    notes,
  } = req.body;

  // ── Validation ──
  if (!tenancy_id || !amount || !payment_method) {
    throw new AppError(
      "tenancy_id, amount, and payment_method are required",
      400,
    );
  }
  const tenancyId = parseId(tenancy_id);
  if (!tenancyId) throw new AppError("Invalid tenancy_id", 400);

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0)
    throw new AppError("Amount must be a positive number", 400);

  if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
    throw new AppError(
      `Invalid payment_method. Must be one of: ${VALID_PAYMENT_METHODS.join(", ")}`,
      400,
    );
  }
  if (payment_method === "momo" && !momo_provider) {
    throw new AppError("momo_provider is required for MoMo payments", 400);
  }

  // ── Confirm tenancy belongs to this tenant ──
  const [[tenancy]] = await db.execute(
    `SELECT t.id, t.rent_amount, t.status, t.unit_number,
            p.id AS plaza_id, p.name AS plaza_name,
            p.location, p.landlord_id
     FROM tenancies t JOIN plazas p ON p.id = t.plaza_id
     WHERE t.id = ? AND t.tenant_id = ?`,
    [tenancyId, tenantId],
  );
  if (!tenancy) throw new AppError("Tenancy not found or access denied", 403);
  if (tenancy.status !== "active")
    throw new AppError("Cannot make payment on an inactive tenancy", 400);

  const reference = generateReference();
  const transactionId = generateTransactionId();
  const receiptNumber = generateReceiptNumber();

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Insert payment
    const [payResult] = await conn.execute(
      `INSERT INTO payments
         (tenancy_id, amount, currency, payment_method, momo_provider,
          momo_number, card_last4, card_brand, status, reference,
          transaction_id, notes, payment_date, created_at)
       VALUES (?, ?, 'GHS', ?, ?, ?, ?, ?, 'paid', ?, ?, ?, NOW(), NOW())`,
      [
        tenancyId,
        parsedAmount,
        payment_method,
        momo_provider || null,
        momo_number || null,
        card_last4 || null,
        card_brand || null,
        reference,
        transactionId,
        notes || null,
      ],
    );
    const paymentId = payResult.insertId;

    // Generate PDF receipt
    const [[{ full_name: tenantName }]] = await conn.execute(
      `SELECT full_name FROM users WHERE id = ?`,
      [tenantId],
    );

    let pdfPath = null;
    try {
      pdfPath = await generatePDFReceipt({
        receiptNumber,
        reference,
        tenantName: tenantName || req.user.username,
        plazaName: tenancy.plaza_name,
        location: tenancy.location,
        unitNumber: tenancy.unit_number,
        amount: parsedAmount,
        paymentMethod: payment_method,
        paymentDate: new Date(),
      });
    } catch (pdfErr) {
      console.warn("⚠️  PDF generation failed (non-fatal):", pdfErr.message);
    }

    // Insert receipt
    await conn.execute(
      `INSERT INTO receipts
         (payment_id, receipt_number, receipt_type, file_url, issued_at)
       VALUES (?, ?, 'rent', ?, NOW())`,
      [paymentId, receiptNumber, pdfPath || null],
    );

    await conn.commit();

    // Notify landlord — non-fatal
    await NotificationService.create({
      recipientId: tenancy.landlord_id,
      senderId: tenantId,
      type: "payment_received",
      message: `GHS ${parsedAmount.toLocaleString("en-GH", { minimumFractionDigits: 2 })} payment received from ${tenantName || req.user.username} — ${tenancy.plaza_name}`,
      referenceId: paymentId,
      io: req.app.get("io"),
    });

    await logActivity(
      tenantId,
      "payment_created",
      `Payment of GHS ${parsedAmount} submitted for tenancy ${tenancyId} (ref: ${reference})`,
      { ip: req.ip },
    );

    return res.status(201).json({
      success: true,
      message: "Payment submitted successfully",
      payment_id: paymentId,
      receipt_number: receiptNumber,
      reference,
      amount: parsedAmount,
      status: "paid",
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* silent */
    }
    throw err;
  } finally {
    conn.release();
  }
});

// ═══════════════════════════════════════════════════════════════
// TENANT — VIEW OWN PAYMENTS
// ═══════════════════════════════════════════════════════════════

// GET /api/payments
// Tenant's own paginated payment history.
// Query params: page, limit, from (YYYY-MM-DD), to (YYYY-MM-DD), status
const getPaymentHistory = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { from, to, status } = req.query;

  if (from && isNaN(Date.parse(from)))
    throw new AppError("Invalid 'from' date. Use YYYY-MM-DD", 400);
  if (to && isNaN(Date.parse(to)))
    throw new AppError("Invalid 'to' date. Use YYYY-MM-DD", 400);
  if (status && !VALID_PAYMENT_STATUSES.includes(status))
    throw new AppError(
      `Invalid status. Must be: ${VALID_PAYMENT_STATUSES.join(", ")}`,
      400,
    );

  const conditions = ["t.tenant_id = ?"];
  const params = [tenantId];

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

  const WHERE = conditions.join(" AND ");

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM payments pay
     JOIN tenancies t ON t.id = pay.tenancy_id
     WHERE ${WHERE}`,
    params,
  );

  const [payments] = await db.query(
    `SELECT
       pay.id, pay.amount, pay.currency, pay.payment_method,
       pay.momo_provider, pay.status, pay.reference, pay.transaction_id,
       pay.payment_date, pay.created_at,
       p.name AS plaza_name, p.location,
       t.unit_number,
       r.receipt_number, r.file_url AS receipt_url
     FROM payments pay
     JOIN tenancies t ON t.id    = pay.tenancy_id
     JOIN plazas    p ON p.id    = t.plaza_id
     LEFT JOIN receipts r ON r.payment_id = pay.id
     WHERE ${WHERE}
     ORDER BY pay.payment_date DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: payments, total, page, limit }),
  });
});

// GET /api/payments/:payment_id
// Single payment — tenant can only view their own.
const getPaymentById = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const paymentId = parseId(req.params.payment_id);
  if (!paymentId) throw new AppError("Invalid payment ID", 400);

  const [[payment]] = await db.execute(
    `SELECT
       pay.id, pay.amount, pay.currency, pay.payment_method,
       pay.momo_provider, pay.momo_number, pay.card_last4, pay.card_brand,
       pay.status, pay.reference, pay.transaction_id,
       pay.notes, pay.verified_at, pay.payment_date, pay.created_at,
       p.name AS plaza_name, p.location, p.landlord_id,
       t.unit_number, t.rent_amount,
       r.receipt_number, r.file_url AS receipt_url
     FROM payments pay
     JOIN tenancies t ON t.id    = pay.tenancy_id
     JOIN plazas    p ON p.id    = t.plaza_id
     LEFT JOIN receipts r ON r.payment_id = pay.id
     WHERE pay.id = ? AND t.tenant_id = ?`,
    [paymentId, tenantId],
  );

  if (!payment) throw new AppError("Payment not found", 404);
  return res.json({ success: true, data: payment });
});

// ═══════════════════════════════════════════════════════════════
// TENANT — RECEIPT
// ═══════════════════════════════════════════════════════════════

// GET /api/payments/:payment_id/receipt
// Full receipt object for a tenant's own payment.
const getReceiptById = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const paymentId = parseId(req.params.payment_id);
  if (!paymentId) throw new AppError("Invalid payment ID", 400);

  const [[receipt]] = await db.execute(
    `SELECT
       r.id AS receipt_id, r.receipt_number, r.receipt_type,
       r.file_url, r.issued_at,
       pay.id AS payment_id, pay.reference, pay.amount, pay.currency,
       pay.payment_method, pay.momo_provider, pay.status, pay.payment_date,
       u.full_name AS tenant_name, u.email AS tenant_email,
       p.name AS plaza_name, p.location AS plaza_location,
       t.rent_amount, t.lease_start, t.lease_end, t.unit_number
     FROM receipts r
     JOIN payments  pay ON pay.id      = r.payment_id
     JOIN tenancies t   ON t.id        = pay.tenancy_id
     JOIN plazas    p   ON p.id        = t.plaza_id
     JOIN users     u   ON u.id        = t.tenant_id
     WHERE pay.id = ? AND t.tenant_id = ?`,
    [paymentId, tenantId],
  );

  if (!receipt) throw new AppError("Receipt not found", 404);
  return res.json({ success: true, data: receipt });
});

// GET /api/payments/:payment_id/download
// Stream PDF receipt file to the client.
const downloadReceipt = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const paymentId = parseId(req.params.payment_id);
  if (!paymentId) throw new AppError("Invalid payment ID", 400);

  const [[receipt]] = await db.execute(
    `SELECT r.receipt_number, r.file_url
     FROM receipts r
     JOIN payments  pay ON pay.id = r.payment_id
     JOIN tenancies t   ON t.id   = pay.tenancy_id
     WHERE pay.id = ? AND t.tenant_id = ?`,
    [paymentId, tenantId],
  );

  if (!receipt) throw new AppError("Receipt not found", 404);
  if (!receipt.file_url)
    throw new AppError("PDF receipt has not been generated yet", 404);

  const fullPath = path.join(__dirname, "..", receipt.file_url);

  try {
    await fs.promises.access(fullPath);
  } catch {
    throw new AppError("Receipt file not found on server", 404);
  }

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${receipt.receipt_number}.pdf`,
  );
  res.setHeader("Content-Type", "application/pdf");
  fs.createReadStream(fullPath).pipe(res);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN + LANDLORD — VIEW ALL PAYMENTS
// ═══════════════════════════════════════════════════════════════

// GET /api/payments/all
// Admin sees everything. Landlord scoped to own plazas.
// Query params: page, limit, from, to, status, plaza_id,
//               payment_method, tenant_id
const getAllPayments = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { from, to, status, payment_method } = req.query;
  const plaza_id = parseId(req.query.plaza_id);
  const tenant_id = parseId(req.query.tenant_id);

  if (from && isNaN(Date.parse(from)))
    throw new AppError("Invalid 'from' date. Use YYYY-MM-DD", 400);
  if (to && isNaN(Date.parse(to)))
    throw new AppError("Invalid 'to' date. Use YYYY-MM-DD", 400);
  if (status && !VALID_PAYMENT_STATUSES.includes(status))
    throw new AppError(
      `Invalid status. Must be: ${VALID_PAYMENT_STATUSES.join(", ")}`,
      400,
    );
  if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method))
    throw new AppError(
      `Invalid payment_method. Must be: ${VALID_PAYMENT_METHODS.join(", ")}`,
      400,
    );

  const conditions = [];
  const params = [];

  // Landlord auto-scoped to own plazas
  if (req.user.role === "landlord") {
    conditions.push("p.landlord_id = ?");
    params.push(req.user.id);
  }

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
  if (payment_method) {
    conditions.push("pay.payment_method = ?");
    params.push(payment_method);
  }
  if (plaza_id) {
    conditions.push("p.id = ?");
    params.push(plaza_id);
  }
  if (tenant_id) {
    conditions.push("t.tenant_id = ?");
    params.push(tenant_id);
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM payments pay
     JOIN tenancies t ON t.id = pay.tenancy_id
     JOIN plazas    p ON p.id = t.plaza_id
     ${WHERE}`,
    params,
  );

  const [payments] = await db.query(
    `SELECT
       pay.id, pay.amount, pay.currency, pay.payment_method,
       pay.momo_provider, pay.status, pay.reference,
       pay.transaction_id, pay.verified_at, pay.payment_date,
       u.id AS tenant_id, u.full_name AS tenant_name, u.email AS tenant_email,
       p.id AS plaza_id, p.name AS plaza_name, p.location,
       t.unit_number,
       r.receipt_number
     FROM payments pay
     JOIN tenancies t ON t.id        = pay.tenancy_id
     JOIN plazas    p ON p.id        = t.plaza_id
     JOIN users     u ON u.id        = t.tenant_id
     LEFT JOIN receipts r ON r.payment_id = pay.id
     ${WHERE}
     ORDER BY pay.payment_date DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: payments, total, page, limit }),
  });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN + LANDLORD — VERIFY PAYMENT
// ═══════════════════════════════════════════════════════════════

// PATCH /api/payments/:payment_id/verify
// Mark a pending payment as verified (paid).
// Landlord can only verify payments in their own plazas.
const verifyPayment = asyncHandler(async (req, res) => {
  const paymentId = parseId(req.params.payment_id);
  if (!paymentId) throw new AppError("Invalid payment ID", 400);

  // Fetch payment and check ownership
  const [[payment]] = await db.execute(
    `SELECT pay.id, pay.status, p.landlord_id, pay.amount,
            t.tenant_id, u.full_name AS tenant_name, p.name AS plaza_name
     FROM payments pay
     JOIN tenancies t ON t.id = pay.tenancy_id
     JOIN plazas    p ON p.id = t.plaza_id
     JOIN users     u ON u.id = t.tenant_id
     WHERE pay.id = ?`,
    [paymentId],
  );

  if (!payment) throw new AppError("Payment not found", 404);

  if (req.user.role === "landlord" && payment.landlord_id !== req.user.id) {
    throw new AppError("Access denied — not your plaza", 403);
  }

  if (payment.status === "paid") {
    throw new AppError("Payment is already verified", 400);
  }

  await db.execute(
    `UPDATE payments
     SET status = 'paid', verified_at = NOW(), verified_by = ?, updated_at = NOW()
     WHERE id = ?`,
    [req.user.id, paymentId],
  );

  // Notify tenant
  await NotificationService.create({
    recipientId: payment.tenant_id,
    senderId: req.user.id,
    type: "payment_received",
    message: `Your payment of GHS ${parseFloat(payment.amount).toLocaleString("en-GH", { minimumFractionDigits: 2 })} for ${payment.plaza_name} has been verified`,
    referenceId: paymentId,
    io: req.app.get("io"),
  });

  await logActivity(
    req.user.id,
    "payment_verified",
    `Verified payment ${paymentId} (GHS ${payment.amount}) for tenant ${payment.tenant_name}`,
    { ip: req.ip },
  );

  return res.json({ success: true, message: "Payment verified successfully" });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — UPDATE PAYMENT STATUS
// ═══════════════════════════════════════════════════════════════

// PATCH /api/payments/:payment_id/status
// Admin-only manual status override (e.g. marking a failed payment).
// Body: { status }
const updatePaymentStatus = asyncHandler(async (req, res) => {
  const paymentId = parseId(req.params.payment_id);
  if (!paymentId) throw new AppError("Invalid payment ID", 400);

  const { status } = req.body;
  if (!status || !VALID_PAYMENT_STATUSES.includes(status)) {
    throw new AppError(
      `Invalid status. Must be one of: ${VALID_PAYMENT_STATUSES.join(", ")}`,
      400,
    );
  }

  const [[exists]] = await db.execute(`SELECT id FROM payments WHERE id = ?`, [
    paymentId,
  ]);
  if (!exists) throw new AppError("Payment not found", 404);

  const verifiedFields =
    status === "paid" ? ", verified_at = NOW(), verified_by = ?" : "";
  const extraParams =
    status === "paid" ? [req.user.id, paymentId] : [paymentId];

  await db.execute(
    `UPDATE payments SET status = ?, updated_at = NOW() ${verifiedFields} WHERE id = ?`,
    [status, ...extraParams],
  );

  await logActivity(
    req.user.id,
    "payment_status_updated",
    `Payment ${paymentId} status updated to '${status}'`,
    { ip: req.ip },
  );

  return res.json({
    success: true,
    message: `Payment status updated to '${status}'`,
  });
});

// ═══════════════════════════════════════════════════════════════
// TENANT — PAYSTACK: INITIALIZE
// ═══════════════════════════════════════════════════════════════

// POST /api/payments/initialize
// Tenant starts a real Paystack transaction. The backend — not the
// client — is the source of truth for the amount and reference.
// Body: { tenancy_id, amount }
// Returns Paystack's access_code so the frontend can open the popup.
const initializePaystackPayment = asyncHandler(async (req, res) => {
  const tenantId = req.user.id;
  const { tenancy_id, amount } = req.body;

  if (!tenancy_id || !amount) {
    throw new AppError("tenancy_id and amount are required", 400);
  }
  const tenancyId = parseId(tenancy_id);
  if (!tenancyId) throw new AppError("Invalid tenancy_id", 400);

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new AppError("Amount must be a positive number", 400);
  }

  const [[tenancy]] = await db.execute(
    `SELECT t.id, t.status,
            p.name AS plaza_name,
            u.email AS tenant_email
     FROM tenancies t
     JOIN plazas p ON p.id = t.plaza_id
     JOIN users  u ON u.id = t.tenant_id
     WHERE t.id = ? AND t.tenant_id = ?`,
    [tenancyId, tenantId],
  );
  if (!tenancy) throw new AppError("Tenancy not found or access denied", 403);
  if (tenancy.status !== "active")
    throw new AppError("Cannot make payment on an inactive tenancy", 400);
  if (!tenancy.tenant_email)
    throw new AppError(
      "Your account has no email on file — contact support",
      400,
    );

  const reference = generateReference();

  // Call Paystack BEFORE writing anything to our DB — if this fails,
  // nothing is left behind to clean up.
  const paystackData = await PaystackService.initializeTransaction({
    email: tenancy.tenant_email,
    amount: parsedAmount,
    reference,
    callback_url: process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/Tenants/payments.html`
      : undefined,
    metadata: {
      tenancy_id: tenancyId,
      tenant_id: tenantId,
      plaza_name: tenancy.plaza_name,
    },
  });

  // Pending row to reconcile the popup callback / webhook against.
  // payment_method is a placeholder — overwritten with the real
  // channel once the transaction is verified.
  await db.execute(
    `INSERT INTO payments
       (tenancy_id, amount, currency, payment_method, status, reference, payment_date, created_at)
     VALUES (?, ?, 'GHS', 'card', 'pending', ?, NOW(), NOW())`,
    [tenancyId, parsedAmount, reference],
  );

  return res.status(200).json({
    success: true,
    reference,
    access_code: paystackData.access_code,
    authorization_url: paystackData.authorization_url,
    public_key: process.env.PAYSTACK_PUBLIC_KEY,
  });
});

// ═══════════════════════════════════════════════════════════════
// PAYSTACK — SHARED RECONCILIATION
// ═══════════════════════════════════════════════════════════════

// Called by both the tenant-facing verify endpoint and the webhook.
// Always re-checks with Paystack directly — never trusts the caller.
// Idempotent: if the payment is already 'paid', it's a no-op, so a
// webhook and a manual verify racing each other can't double-process.
const finalizePaystackPayment = async (reference, { io } = {}) => {
  const [[payment]] = await db.execute(
    `SELECT py.id, py.status, py.amount, py.tenancy_id,
            t.tenant_id, t.unit_number,
            p.name AS plaza_name, p.location, p.landlord_id,
            u.full_name AS tenant_name
     FROM payments py
     JOIN tenancies t ON t.id = py.tenancy_id
     JOIN plazas    p ON p.id = t.plaza_id
     JOIN users     u ON u.id = t.tenant_id
     WHERE py.reference = ?`,
    [reference],
  );
  if (!payment) throw new AppError("Payment not found for this reference", 404);

  if (payment.status === "paid") {
    return { alreadyProcessed: true, status: "paid", paymentId: payment.id };
  }

  const tx = await PaystackService.verifyTransaction(reference);

  if (tx.status !== "success") {
    await db.execute(
      `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE id = ?`,
      [payment.id],
    );
    return {
      alreadyProcessed: false,
      status: "failed",
      paymentId: payment.id,
    };
  }

  const paidAmount = tx.amount / 100; // pesewas → GHS
  if (Math.abs(paidAmount - parseFloat(payment.amount)) > 0.01) {
    console.warn(
      `⚠️  Paystack amount mismatch on ${reference}: expected GHS ${payment.amount}, got GHS ${paidAmount}`,
    );
  }

  const paymentMethod = mapPaystackChannelToPaymentMethod(tx.channel);
  const momoProvider =
    paymentMethod === "momo"
      ? PAYSTACK_MOMO_NETWORK_MAP[
          (tx.authorization?.bank || "").toLowerCase()
        ] || null
      : null;
  const cardLast4 =
    paymentMethod === "card" ? tx.authorization?.last4 || null : null;
  const cardBrand =
    paymentMethod === "card" ? tx.authorization?.card_type || null : null;
  const transactionId = String(tx.id);
  const receiptNumber = generateReceiptNumber();

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE payments
       SET status = 'paid', payment_method = ?, momo_provider = ?,
           card_last4 = ?, card_brand = ?, transaction_id = ?,
           verified_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [
        paymentMethod,
        momoProvider,
        cardLast4,
        cardBrand,
        transactionId,
        payment.id,
      ],
    );

    let pdfPath = null;
    try {
      pdfPath = await generatePDFReceipt({
        receiptNumber,
        reference,
        tenantName: payment.tenant_name,
        plazaName: payment.plaza_name,
        location: payment.location,
        unitNumber: payment.unit_number,
        amount: paidAmount,
        paymentMethod,
        paymentDate: new Date(),
      });
    } catch (pdfErr) {
      console.warn("⚠️  PDF generation failed (non-fatal):", pdfErr.message);
    }

    await conn.execute(
      `INSERT INTO receipts
         (payment_id, receipt_number, receipt_type, file_url, issued_at)
       VALUES (?, ?, 'rent', ?, NOW())`,
      [payment.id, receiptNumber, pdfPath || null],
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  // Notify landlord — non-fatal
  await NotificationService.create({
    recipientId: payment.landlord_id,
    senderId: payment.tenant_id,
    type: "payment_received",
    message: `GHS ${paidAmount.toLocaleString("en-GH", { minimumFractionDigits: 2 })} payment received from ${payment.tenant_name} — ${payment.plaza_name}`,
    referenceId: payment.id,
    io,
  });

  await logActivity(
    payment.tenant_id,
    "payment_created",
    `Payment of GHS ${paidAmount} verified via Paystack for tenancy ${payment.tenancy_id} (ref: ${reference})`,
  );

  return {
    alreadyProcessed: false,
    status: "paid",
    paymentId: payment.id,
    receiptNumber,
  };
};

// ═══════════════════════════════════════════════════════════════
// TENANT — PAYSTACK: VERIFY (called right after the popup closes)
// ═══════════════════════════════════════════════════════════════

// GET /api/payments/verify/:reference
const verifyPaystackPayment = asyncHandler(async (req, res) => {
  const { reference } = req.params;
  if (!reference) throw new AppError("Reference is required", 400);

  const result = await finalizePaystackPayment(reference, {
    io: req.app.get("io"),
  });

  return res.json({
    success: true,
    status: result.status,
    message:
      result.status === "paid"
        ? "Payment verified successfully"
        : result.status === "failed"
          ? "Payment was not successful"
          : "Payment is still pending",
  });
});

// ═══════════════════════════════════════════════════════════════
// PAYSTACK — WEBHOOK (no auth — verified via HMAC signature instead)
// ═══════════════════════════════════════════════════════════════

// POST /api/payments/webhook
// Mounted BEFORE router.use(authMiddleware) in paymentroutes.js.
// Requires req.rawBody — see app.js express.json({ verify }) option.
const handlePaystackWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!signature || !secret || !req.rawBody) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid webhook request" });
  }

  const expected = crypto
    .createHmac("sha512", secret)
    .update(req.rawBody)
    .digest("hex");

  const signatureBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  const isValid =
    signatureBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(signatureBuf, expectedBuf);

  if (!isValid) {
    console.warn(`[WEBHOOK] Invalid Paystack signature — IP: ${req.ip}`);
    return res
      .status(400)
      .json({ success: false, message: "Invalid signature" });
  }

  const event = req.body;

  // Ack immediately — Paystack retries aggressively on slow/non-2xx
  // responses. Reconciliation happens after the response is sent.
  res.status(200).json({ received: true });

  if (event?.event !== "charge.success" || !event?.data?.reference) return;

  try {
    await finalizePaystackPayment(event.data.reference, {
      io: req.app.get("io"),
    });
  } catch (err) {
    console.error(
      `[WEBHOOK] Failed to finalize ${event.data.reference}:`,
      err.message,
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════
module.exports = {
  makePayment,
  getPaymentHistory,
  getPaymentById,
  getReceiptById,
  downloadReceipt,
  getAllPayments,
  verifyPayment,
  updatePaymentStatus,
  initializePaystackPayment,
  verifyPaystackPayment,
  handlePaystackWebhook,
};
