// generateId.js
const crypto = require("crypto");

// ── generateId ───────────────────────────────────────────────
// Generate a unique random alphanumeric ID.
// Uses crypto.randomBytes for cryptographic randomness.
//
// @param {string} prefix  — Optional prefix e.g. "PMT", "RCT", "INV"
// @param {number} length  — Number of random hex characters (default 8)
// @returns {string}       — e.g. "PMT-1A2B3C4D" or "1A2B3C4D"
const generateId = (prefix = "", length = 8) => {
  if (typeof prefix !== "string") {
    throw new Error("prefix must be a string");
  }
  if (!Number.isInteger(length) || length < 4 || length > 32) {
    throw new Error("length must be an integer between 4 and 32");
  }

  const id = crypto
    .randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length)
    .toUpperCase();

  return prefix ? `${prefix}-${id}` : id;
};

// ── generateReceiptNumber ────────────────────────────────────
// Format: RCT-<timestamp>-<random>
// Matches receipts.receipt_number in schema (VARCHAR 50, UNIQUE)
const generateReceiptNumber = () => {
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `RCT-${Date.now()}-${random}`;
};

// ── generateReference ────────────────────────────────────────
// Format: PMT-<timestamp>-<random>
// Matches payments.reference in schema (VARCHAR 100, UNIQUE)
const generateReference = () => {
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `PMT-${Date.now()}-${random}`;
};

// ── generateInviteCode ───────────────────────────────────────
// Format: 8 uppercase hex chars e.g. "A1B2C3D4"
// Matches invite_codes.code in schema (VARCHAR 20, UNIQUE)
// 8 chars = 4 bytes = ~4 billion combinations
const generateInviteCode = () =>
  crypto.randomBytes(4).toString("hex").toUpperCase();

// ── generateTransactionId ────────────────────────────────────
// Format: TXN-<timestamp>-<random>
// Matches payments.transaction_id in schema (VARCHAR 150)
const generateTransactionId = () => {
  const random = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `TXN-${Date.now()}-${random}`;
};

// ── generateResetToken ───────────────────────────────────────
// Format: 64 hex chars (32 bytes)
// Matches users.reset_token in schema (VARCHAR 255)
// Long enough to be unguessable, stored hashed in DB
const generateResetToken = () => crypto.randomBytes(32).toString("hex");

// ── generateSecureCode ───────────────────────────────────────
// Generic secure code for OTPs, verification tokens, etc.
// @param {number} byteLength — default 16 (32 hex chars)
const generateSecureCode = (byteLength = 16) =>
  crypto.randomBytes(byteLength).toString("hex").toUpperCase();

// ── isValidReference ─────────────────────────────────────────
// Check if a string matches the PMT/RCT/TXN reference format.
// Useful for validating incoming payment references.
const isValidReference = (ref) => {
  if (!ref || typeof ref !== "string") return false;
  return /^(PMT|RCT|TXN|INV)-\d+-[A-F0-9]+$/.test(ref);
};

module.exports = {
  generateId,
  generateReceiptNumber,
  generateReference,
  generateTransactionId,
  generateInviteCode,
  generateResetToken,
  generateSecureCode,
  isValidReference,
};
