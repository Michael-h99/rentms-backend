// models/inviteCodeModel.js
// ============================================================
// Full CRUD model for the invite_codes table.
//
// Schema (rentms_full_schema.sql — Section 3):
//   invite_codes.code        : VARCHAR(20) UNIQUE  e.g. "AH-K7R2"
//   invite_codes.status      : ENUM('active','used','expired','revoked')
//   invite_codes.used_count  : TINYINT (incremented on each claim)
//   invite_codes.max_uses    : TINYINT DEFAULT 1
//   invite_codes.claimed_by  : INT NULL (user_id of last claimer)
//   invite_codes.expires_at  : DATETIME NOT NULL
//   invite_codes.lease_start : DATE NULL
//   invite_codes.lease_end   : DATE NULL
//
// Used by:
//   controllers/inviteCodeController.js  — landlord CRUD endpoints
//   controllers/authController.js        — tenant registration flow
// ============================================================

const db        = require("../utils/db");
const { AppError } = require("../utils/errorhandler");

// ── Helpers ──────────────────────────────────────────────────

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// Code format: "<PLAZA_PREFIX>-<4 RANDOM CHARS>"
// e.g. "AKP-J3T7"
// Omits I, O, 0, 1 to avoid misreading
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const generateCode = (plazaName = "") => {
  // Take first letter of each word in plaza name, max 3, uppercase
  const prefix = plazaName
    .split(/\s+/)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase()
    .slice(0, 3)
    .replace(/[^A-Z]/g, "X") || "RMS";

  const suffix = Array.from(
    { length: 4 },
    () => CHARS[Math.floor(Math.random() * CHARS.length)],
  ).join("");

  return `${prefix}-${suffix}`;
};

// ── Shared JOIN fragment ──────────────────────────────────────
// Used in findByCode, validate, listByLandlord
const BASE_SELECT = `
  SELECT
    ic.*,
    p.name        AS plaza_name,
    p.location    AS plaza_location,
    ul.full_name  AS landlord_name,
    ul.email      AS landlord_email,
    uc.full_name  AS claimed_by_name
  FROM invite_codes ic
  JOIN   plazas p  ON p.id  = ic.plaza_id
  JOIN   users  ul ON ul.id = ic.landlord_id
  LEFT JOIN users uc ON uc.id = ic.claimed_by
`;

// ── InviteCode model ─────────────────────────────────────────

