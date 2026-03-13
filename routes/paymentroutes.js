// routes/paymentRoutes.js
// ============================================================
// Base path: /api/payments
// All routes require a valid JWT.
//
// Endpoints:
//   POST   /api/payments                      — tenant only
//   GET    /api/payments                      — tenant only
//   GET    /api/payments/all                  — admin, landlord
//   GET    /api/payments/:payment_id          — tenant (own)
//   GET    /api/payments/:payment_id/receipt  — tenant (own)
//   GET    /api/payments/:payment_id/download — tenant (own)
//   PATCH  /api/payments/:payment_id/verify   — admin, landlord
//   PATCH  /api/payments/:payment_id/status   — admin only
// ============================================================

const express = require("express");
const router = express.Router();

// ── Middleware ───────────────────────────────────────────────
const authMiddleware = require("../middleware/authMiddleware");
const { roleMiddleware } = require("../middleware/roleMiddleware");
const {
  paymentLimiter,
  generalLimiter,
} = require("../middleware/ratelimitMiddleware");

// ── Controllers ──────────────────────────────────────────────
const {
  makePayment,
  getPaymentHistory,
  getPaymentById,
  getReceiptById,
  downloadReceipt,
  getAllPayments,
  verifyPayment,
  updatePaymentStatus,
} = require("../controllers/paymentcontroller");

// ── Global Protection ────────────────────────────────────────
// All payment routes require a valid JWT — 401 if missing/expired
router.use(authMiddleware);

// ════════════════════════════════════════════════════════════
// TENANT ROUTES
// ════════════════════════════════════════════════════════════

/**
 * POST /api/payments
 * Tenant submits a rent payment.
 * Validates tenancy ownership, inserts payment + receipt in a
 * single transaction, notifies landlord, returns receipt number.
 * Body: { tenancy_id, amount, payment_method, momo_provider?,
 *         momo_number?, card_last4?, card_brand?, notes? }
 * payment_method: "card" | "momo" | "bank"
 * Rate limited — prevents duplicate payment submissions.
 */
router.post("/", roleMiddleware(["tenant"]), paymentLimiter, makePayment);

/**
 * GET /api/payments
 * Tenant's own paginated payment history with receipt links.
 * Query params: page, limit, from (YYYY-MM-DD), to (YYYY-MM-DD),
 *               status ("paid" | "pending" | "failed")
 */
router.get("/", roleMiddleware(["tenant"]), getPaymentHistory);

/**
 * GET /api/payments/:payment_id
 * Single payment record — tenant can only view their own.
 * Includes plaza, unit, and receipt info.
 * Returns 404 if not found or not owned by this tenant.
 */
router.get("/:payment_id", roleMiddleware(["tenant"]), getPaymentById);

/**
 * GET /api/payments/:payment_id/receipt
 * Full receipt data for a specific payment.
 * Includes tenant name, plaza, lease dates, and payment breakdown.
 * Tenant can only view receipts for their own payments.
 */
router.get("/:payment_id/receipt", roleMiddleware(["tenant"]), getReceiptById);

/**
 * GET /api/payments/:payment_id/download
 * Stream the PDF receipt file to the client.
 * Sets Content-Type: application/pdf and Content-Disposition: attachment.
 * Returns 404 if PDF file has not been generated or is missing on disk.
 * Rate limited — prevents receipt download abuse.
 */
router.get(
  "/:payment_id/download",
  roleMiddleware(["tenant"]),
  generalLimiter,
  downloadReceipt,
);

// ════════════════════════════════════════════════════════════
// ADMIN + LANDLORD ROUTES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/payments/all
 * Paginated payment list for admin or landlord.
 * Landlords are automatically scoped to their own plazas in the controller.
 * Query params: page, limit, from, to, status, plaza_id,
 *               payment_method, tenant_id
 */
router.get("/all", roleMiddleware(["admin", "landlord"]), getAllPayments);

/**
 * PATCH /api/payments/:payment_id/verify
 * Mark a pending payment as verified (status → "paid").
 * Landlords can only verify payments in their own plazas (enforced in controller).
 * Sets verified_at and verified_by on the payment record.
 * Notifies the tenant via in-app notification.
 */
router.patch(
  "/:payment_id/verify",
  roleMiddleware(["admin", "landlord"]),
  verifyPayment,
);

// ════════════════════════════════════════════════════════════
// ADMIN ONLY ROUTES
// ════════════════════════════════════════════════════════════

/**
 * PATCH /api/payments/:payment_id/status
 * Manual payment status override — admin use only.
 * Used to mark payments as failed, re-open pending, etc.
 * Body: { status }  — "paid" | "pending" | "failed"
 * Automatically sets verified_at/verified_by when setting status to "paid".
 */
router.patch(
  "/:payment_id/status",
  roleMiddleware(["admin"]),
  updatePaymentStatus,
);

module.exports = router;





