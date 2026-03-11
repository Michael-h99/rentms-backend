// models/userModel.js
// ============================================================
// The only model that uses a class constructor because
// verifyPassword() needs access to this.password_hash.
//
// Schema (rentms_full_schema.sql — Section 1):
//   users.role   : ENUM('landlord','tenant','admin')
//   users.status : ENUM('active','suspended','blacklisted')
//   users.full_name  : VARCHAR(150) NULL
//   users.address    : VARCHAR(255) NULL
//   users.avatar_url : VARCHAR(500) NULL
//   users.deleted_at : DATETIME NULL  (soft-delete)
//
// IMPORTANT: Always call toSafeObject() before returning a User
// to a controller — never expose password_hash to clients.
//
// Methods:
//   User.hashPassword(password)
//   user.verifyPassword(password)          ← instance
//   user.toSafeObject()                    ← instance — strips password_hash
//   User.create({ username, email, phone, full_name, password, role })
//   User.findById(id, includePassword?)
//   User.findByEmail(email, includePassword?)
//   User.findByUsername(username)
//   User.update(userId, fields)
//   User.updateRole(userId, role)
//   User.updateStatus(userId, status)
//   User.updatePassword(userId, newPassword)
//   User.softDelete(userId)
//   User.listAll({ page, limit, role, status, search })
// ============================================================

const bcrypt = require("bcryptjs");
const db = require("../utils/db");

// Schema-aligned constants — do NOT use constants.js which has
// super_admin (not in schema) and inactive (not in schema)
const VALID_ROLES = ["landlord", "tenant", "admin"];
const VALID_STATUSES = ["active", "suspended", "blacklisted"];

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_LIMIT = 20;
const BCRYPT_ROUNDS = 12;

// Safe columns — never includes password_hash
const SAFE_COLS = `
  id, username, full_name, email, phone, address, avatar_url,
  role, status, deleted_at, created_at, updated_at
`.trim();

// Auth columns — includes password_hash, used only in login/change-password flows
const AUTH_COLS = `${SAFE_COLS}, password_hash`;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};
const isValidEmail = (e) =>
  typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

class User {
  constructor(data) {
    this.id = data.id ?? null;
    this.username = data.username;
    this.full_name = data.full_name ?? null;
    this.email = data.email;
    this.phone = data.phone ?? null;
    this.address = data.address ?? null;
    this.avatar_url = data.avatar_url ?? null;
    this.password_hash = data.password_hash ?? null;
    this.role = data.role ?? "tenant";
    this.status = data.status ?? "active";
    this.deleted_at = data.deleted_at ?? null;
    this.created_at = data.created_at ?? new Date();
    this.updated_at = data.updated_at ?? new Date();
  }

  // ── Instance: safe API response object ─────────────────────
  // Always call this before res.json() — strips password_hash.
  toSafeObject() {
    return {
      id: this.id,
      username: this.username,
      full_name: this.full_name,
      email: this.email,
      phone: this.phone,
      address: this.address,
      avatar_url: this.avatar_url,
      role: this.role,
      status: this.status,
      created_at: this.created_at,
      updated_at: this.updated_at,
      // password_hash intentionally excluded
    };
  }

  // ── Instance: verify password against stored hash ──────────
  async verifyPassword(password) {
    if (!this.password_hash)
      throw new Error("No password hash stored for this user");
    return bcrypt.compare(password, this.password_hash);
  }