const InviteCode = {

  // ── generateUniqueCode ──────────────────────────────────────
  // Retries up to 10 times to find a code not already in the DB.
  async generateUniqueCode(plazaName) {
    for (let i = 0; i < 10; i++) {
      const code = generateCode(plazaName);
      const [rows] = await db.execute(
        "SELECT id FROM invite_codes WHERE code = ? LIMIT 1",
        [code],
      );
      if (!rows.length) return code;
    }
    throw new AppError(
      "Could not generate a unique invite code. Please try again.",
      500,
    );
  },

  // ── create ─────────────────────────────────────────────────
  // Called by inviteCodeController when landlord generates a code.
  // Returns { id, code }.
  //
  // Params:
  //   landlordId  : number  (required)
  //   plazaId     : number  (required)
  //   plazaName   : string  (used to build readable code prefix)
  //   unitNumber  : string  (required — maps to tenancies.unit_number)
  //   rentAmount  : number  (required — maps to tenancies.rent_amount)
  //   maxUses     : number  (default 1)
  //   leaseStart  : string  DATE "YYYY-MM-DD" or null
  //   leaseEnd    : string  DATE "YYYY-MM-DD" or null
  //   expiresAt   : string  DATETIME (required)
  async create({
    landlordId,
    plazaId,
    plazaName,
    unitNumber,
    rentAmount,
    maxUses = 1,
    leaseStart = null,
    leaseEnd = null,
    expiresAt,
  }) {
    const lid = parseId(landlordId);
    const pid = parseId(plazaId);

    if (!lid)        throw new AppError("Invalid landlord ID", 400);
    if (!pid)        throw new AppError("Invalid plaza ID", 400);
    if (!unitNumber) throw new AppError("unit_number is required", 400);
    if (!rentAmount || isNaN(parseFloat(rentAmount)))
      throw new AppError("Valid rent_amount is required", 400);
    if (!expiresAt)  throw new AppError("expires_at is required", 400);

    const parsedMax = Math.max(1, parseInt(maxUses, 10) || 1);
    const code      = await this.generateUniqueCode(plazaName);

    const [result] = await db.execute(
      `INSERT INTO invite_codes
         (code, landlord_id, plaza_id, unit_number, rent_amount,
          max_uses, used_count, lease_start, lease_end,
          status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, NOW(), NOW())`,
      [
        code, lid, pid, unitNumber, parseFloat(rentAmount),
        parsedMax, leaseStart, leaseEnd, expiresAt,
      ],
    );

    return { id: result.insertId, code };
  },

  // ── findById ───────────────────────────────────────────────
  // Returns full row + joins, or null.
  async findById(id) {
    const codeId = parseId(id);
    if (!codeId) return null;

    const [rows] = await db.execute(
      `${BASE_SELECT} WHERE ic.id = ? LIMIT 1`,
      [codeId],
    );
    return rows[0] || null;
  },

  // ── findByCode ─────────────────────────────────────────────
  // Returns full row + joins, or null. Does NOT validate status.
  async findByCode(code) {
    if (!code) return null;

    const [rows] = await db.execute(
      `${BASE_SELECT} WHERE ic.code = ? LIMIT 1`,
      [code.trim().toUpperCase()],
    );
    return rows[0] || null;
  },

  // ── validate ──────────────────────────────────────────────
  // Called during tenant registration (authController).
  // Throws AppError with a user-facing reason if the code is invalid.
  // Returns the full invite code row on success.
  async validate(code) {
    if (!code || typeof code !== "string") {
      throw new AppError("Invite code is required", 400);
    }

    const ic = await this.findByCode(code);

    if (!ic) {
      throw new AppError(
        "This invite code doesn't exist. Please check and try again.",
        400,
      );
    }

    if (ic.status === "revoked") {
      throw new AppError(
        "This invite code has been revoked by the landlord.",
        400,
      );
    }

    if (ic.status === "used" || ic.used_count >= ic.max_uses) {
      throw new AppError(
        "This invite code has already been fully used.",
        400,
      );
    }

    // Check expiry by both status column and expires_at timestamp
    if (ic.status === "expired" || new Date(ic.expires_at) < new Date()) {
      throw new AppError(
        "This invite code has expired. Please ask your landlord for a new one.",
        400,
      );
    }

    return ic;
  },

  // ── markUsed ──────────────────────────────────────────────
  // Called inside a DB transaction during tenant registration.
  // Increments used_count, records claimed_by, flips status to
  // 'used' once max_uses is reached.
  //
  // Pass conn (transaction connection) from authController —
  // falls back to db pool for standalone calls.
  async markUsed(code, tenantId, conn = db) {
    const tid   = parseId(tenantId);
    const clean = code.trim().toUpperCase();

    if (!tid) throw new AppError("Invalid tenant ID", 400);

    // Fetch current counts inside the transaction to avoid race conditions
    const [rows] = await conn.execute(
      `SELECT id, used_count, max_uses FROM invite_codes WHERE code = ? LIMIT 1`,
      [clean],
    );

    if (!rows.length) throw new AppError("Invite code not found", 404);

    const { id, used_count, max_uses } = rows[0];
    const newCount  = used_count + 1;
    const newStatus = newCount >= max_uses ? "used" : "active";

    await conn.execute(
      `UPDATE invite_codes
       SET used_count = ?,
           claimed_by = ?,
           status     = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [newCount, tid, newStatus, id],
    );
  },

  // ── listByLandlord ────────────────────────────────────────
  // Paginated list of codes for a landlord.
  // Auto-expires any active codes whose expires_at has passed.
  // Filters: status, plazaId, page, limit
  async listByLandlord(
    landlordId,
    { status, plazaId, page = 1, limit = 20 } = {},
  ) {
    const lid = parseId(landlordId);
    if (!lid) throw new AppError("Invalid landlord ID", 400);

    // Auto-expire stale codes for this landlord
    await db.execute(
      `UPDATE invite_codes
       SET status = 'expired', updated_at = NOW()
       WHERE landlord_id = ? AND status = 'active' AND expires_at < NOW()`,
      [lid],
    );

    const conditions = ["ic.landlord_id = ?"];
    const params     = [lid];

    if (status) {
      if (!["active", "used", "expired", "revoked"].includes(status)) {
        throw new AppError(
          "Invalid status. Must be: active, used, expired, or revoked",
          400,
        );
      }
      conditions.push("ic.status = ?");
      params.push(status);
    }

    if (plazaId) {
      const pid = parseId(plazaId);
      if (!pid) throw new AppError("Invalid plaza_id", 400);
      conditions.push("ic.plaza_id = ?");
      params.push(pid);
    }

    const safePage  = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, parseInt(limit, 10) || 20);
    const offset    = (safePage - 1) * safeLimit;
    const WHERE     = conditions.join(" AND ");

    const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM invite_codes ic WHERE ${WHERE}`,
      params,
    );

    const [rows] = await db.query(
    `${BASE_SELECT}
       WHERE ${WHERE}
       ORDER BY ic.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return {
      data        : rows,
      total,
      page        : safePage,
      limit       : safeLimit,
      total_pages : Math.ceil(total / safeLimit) || 1,
    };
  },

  // ── revoke ────────────────────────────────────────────────
  // Landlord revokes an active code. Only 'active' codes can be revoked.
  // Throws AppError if not found or already used/expired/revoked.
  async revoke(id, landlordId) {
    const codeId = parseId(id);
    const lid    = parseId(landlordId);

    if (!codeId || !lid) throw new AppError("Invalid ID", 400);

    const [result] = await db.execute(
      `UPDATE invite_codes
       SET status = 'revoked', updated_at = NOW()
       WHERE id = ? AND landlord_id = ? AND status = 'active'`,
      [codeId, lid],
    );

    if (!result.affectedRows) {
      throw new AppError(
        "Code not found, not yours, or already used/expired/revoked.",
        404,
      );
    }

    return true;
  },

  // ── getStats ──────────────────────────────────────────────
  // Summary counts by status for a landlord's dashboard.
  async getStats(landlordId) {
    const lid = parseId(landlordId);
    if (!lid) throw new AppError("Invalid landlord ID", 400);

    const [[stats]] = await db.execute(
      `SELECT
         COUNT(*)                              AS total,
         SUM(status = 'active')               AS active,
         SUM(status = 'used')                 AS used,
         SUM(status = 'expired')              AS expired,
         SUM(status = 'revoked')              AS revoked,
         SUM(status = 'active'
             AND expires_at < DATE_ADD(NOW(), INTERVAL 7 DAY)
             AND expires_at > NOW())          AS expiring_soon
       FROM invite_codes
       WHERE landlord_id = ?`,
      [lid],
    );

    return stats;
  },
};

module.exports = InviteCode;