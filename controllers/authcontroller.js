// controllers/authController.js
// ============================================================
// Handles: register (with invite code), login, logout, refresh,
//          forgot/reset password, change password,
//          get current user, update profile, upload avatar.
//
// Schema (rentms_full_schema.sql — Section 1):
//   users.full_name         : VARCHAR(150) NULL
//   users.avatar_url        : VARCHAR(500) NULL
//   users.refresh_token     : VARCHAR(600) NULL
//   users.reset_token       : VARCHAR(255) NULL
//   users.reset_token_expiry: DATETIME NULL
//   users.status            : ENUM('active','suspended','blacklisted')
//
// Import path from routes:
//   require("../controllers/authController")
// ============================================================

const crypto = require("crypto");
const db = require("../utils/db");
const User = require("../models/userModel");
const InviteCode = require("../models/invitecodeModel");
const jwt = require("jsonwebtoken");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");

const ACCESS_TOKEN_EXPIRY = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRES || "7d";
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// ── Token helpers ─────────────────────────────────────────────
const signAccess = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
const signRefresh = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });

// ── Password strength ─────────────────────────────────────────
// Min 8 chars, at least one letter and one number
const isStrongPassword = (p) => /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(p);

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/register
// Landlord: username, email, password, role = "landlord"
// Tenant:   same fields + invite_code (REQUIRED)
//           → validates invite, creates user, creates tenancy,
//             marks invite used — all in one transaction.
// ═══════════════════════════════════════════════════════════════
const register = asyncHandler(async (req, res) => {
  const { username, email, phone, full_name, password, role, invite_code } =
    req.body;

  if (!username?.trim() || !email?.trim() || !password || !role) {
    throw new AppError("username, email, password, and role are required", 400);
  }
  if (!["landlord", "tenant"].includes(role)) {
    throw new AppError("role must be 'landlord' or 'tenant'", 400);
  }
  if (!isStrongPassword(password)) {
    throw new AppError(
      "Password must be at least 8 characters and contain at least one letter and one number",
      400,
    );
  }
  if (role === "tenant" && !invite_code?.trim()) {
    throw new AppError(
      "An invite code is required to register as a tenant",
      400,
    );
  }

  // Validate invite code early (fail fast before writing anything)
  let ic = null;
  if (role === "tenant") {
    ic = await InviteCode.validate(invite_code.trim().toUpperCase());
    // InviteCode.validate throws AppError if invalid/expired/used
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Duplicate checks
    const [[emailExists]] = await conn.execute(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email.trim().toLowerCase()],
    );
    if (emailExists)
      throw new AppError("An account with this email already exists", 409);

    const [[usernameExists]] = await conn.execute(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [username.trim()],
    );
    if (usernameExists)
      throw new AppError("This username is already taken", 409);

    // Create user
    const userId = await User.create({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      phone: phone?.trim() || null,
      full_name: full_name?.trim() || null,
      password,
      role,
    });

    // Tenant invite flow
    let tenancyInfo = null;
    if (role === "tenant" && ic) {
      await conn.execute(
        `UPDATE invite_codes
         SET used_count = used_count + 1,
             claimed_by = ?,
             status     = IF(used_count + 1 >= max_uses, 'used', status),
             updated_at = NOW()
         WHERE id = ?`,
        [userId, ic.id],
      );

      const [tenancyResult] = await conn.execute(
        `INSERT INTO tenancies
           (tenant_id, plaza_id, invite_code_id, unit_number, rent_amount,
            lease_start, lease_end, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
        [
          userId,
          ic.plaza_id,
          ic.id,
          ic.unit_number,
          ic.rent_amount,
          ic.lease_start || null,
          ic.lease_end || null,
        ],
      );

      tenancyInfo = {
        tenancy_id: tenancyResult.insertId,
        plaza_name: ic.plaza_name,
        unit_number: ic.unit_number,
        rent_amount: ic.rent_amount,
        landlord: ic.landlord_name,
        lease_start: ic.lease_start,
        lease_end: ic.lease_end,
      };

      // Notify landlord — non-fatal, fire outside transaction
      await conn.commit();
      conn.release();

      await NotificationService.create({
        recipientId: ic.landlord_id,
        senderId: userId,
        type: "new_tenant",
        message: `${username.trim()} joined ${ic.plaza_name}, Unit ${ic.unit_number} via invite code.`,
        io: null, // no req.app here — landlord sees it on next load
      });
    } else {
      await conn.commit();
      conn.release();
    }

    await logActivity(
      userId,
      "user_registered",
      `New ${role} registered: ${email}`,
      { ip: req.ip },
    );

    return res.status(201).json({
      success: true,
      message:
        role === "tenant"
          ? `Welcome! You're connected to ${tenancyInfo.plaza_name}, Unit ${tenancyInfo.unit_number}.`
          : "Account created successfully. Please log in.",
      data: { tenancy: tenancyInfo },
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* silent */
    }
    try {
      conn.release();
    } catch {
      /* silent */
    }
    throw err;
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/login
// Body: { email, password }
// ═══════════════════════════════════════════════════════════════
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email?.trim() || !password) {
    throw new AppError("Email and password are required", 400);
  }

  const user = await User.findByEmail(email.trim().toLowerCase(), true); // true = include password_hash
  if (!user || !(await user.verifyPassword(password))) {
    throw new AppError("Invalid email or password", 401);
  }
  if (user.status !== "active") {
    throw new AppError(
      `Your account is ${user.status}. Please contact support.`,
      403,
    );
  }

  const payload = { id: user.id, role: user.role };
  const token = signAccess(payload);
  const refreshToken = signRefresh(payload);

  await db.execute(
    "UPDATE users SET refresh_token = ?, updated_at = NOW() WHERE id = ?",
    [refreshToken, user.id],
  );

  await logActivity(user.id, "login", "User logged in", { ip: req.ip });

  return res.json({
    success: true,
    token,
    refresh_token: refreshToken,
    user: user.toSafeObject(),
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/refresh
// Exchange a valid refresh token for a new access + refresh pair.
// Body: { refresh_token }
// ═══════════════════════════════════════════════════════════════
const refreshToken = asyncHandler(async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) throw new AppError("refresh_token is required", 400);

  let decoded;
  try {
    decoded = jwt.verify(
      refresh_token,
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    );
  } catch {
    throw new AppError("Invalid or expired refresh token", 401);
  }

  const [[row]] = await db.execute(
    "SELECT id, role, status, refresh_token FROM users WHERE id = ? LIMIT 1",
    [decoded.id],
  );
  if (!row || row.refresh_token !== refresh_token) {
    throw new AppError("Token not recognised. Please log in again.", 401);
  }
  if (row.status !== "active") {
    throw new AppError("Account is not active", 403);
  }

  const payload = { id: row.id, role: row.role };
  const newToken = signAccess(payload);
  const newRefresh = signRefresh(payload);

  await db.execute(
    "UPDATE users SET refresh_token = ?, updated_at = NOW() WHERE id = ?",
    [newRefresh, row.id],
  );

  return res.json({
    success: true,
    token: newToken,
    refresh_token: newRefresh,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/logout
// Clears the stored refresh token — invalidates the session.
// ═══════════════════════════════════════════════════════════════
const logout = asyncHandler(async (req, res) => {
  await db.execute(
    "UPDATE users SET refresh_token = NULL, updated_at = NOW() WHERE id = ?",
    [req.user.id],
  );
  await logActivity(req.user.id, "logout", "User logged out", { ip: req.ip });
  return res.json({ success: true, message: "Logged out successfully" });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/auth/me
// Returns the authenticated user's safe profile.
// ═══════════════════════════════════════════════════════════════
const getCurrentUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw new AppError("User not found", 404);
  return res.json({ success: true, data: user.toSafeObject() });
});

// ═══════════════════════════════════════════════════════════════
// PATCH /api/auth/me
// Update profile fields — username, full_name, phone, address.
// Body: { username?, full_name?, phone?, address? }
// ═══════════════════════════════════════════════════════════════
const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { username, full_name, phone, address } = req.body;

  const fields = [];
  const params = [];

  if (username?.trim()) {
    // Unique check — exclude self
    const [[taken]] = await db.execute(
      "SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1",
      [username.trim(), userId],
    );
    if (taken) throw new AppError("This username is already taken", 409);
    fields.push("username = ?");
    params.push(username.trim());
  }
  if (full_name !== undefined) {
    fields.push("full_name = ?");
    params.push(full_name?.trim() || null);
  }
  if (phone !== undefined) {
    fields.push("phone = ?");
    params.push(phone?.trim() || null);
  }
  if (address !== undefined) {
    fields.push("address = ?");
    params.push(address?.trim() || null);
  }

  if (!fields.length) throw new AppError("No fields to update", 400);

  fields.push("updated_at = NOW()");
  params.push(userId);

  await db.execute(
    `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );

  await logActivity(userId, "profile_updated", "Profile updated", {
    ip: req.ip,
  });

  const user = await User.findById(userId);
  return res.json({
    success: true,
    message: "Profile updated successfully",
    data: user.toSafeObject(),
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/avatar
// Upload / replace profile avatar.
// File: single image, handled by uploadMiddleware.avatar.single("avatar")
// ═══════════════════════════════════════════════════════════════
const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("An image file is required", 400);

  const avatarUrl = `uploads/profile/${req.file.filename}`;

  await db.execute(
    "UPDATE users SET avatar_url = ?, updated_at = NOW() WHERE id = ?",
    [avatarUrl, req.user.id],
  );

  await logActivity(req.user.id, "profile_updated", "Avatar updated", {
    ip: req.ip,
  });

  return res.json({
    success: true,
    message: "Avatar updated successfully",
    avatar_url: avatarUrl,
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password
// Always returns 200 — prevents email enumeration.
// Body: { email }
// ═══════════════════════════════════════════════════════════════
const SAFE_RESET_RESPONSE = {
  success: true,
  message: "If that email is registered, a reset link has been sent.",
};

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email?.trim()) throw new AppError("Email is required", 400);

  const user = await User.findByEmail(email.trim().toLowerCase());
  if (!user) return res.json(SAFE_RESET_RESPONSE); // don't reveal if email exists

  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

  await db.execute(
    "UPDATE users SET reset_token = ?, reset_token_expiry = ?, updated_at = NOW() WHERE id = ?",
    [token, expiry, user.id],
  );

  const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password.html?token=${token}`;
  const transporter = req.app.get("transporter");
  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"RentMS Ghana" <${process.env.EMAIL_USER}>`,
        to: email.trim().toLowerCase(),
        subject: "RentMS — Password Reset Request",
        html: `
          <p>You requested a password reset for your RentMS account.</p>
          <p><a href="${resetUrl}" style="color:#1e40af">Click here to reset your password</a></p>
          <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
        `,
      });
    } catch (emailErr) {
      console.warn("[forgotPassword] email send failed:", emailErr.message);
    }
  }

  await logActivity(
    user.id,
    "password_reset_requested",
    "Password reset email sent",
    { ip: req.ip },
  );
  return res.json(SAFE_RESET_RESPONSE);
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/reset-password
// Body: { token, new_password }
// ═══════════════════════════════════════════════════════════════
const resetPassword = asyncHandler(async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) {
    throw new AppError("token and new_password are required", 400);
  }
  if (!isStrongPassword(new_password)) {
    throw new AppError(
      "Password must be at least 8 characters and contain at least one letter and one number",
      400,
    );
  }

  const [[user]] = await db.execute(
    "SELECT id, reset_token_expiry FROM users WHERE reset_token = ? LIMIT 1",
    [token],
  );
  if (!user) throw new AppError("Invalid or expired reset token", 400);
  if (new Date(user.reset_token_expiry) < new Date()) {
    throw new AppError(
      "Reset token has expired. Please request a new one.",
      400,
    );
  }

  await User.updatePassword(user.id, new_password);
  await db.execute(
    "UPDATE users SET reset_token = NULL, reset_token_expiry = NULL, refresh_token = NULL, updated_at = NOW() WHERE id = ?",
    [user.id],
  );

  await logActivity(
    user.id,
    "password_reset_completed",
    "Password reset successfully",
    { ip: req.ip },
  );
  return res.json({
    success: true,
    message: "Password reset successfully. You can now log in.",
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/change-password
// Body: { current_password, new_password }
// ═══════════════════════════════════════════════════════════════
const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    throw new AppError("current_password and new_password are required", 400);
  }
  if (!isStrongPassword(new_password)) {
    throw new AppError(
      "New password must be at least 8 characters and contain at least one letter and one number",
      400,
    );
  }
  if (current_password === new_password) {
    throw new AppError(
      "New password must be different from your current password",
      400,
    );
  }

  const user = await User.findById(req.user.id, true); // true = include password_hash
  if (!user) throw new AppError("User not found", 404);
  if (!(await user.verifyPassword(current_password))) {
    throw new AppError("Current password is incorrect", 401);
  }

  await User.updatePassword(req.user.id, new_password);

  // Invalidate all existing refresh tokens — forces re-login on other devices
  await db.execute(
    "UPDATE users SET refresh_token = NULL, updated_at = NOW() WHERE id = ?",
    [req.user.id],
  );

  await logActivity(
    req.user.id,
    "password_changed",
    "Password changed successfully",
    { ip: req.ip },
  );
  return res.json({
    success: true,
    message: "Password updated successfully. Please log in again.",
  });
});

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  getCurrentUser,
  updateProfile,
  uploadAvatar,
  forgotPassword,
  resetPassword,
  changePassword,
};