  // ── Static: hash a plain-text password ─────────────────────
  static async hashPassword(password) {
    if (!password || typeof password !== "string") {
      throw new Error("Password must be a non-empty string");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  // ════════════════════════════════════════════════════════════
  // User.create
  // Returns the new user's insertId.
  // Duplicate email check is done in the controller transaction
  // before calling create() — this performs a second guard.
  // ════════════════════════════════════════════════════════════
  static async create({
    username,
    email,
    phone,
    full_name,
    address,
    password,
    role,
  }) {
    if (!username?.trim()) throw new Error("username is required");
    if (!isValidEmail(email))
      throw new Error("A valid email address is required");
    if (!password) throw new Error("password is required");

    const resolvedRole = role || "tenant";
    if (!VALID_ROLES.includes(resolvedRole)) {
      throw new Error(`Invalid role. Must be: ${VALID_ROLES.join(", ")}`);
    }

    const [[existing]] = await db.execute(
      `SELECT id FROM users WHERE email = ? LIMIT 1`,
      [email.trim().toLowerCase()],
    );
    if (existing) throw new Error("An account with this email already exists");

    const hashedPassword = await User.hashPassword(password);

    const [result] = await db.execute(
      `INSERT INTO users
         (username, full_name, email, phone, address, password_hash,
          role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
      [
        username.trim(),
        full_name?.trim() || null,
        email.trim().toLowerCase(),
        phone?.trim() || null,
        address?.trim() || null,
        hashedPassword,
        resolvedRole,
      ],
    );

    return result.insertId;
  }

  // ════════════════════════════════════════════════════════════
  // User.findById
  // includePassword: true only for auth flows (login, change-password).
  // Excludes soft-deleted users unless caller handles deleted_at.
  // ════════════════════════════════════════════════════════════
  static async findById(id, includePassword = false) {
    const userId = parseId(id);
    if (!userId) throw new Error("Invalid user ID");

    const cols = includePassword ? AUTH_COLS : SAFE_COLS;
    const [rows] = await db.execute(
      `SELECT ${cols} FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [userId],
    );

    return rows.length ? new User(rows[0]) : null;
  }

  // ════════════════════════════════════════════════════════════
  // User.findByEmail
  // includePassword: true only for login.
  // ════════════════════════════════════════════════════════════
  static async findByEmail(email, includePassword = false) {
    if (!isValidEmail(email)) throw new Error("Invalid email format");

    const cols = includePassword ? AUTH_COLS : SAFE_COLS;
    const [rows] = await db.execute(
      `SELECT ${cols} FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
      [email.trim().toLowerCase()],
    );

    return rows.length ? new User(rows[0]) : null;
  }

  // ════════════════════════════════════════════════════════════
  // User.findByUsername
  // ════════════════════════════════════════════════════════════
  static async findByUsername(username) {
    if (!username?.trim())
      throw new Error("username must be a non-empty string");

    const [rows] = await db.execute(
      `SELECT ${SAFE_COLS} FROM users
       WHERE username = ? AND deleted_at IS NULL LIMIT 1`,
      [username.trim()],
    );

    return rows.length ? new User(rows[0]) : null;
  }

  // ════════════════════════════════════════════════════════════
  // User.update
  // Allowed fields: username, full_name, email, phone, address, avatar_url
  // Role and status have dedicated methods with extra guards.
  // ════════════════════════════════════════════════════════════
  static async update(userId, fields = {}) {
    const uid = parseId(userId);
    if (!uid) throw new Error("Invalid user ID");

    const ALLOWED = [
      "username",
      "full_name",
      "email",
      "phone",
      "address",
      "avatar_url",
    ];
    const updates = {};

    for (const key of ALLOWED) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (!Object.keys(updates).length)
      throw new Error("No valid update fields provided");

    // Field-level validation
    if (updates.username !== undefined) {
      if (!updates.username?.trim())
        throw new Error("username must be a non-empty string");
      updates.username = updates.username.trim();
    }
    if (updates.email !== undefined) {
      if (!isValidEmail(updates.email))
        throw new Error("A valid email address is required");
      updates.email = updates.email.trim().toLowerCase();
      const [[taken]] = await db.execute(
        `SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1`,
        [updates.email, uid],
      );
      if (taken)
        throw new Error("This email is already in use by another account");
    }

    // Trim nullable strings
    for (const key of ["full_name", "phone", "address", "avatar_url"]) {
      if (updates[key] !== undefined)
        updates[key] = updates[key]?.trim() || null;
    }

    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const params = [...Object.values(updates), uid];

    const [result] = await db.execute(
      `UPDATE users SET ${setClauses}, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      params,
    );
    if (!result.affectedRows) throw new Error("User not found");
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // User.updateRole
  // ════════════════════════════════════════════════════════════
  static async updateRole(userId, role) {
    const uid = parseId(userId);
    if (!uid) throw new Error("Invalid user ID");
    if (!VALID_ROLES.includes(role)) {
      throw new Error(`Invalid role. Must be: ${VALID_ROLES.join(", ")}`);
    }

    const [result] = await db.execute(
      `UPDATE users SET role = ?, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [role, uid],
    );
    if (!result.affectedRows) throw new Error("User not found");
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // User.updateStatus
  // Schema ENUM: 'active' | 'suspended' | 'blacklisted'
  // ════════════════════════════════════════════════════════════
  static async updateStatus(userId, status) {
    const uid = parseId(userId);
    if (!uid) throw new Error("Invalid user ID");
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be: ${VALID_STATUSES.join(", ")}`);
    }

    const [result] = await db.execute(
      `UPDATE users SET status = ?, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [status, uid],
    );
    if (!result.affectedRows) throw new Error("User not found");
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // User.updatePassword
  // ════════════════════════════════════════════════════════════
  static async updatePassword(userId, newPassword) {
    const uid = parseId(userId);
    if (!uid) throw new Error("Invalid user ID");

    const hashed = await User.hashPassword(newPassword);
    const [result] = await db.execute(
      `UPDATE users SET password_hash = ?, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [hashed, uid],
    );
    if (!result.affectedRows) throw new Error("User not found");
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // User.softDelete
  // Sets deleted_at = NOW() and clears refresh_token.
  // Hard DELETE is not used — see adminController.deleteUser.
  // ════════════════════════════════════════════════════════════
  static async softDelete(userId) {
    const uid = parseId(userId);
    if (!uid) throw new Error("Invalid user ID");

    const [result] = await db.execute(
      `UPDATE users
       SET deleted_at = NOW(), refresh_token = NULL, updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [uid],
    );
    if (!result.affectedRows)
      throw new Error("User not found or already deleted");
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // User.listAll — admin only, paginated + filterable
  // Never returns password_hash.
  // Search covers username, email, and full_name.
  // ════════════════════════════════════════════════════════════
  static async listAll({
    page = 1,
    limit = DEFAULT_LIMIT,
    role,
    status,
    search,
  } = {}) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, limit);
    const offset = (safePage - 1) * safeLimit;

    if (role && !VALID_ROLES.includes(role)) {
      throw new Error(
        `Invalid role filter. Must be: ${VALID_ROLES.join(", ")}`,
      );
    }
    if (status && !VALID_STATUSES.includes(status)) {
      throw new Error(
        `Invalid status filter. Must be: ${VALID_STATUSES.join(", ")}`,
      );
    }

    const conditions = ["deleted_at IS NULL"];
    const params = [];

    if (role) {
      conditions.push("role = ?");
      params.push(role);
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (search) {
      conditions.push("(username LIKE ? OR email LIKE ? OR full_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const WHERE = `WHERE ${conditions.join(" AND ")}`;

    const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM users ${WHERE}`,
      params,
    );

    const [rows] = await db.query(
    `SELECT ${SAFE_COLS} FROM users
       ${WHERE}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );

    return {
      data: rows, // plain objects — no User instances, no password_hash
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        total_pages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }
}

module.exports = User;
