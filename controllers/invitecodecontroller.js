// controllers/inviteCodeController.js
// ============================================================
// Landlord invite code management.
// All routes are landlord-only (enforced in invitecoderoutes.js).
//
// Functions:
//   listCodes   — GET  /api/invite-codes
//   createCode  — POST /api/invite-codes
//   revokeCode  — DELETE /api/invite-codes/:id
//
// Uses InviteCode model for all DB operations.
// ============================================================

const InviteCode = require("../models/invitecodeModel");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");

// ── parseId ──────────────────────────────────────────────────
const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// ============================================================
// listCodes
// GET /api/invite-codes
// Query: ?status=active|used|expired|revoked&plaza_id=1&page=1&limit=20
// ============================================================
const listCodes = asyncHandler(async (req, res) => {
  const { status, plaza_id, page, limit } = req.query;

  const result = await InviteCode.listByLandlord(req.user.id, {
    status,
    plazaId: plaza_id,
    page: parseInt(page, 10) || 1,
    limit: parseInt(limit, 10) || 20,
  });

  return res.json({ success: true, ...result });
});

// ============================================================
// createCode
// POST /api/invite-codes
// Body: { plaza_id, unit_number, rent_amount, max_uses,
//         lease_start, lease_end, expires_at }
// ============================================================
const createCode = asyncHandler(async (req, res) => {
  const landlordId = req.user.id;
  const {
    plaza_id,
    unit_number,
    rent_amount,
    max_uses = 1,
    lease_start = null,
    lease_end = null,
    expires_at,
  } = req.body;

  // Validate required fields
  if (!plaza_id) throw new AppError("plaza_id is required", 400);
  if (!unit_number) throw new AppError("unit_number is required", 400);
  if (!rent_amount) throw new AppError("rent_amount is required", 400);
  if (!expires_at)
    throw new AppError("expires_at is required (YYYY-MM-DD HH:MM:SS)", 400);

  const plazaId = parseId(plaza_id);
  if (!plazaId) throw new AppError("Invalid plaza_id", 400);

  // Verify landlord owns the plaza
  const db = require("../utils/db");
  const [[plaza]] = await db.execute(
    `SELECT id, name FROM plazas WHERE id = ? AND landlord_id = ? AND deleted_at IS NULL`,
    [plazaId, landlordId],
  );

  if (!plaza) throw new AppError("Plaza not found or access denied", 403);

  const { id, code } = await InviteCode.create({
    landlordId,
    plazaId,
    plazaName: plaza.name,
    unitNumber: unit_number,
    rentAmount: rent_amount,
    maxUses: max_uses,
    leaseStart: lease_start,
    leaseEnd: lease_end,
    expiresAt: expires_at,
  });

  await logActivity({
    userId: landlordId,
    action: "invite_code_created",
    description: `Created invite code "${code}" for plaza ${plazaId}, unit ${unit_number}`,
    ip: req.ip,
  });

  return res.status(201).json({
    success: true,
    message: "Invite code created successfully",
    id,
    code,
  });
});

// ============================================================
// revokeCode
// DELETE /api/invite-codes/:id
// Only active codes can be revoked
// ============================================================
const revokeCode = asyncHandler(async (req, res) => {
  const landlordId = req.user.id;
  const codeId = parseId(req.params.id);

  if (!codeId) throw new AppError("Invalid invite code ID", 400);

  await InviteCode.revoke(codeId, landlordId);

  await logActivity({
    userId: landlordId,
    action: "invite_code_revoked",
    description: `Revoked invite code ID ${codeId}`,
    ip: req.ip,
  });

  return res.json({
    success: true,
    message: "Invite code revoked successfully",
  });
});

module.exports = { listCodes, createCode, revokeCode };
