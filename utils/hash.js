// hash.js
const bcrypt = require("bcryptjs"); // bcryptjs — no native build tools needed

const SALT_ROUNDS = 12; // Matches seedData.js and userModel.js standard

// ── hashPassword ─────────────────────────────────────────────
// Hash a plain text password.
// Validates input before hashing to prevent empty string hashes.
const hashPassword = async (password) => {
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  try {
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    return await bcrypt.hash(password, salt);
  } catch (err) {
    throw new Error(`Failed to hash password: ${err.message}`);
  }
};

// ── comparePassword ──────────────────────────────────────────
// Compare a plain password against a stored hash.
// Returns false for wrong passwords — only throws on actual errors.
const comparePassword = async (password, hashedPassword) => {
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string");
  }
  if (!hashedPassword || typeof hashedPassword !== "string") {
    throw new Error("Hashed password must be a non-empty string");
  }
  try {
    return await bcrypt.compare(password, hashedPassword);
  } catch (err) {
    throw new Error(`Failed to compare password: ${err.message}`);
  }
};

// ── isHashed ─────────────────────────────────────────────────
// Check if a string already looks like a bcrypt hash.
// Prevents double-hashing if a hash is accidentally passed in.
const isHashed = (value) => {
  return (
    typeof value === "string" && value.startsWith("$2") && value.length >= 59
  );
};

// ── hashIfPlain ──────────────────────────────────────────────
// Hash only if the value is not already hashed.
// Safe to call even if value might already be a hash.
const hashIfPlain = async (value) => {
  if (isHashed(value)) return value;
  return await hashPassword(value);
};

module.exports = {
  hashPassword,
  comparePassword,
  isHashed,
  hashIfPlain,
  SALT_ROUNDS,
};
