// utils/jwt.js
// ============================================================
// JWT utility — generate, verify, decode, and extract tokens.
//
// Access token  : short-lived (JWT_EXPIRES_IN, default 1d)
// Refresh token : long-lived  (JWT_REFRESH_EXPIRES_IN, default 7d)
//
// Used by:
//   middleware/authMiddleware.js  — verifyToken, extractTokenFromHeader
//   controllers/authController.js — generateToken, generateRefreshToken,
//                                   verifyRefreshToken
// ============================================================

require("dotenv").config();
const jwt = require("jsonwebtoken");

// ── Constants ────────────────────────────────────────────────
const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRES_IN || "1d";
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRES_IN || "7d";

// ── Guard — fail fast if secrets are missing ─────────────────
if (!process.env.JWT_SECRET) {
  throw new Error("FATAL: JWT_SECRET is not set in environment variables");
}
if (!process.env.JWT_REFRESH_SECRET) {
  throw new Error(
    "FATAL: JWT_REFRESH_SECRET is not set in environment variables",
  );
}

// ── Valid roles — must match schema ENUM ─────────────────────
const VALID_ROLES = ["tenant", "landlord", "admin"];

// ── generateToken ────────────────────────────────────────────
// Sign an access token.
// Payload must include id (numeric) and role at minimum.
//
// Usage:
//   const token = generateToken({ id: user.id, role: user.role });
const generateToken = (payload, expiresIn = ACCESS_TOKEN_EXPIRY) => {
  if (!payload || typeof payload !== "object") {
    throw new Error("JWT payload must be a non-null object");
  }

  const id = parseInt(payload.id, 10);
  if (!id || id <= 0) {
    throw new Error("JWT payload must include a valid numeric id");
  }

  if (!payload.role || !VALID_ROLES.includes(payload.role)) {
    throw new Error(
      `JWT payload role must be one of: ${VALID_ROLES.join(", ")}`,
    );
  }

  return jwt.sign(
    {
      id,
      role: payload.role,
      ...(payload.email && { email: payload.email }),
      ...(payload.username && { username: payload.username }),
    },
    process.env.JWT_SECRET,
    { expiresIn },
  );
};

// ── generateRefreshToken ─────────────────────────────────────
// Sign a long-lived refresh token using a separate secret.
// Only stores id — role re-fetched from DB on refresh.
//
// Usage:
//   const refreshToken = generateRefreshToken({ id: user.id });
const generateRefreshToken = (payload) => {
  const id = parseInt(payload?.id, 10);
  if (!id || id <= 0) {
    throw new Error("Refresh token payload must include a valid numeric id");
  }

  return jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
};

// ── verifyToken ──────────────────────────────────────────────
// Verify and decode an access token.
// Throws named JWT errors (TokenExpiredError, JsonWebTokenError)
// so authMiddleware can return specific messages.
//
// Usage:
//   const decoded = verifyToken(token); // { id, role, ... }
const verifyToken = (token) => {
  if (!token || typeof token !== "string") {
    throw new Error("Token must be a non-empty string");
  }
  return jwt.verify(token, process.env.JWT_SECRET);
};

// ── verifyRefreshToken ───────────────────────────────────────
// Verify a refresh token.
// Used in POST /api/auth/refresh.
const verifyRefreshToken = (token) => {
  if (!token || typeof token !== "string") {
    throw new Error("Refresh token must be a non-empty string");
  }
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
};

// ── decodeToken ──────────────────────────────────────────────
// Decode WITHOUT verifying signature.
// ONLY use for non-security-sensitive reads (e.g. logging).
// NEVER use for auth decisions.
const decodeToken = (token) => {
  if (!token || typeof token !== "string") {
    throw new Error("Token must be a non-empty string");
  }
  const decoded = jwt.decode(token);
  if (!decoded) throw new Error("Token could not be decoded — malformed JWT");
  return decoded;
};

// ── isTokenExpired ───────────────────────────────────────────
// Check if a token is expired without throwing.
// Useful for silent refresh checks on the frontend.
const isTokenExpired = (token) => {
  try {
    const decoded = decodeToken(token);
    if (!decoded?.exp) return true;
    return Date.now() >= decoded.exp * 1000;
  } catch {
    return true;
  }
};

// ── extractTokenFromHeader ───────────────────────────────────
// Pull Bearer token from Authorization header.
// Returns null if header is missing or malformed.
//
// Usage (in middleware):
//   const token = extractTokenFromHeader(req.headers.authorization);
const extractTokenFromHeader = (authHeader) => {
  if (!authHeader || typeof authHeader !== "string") return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1] || null;
};

// ── getTokenPayload ──────────────────────────────────────────
// Safely verify and return payload, or null on any error.
// Useful for optional auth routes.
const getTokenPayload = (token) => {
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
};

module.exports = {
  generateToken,
  generateRefreshToken,
  verifyToken,
  verifyRefreshToken,
  decodeToken,
  isTokenExpired,
  extractTokenFromHeader,
  getTokenPayload,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
};
