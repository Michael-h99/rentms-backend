// middleware/authMiddleware.js
// ============================================================
// Verifies JWT access token, validates the payload, confirms
// the user still exists and is active in the DB, then attaches
// a safe, controlled req.user object for downstream middleware.
//
// Schema (rentms_full_schema.sql — Section 1):
//   users.status   : ENUM('active','suspended','blacklisted')
//   users.deleted_at : DATETIME NULL  (soft-delete)
//
// JWT payload (from jwt.js generateToken):
//   { id, role, email?, username? }
//
// req.user attached on success:
//   { id, role, email, username }
// ============================================================

const { verifyToken, extractTokenFromHeader } = require("../utils/jwt");
const db = require("../utils/db");

const VALID_ROLES = ["tenant", "landlord", "admin"];

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

const authMiddleware = async (req, res, next) => {
  try {
    // ── 1. Extract Bearer token from Authorization header ─────
    const token = extractTokenFromHeader(req.headers.authorization);
    if (!token) {
      return res.status(401).json({
        success: false,
        message:
          "Authorization header missing or invalid format. Expected: Bearer <token>",
      });
    }

    // ── 2. Verify and decode ──────────────────────────────────
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (tokenErr) {
      console.warn(
        `[AUTH] Token verification failed — IP: ${req.ip}, error: ${tokenErr.name}`,
      );
      const message =
        tokenErr.name === "TokenExpiredError"
          ? "Your session has expired. Please log in again."
          : tokenErr.name === "JsonWebTokenError"
            ? "Invalid token. Please log in again."
            : tokenErr.name === "NotBeforeError"
              ? "Token not yet valid. Please log in again."
              : "Authentication failed. Please log in again.";
      return res.status(401).json({ success: false, message });
    }

    // ── 3. Validate required payload fields ───────────────────
    const userId = parseId(decoded.id);
    if (!userId) {
      console.warn(`[AUTH] Invalid user ID in token payload — IP: ${req.ip}`);
      return res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
    }

    if (!decoded.role || !VALID_ROLES.includes(decoded.role)) {
      console.warn(
        `[AUTH] Unrecognised role "${decoded.role}" in token — IP: ${req.ip}`,
      );
      return res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
    }

    // ── 4. Confirm user still exists, is not deleted, is active ─
    const [[dbUser]] = await db.execute(
      `SELECT id, role, status
       FROM users
       WHERE id = ? AND deleted_at IS NULL`,
      [userId],
    );

    if (!dbUser) {
      console.warn(
        `[AUTH] Token references non-existent or deleted user ${userId} — IP: ${req.ip}`,
      );
      return res.status(401).json({
        success: false,
        message: "Account not found. Please log in again.",
      });
    }

    if (dbUser.status !== "active") {
      console.warn(
        `[AUTH] Access denied — user ${userId} status: "${dbUser.status}" — IP: ${req.ip}`,
      );
      return res.status(403).json({
        success: false,
        message:
          dbUser.status === "blacklisted"
            ? "Your account has been permanently suspended. Please contact support."
            : "Your account is suspended. Please contact support.",
      });
    }

    // ── 5. Attach safe user object to request ─────────────────
    req.user = {
      id: userId,
      role: dbUser.role,
      email: decoded.email ?? null,
      username: decoded.username ?? null,
    };

    next();
  } catch (err) {
    console.error(`[AUTH] Unexpected middleware error — IP: ${req.ip}`, err);
    return res.status(500).json({
      success: false,
      message: "Authentication error. Please try again.",
    });
  }
};

module.exports = authMiddleware;
