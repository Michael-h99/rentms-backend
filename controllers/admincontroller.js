// controllers/admincontroller.js
const crypto = require("crypto");
const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");
const { logActivity } = require("../utils/activitylogger");
const NotificationService = require("../services/notificationservice");
const { buildPaginationResponse } = require("../utils/pagination");

const VALID_ROLES = ["tenant", "landlord", "admin"];
const VALID_STATUSES = ["active", "suspended", "blacklisted"];
const ROLE_HIERARCHY = { tenant: 1, landlord: 2, admin: 3 };
const DEFAULT_LIMIT = 20;
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// ── GET /api/admin/dashboard ─────────────────────────────────
const getDashboardStats = asyncHandler(async (req, res) => {
  const [[users]] = await db.execute(
    `SELECT COUNT(*) AS total_users, SUM(role='tenant') AS total_tenants,
       SUM(role='landlord') AS total_landlords, SUM(role='admin') AS total_admins,
       SUM(status='active') AS active_users, SUM(status='suspended') AS suspended_users,
       SUM(status='blacklisted') AS blacklisted_users
     FROM users WHERE deleted_at IS NULL`,
  );
  const [[plazas]] = await db.execute(
    `SELECT COUNT(*) AS total_plazas, SUM(total_units) AS total_units
     FROM plazas WHERE deleted_at IS NULL`,
  );
  const [[tenancies]] = await db.execute(
    `SELECT COUNT(*) AS total_tenancies, SUM(status='active') AS active_tenancies,
       SUM(status='expired') AS expired_tenancies FROM tenancies`,
  );
  const [[payments]] = await db.execute(
    `SELECT COUNT(*) AS total_payments, COALESCE(SUM(amount),0) AS total_revenue,
       SUM(status='paid') AS paid_payments, SUM(status='pending') AS pending_payments,
       SUM(status='failed') AS failed_payments FROM payments`,
  );
  const [[maintenance]] = await db.execute(
    `SELECT COUNT(*) AS total_requests, SUM(status='pending') AS pending_requests,
       SUM(status='in_progress') AS in_progress_requests,
       SUM(status='resolved') AS resolved_requests,
       SUM(status='rejected') AS rejected_requests FROM maintenance_requests`,
  );
  const [[recentActivity]] = await db.execute(
    `SELECT COUNT(*) AS actions_today FROM activity_logs WHERE DATE(created_at) = CURDATE()`,
  );
  return res.json({
    success: true,
    data: { users, plazas, tenancies, payments, maintenance, recentActivity },
  });
});

// ── GET /api/admin/users ─────────────────────────────────────
const getAllUsers = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { role, status, search } = req.query;

  if (role && !VALID_ROLES.includes(role))
    throw new AppError(`Invalid role`, 400);
  if (status && !VALID_STATUSES.includes(status))
    throw new AppError(`Invalid status`, 400);

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
    `SELECT id, username, full_name, email, phone, avatar_url, role, status, created_at, updated_at
     FROM users ${WHERE} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ── GET /api/admin/users/:id ─────────────────────────────────
const getUserById = asyncHandler(async (req, res) => {
  const userId = parseId(req.params.id);
  if (!userId) throw new AppError("Invalid user ID", 400);
  const [[user]] = await db.execute(
    `SELECT id, username, full_name, email, phone, avatar_url, address, role, status, created_at, updated_at
     FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId],
  );
  if (!user) throw new AppError("User not found", 404);
  const [[counts]] = await db.execute(
    `SELECT (SELECT COUNT(*) FROM tenancies WHERE tenant_id = ?) AS total_tenancies,
       (SELECT COUNT(*) FROM maintenance_requests WHERE tenant_id = ?) AS total_maintenance,
       (SELECT COUNT(*) FROM payments py JOIN tenancies t ON t.id = py.tenancy_id WHERE t.tenant_id = ?) AS total_payments,
       (SELECT COUNT(*) FROM activity_logs WHERE user_id = ?) AS total_activity_logs`,
    [userId, userId, userId, userId],
  );
  return res.json({ success: true, data: { ...user, ...counts } });
});

// ── PATCH /api/admin/users/:id ───────────────────────────────
const updateUser = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const targetId = parseId(req.params.id);
  if (!targetId) throw new AppError("Invalid user ID", 400);
  const [[target]] = await db.execute(
    `SELECT id, username, full_name, email, phone FROM users WHERE id = ? AND deleted_at IS NULL`,
    [targetId],
  );
  if (!target) throw new AppError("User not found", 404);
  const { username, full_name, email, phone } = req.body;
  const fields = [];
  const params = [];
  if (username?.trim()) {
    const [[taken]] = await db.execute(
      "SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1",
      [username.trim(), targetId],
    );
    if (taken) throw new AppError("Username already taken", 409);
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
  if (email?.trim()) {
    const [[taken]] = await db.execute(
      "SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1",
      [email.trim().toLowerCase(), targetId],
    );
    if (taken) throw new AppError("Email already in use", 409);
    fields.push("email = ?");
    params.push(email.trim().toLowerCase());
  }
  if (!fields.length) throw new AppError("No fields to update", 400);
  fields.push("updated_at = NOW()");
  params.push(targetId);
  await db.execute(
    `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
  await logActivity(
    adminId,
    "user_updated",
    `Admin updated profile for user ${targetId}`,
    { ip: req.ip },
  );
  return res.json({ success: true, message: "User updated successfully" });
});

// ── PATCH /api/admin/users/:id/role ─────────────────────────
const updateUserRole = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const targetId = parseId(req.params.id);
  if (!targetId) throw new AppError("Invalid user ID", 400);
  const { role } = req.body;
  if (!role || !VALID_ROLES.includes(role))
    throw new AppError(`role required: ${VALID_ROLES.join(", ")}`, 400);
  if (targetId === adminId)
    throw new AppError("You cannot change your own role", 403);
  if (ROLE_HIERARCHY[role] > ROLE_HIERARCHY[req.user.role])
    throw new AppError("Cannot assign role higher than own", 403);
  const [[target]] = await db.execute(
    `SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL`,
    [targetId],
  );
  if (!target) throw new AppError("User not found", 404);
  if (target.role === role)
    return res.json({ success: true, message: "User already has this role" });
  await db.execute(
    `UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?`,
    [role, targetId],
  );
  await NotificationService.create({
    recipientId: targetId,
    senderId: adminId,
    type: "general",
    message: `Your account role has been updated to "${role}"`,
    io: req.app.get("io"),
  });
  await logActivity(
    adminId,
    "role_updated",
    `Changed user ${targetId} role: "${target.role}" → "${role}"`,
    { ip: req.ip },
  );
  return res.json({ success: true, message: "User role updated successfully" });
});

// ── PATCH /api/admin/users/:id/status ───────────────────────
const updateUserStatus = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const targetId = parseId(req.params.id);
  if (!targetId) throw new AppError("Invalid user ID", 400);
  const { status } = req.body;
  if (!status || !VALID_STATUSES.includes(status))
    throw new AppError(`status required: ${VALID_STATUSES.join(", ")}`, 400);
  if (targetId === adminId)
    throw new AppError("You cannot change your own status", 403);
  const [[target]] = await db.execute(
    `SELECT id, status, role FROM users WHERE id = ? AND deleted_at IS NULL`,
    [targetId],
  );
  if (!target) throw new AppError("User not found", 404);
  if (ROLE_HIERARCHY[target.role] >= ROLE_HIERARCHY[req.user.role])
    throw new AppError("Cannot change status of equal/higher role user", 403);
  if (target.status === status)
    return res.json({ success: true, message: "User already has this status" });
  await db.execute(
    `UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?`,
    [status, targetId],
  );
  if (status !== "active")
    await db.execute(`UPDATE users SET refresh_token = NULL WHERE id = ?`, [
      targetId,
    ]);
  await NotificationService.create({
    recipientId: targetId,
    senderId: adminId,
    type: "general",
    message: `Your account status has been updated to "${status}".`,
    io: req.app.get("io"),
  });
  await logActivity(
    adminId,
    "status_updated",
    `Changed user ${targetId} status: "${target.status}" → "${status}"`,
    { ip: req.ip },
  );
  return res.json({
    success: true,
    message: "User status updated successfully",
  });
});

// ── DELETE /api/admin/users/:id ──────────────────────────────
const deleteUser = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const targetId = parseId(req.params.id);
  if (!targetId) throw new AppError("Invalid user ID", 400);
  if (targetId === adminId)
    throw new AppError("You cannot delete your own account", 403);
  const [[target]] = await db.execute(
    `SELECT id, username, role FROM users WHERE id = ? AND deleted_at IS NULL`,
    [targetId],
  );
  if (!target) throw new AppError("User not found", 404);
  if (ROLE_HIERARCHY[target.role] >= ROLE_HIERARCHY[req.user.role])
    throw new AppError("Cannot delete equal/higher role user", 403);
  await db.execute(
    `UPDATE users SET deleted_at = NOW(), refresh_token = NULL WHERE id = ?`,
    [targetId],
  );
  await logActivity(
    adminId,
    "user_deleted",
    `Soft-deleted user ${targetId} ("${target.username}", "${target.role}")`,
    { ip: req.ip },
  );
  return res.json({ success: true, message: "User deleted successfully" });
});

// ── GET /api/admin/users/:id/logs ───────────────────────────
const getUserActivityLogs = asyncHandler(async (req, res) => {
  const userId = parseId(req.params.id);
  if (!userId) throw new AppError("Invalid user ID", 400);
  const [[exists]] = await db.execute(
    `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId],
  );
  if (!exists) throw new AppError("User not found", 404);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const [[{ total }]] = await db.execute(
    `SELECT COUNT(*) AS total FROM activity_logs WHERE user_id = ?`,
    [userId],
  );
  const [logs] = await db.execute(
    `SELECT id, action, description, ip_address, created_at FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset],
  );
  return res.json({
    success: true,
    ...buildPaginationResponse({ data: logs, total, page, limit }),
  });
});

// ── POST /api/admin/users/:id/reset-password ────────────────
const triggerUserPasswordReset = asyncHandler(async (req, res) => {
  const adminId = req.user.id;
  const targetId = parseId(req.params.id);
  if (!targetId) throw new AppError("Invalid user ID", 400);
  if (targetId === adminId)
    throw new AppError("Use /api/auth/change-password for own password", 403);
  const [[target]] = await db.execute(
    `SELECT id, email, full_name, username FROM users WHERE id = ? AND deleted_at IS NULL`,
    [targetId],
  );
  if (!target) throw new AppError("User not found", 404);
  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);
  await db.execute(
    `UPDATE users SET reset_token = ?, reset_token_expiry = ?, updated_at = NOW() WHERE id = ?`,
    [token, expiry, targetId],
  );
  const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password.html?token=${token}`;
  const transporter = req.app.get("transporter");
  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"RentMS Ghana" <${process.env.EMAIL_USER}>`,
        to: target.email,
        subject: "RentMS — Password Reset Requested by Admin",
        html: `<p>Hi ${target.full_name || target.username},</p><p>An administrator has initiated a password reset.</p><p><a href="${resetUrl}">Click here to set a new password</a></p><p>This link expires in 1 hour.</p>`,
      });
    } catch (e) {
      console.warn("[triggerUserPasswordReset] email failed:", e.message);
    }
  }
  await logActivity(
    adminId,
    "password_reset_triggered",
    `Admin triggered password reset for user ${targetId} (${target.email})`,
    { ip: req.ip },
  );
  return res.json({
    success: true,
    message: "Password reset email sent successfully",
  });
});

// ── GET /api/admin/payments ──────────────────────────────────
const getAllPayments = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { from, to, status } = req.query;
  const plazaId = parseId(req.query.plaza_id);
  const userId = parseId(req.query.user_id);
  const conditions = [];
  const params = [];
  if (from) {
    conditions.push("DATE(py.payment_date) >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("DATE(py.payment_date) <= ?");
    params.push(to);
  }
  if (status) {
    conditions.push("py.status = ?");
    params.push(status);
  }
  if (plazaId) {
    conditions.push("t.plaza_id = ?");
    params.push(plazaId);
  }
  if (userId) {
    conditions.push("t.tenant_id = ?");
    params.push(userId);
  }
  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM payments py JOIN tenancies t ON t.id = py.tenancy_id ${WHERE}`,
    params,
  );
  const [rows] = await db.query(
    `SELECT py.id, py.amount, py.currency, py.payment_method, py.status, py.reference, py.payment_date, py.verified_at,
       t.unit_number, u.id AS tenant_id, u.full_name AS tenant_name, u.email AS tenant_email,
       p.id AS plaza_id, p.name AS plaza_name, l.full_name AS landlord_name
     FROM payments py JOIN tenancies t ON t.id = py.tenancy_id JOIN plazas p ON p.id = t.plaza_id
     JOIN users u ON u.id = t.tenant_id JOIN users l ON l.id = p.landlord_id
     ${WHERE} ORDER BY py.payment_date DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ── GET /api/admin/maintenance ───────────────────────────────
const getAllMaintenance = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { status, priority } = req.query;
  const plazaId = parseId(req.query.plaza_id);
  const userId = parseId(req.query.user_id);
  const conditions = [];
  const params = [];
  if (status) {
    conditions.push("mr.status = ?");
    params.push(status);
  }
  if (priority) {
    conditions.push("mr.priority = ?");
    params.push(priority);
  }
  if (plazaId) {
    conditions.push("mr.plaza_id = ?");
    params.push(plazaId);
  }
  if (userId) {
    conditions.push("mr.tenant_id = ?");
    params.push(userId);
  }
  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM maintenance_requests mr ${WHERE}`,
    params,
  );
  const [rows] = await db.query(
    `SELECT mr.id, mr.title, mr.priority, mr.status, mr.attachment_url, mr.resolved_at, mr.created_at, mr.updated_at,
       p.id AS plaza_id, p.name AS plaza_name, l.full_name AS landlord_name,
       u.id AS tenant_id, u.full_name AS tenant_name, u.email AS tenant_email
     FROM maintenance_requests mr JOIN plazas p ON p.id = mr.plaza_id
     JOIN users l ON l.id = p.landlord_id JOIN users u ON u.id = mr.tenant_id
     ${WHERE} ORDER BY FIELD(mr.priority,'high','medium','low'), mr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ── GET /api/admin/plazas ────────────────────────────────────
const getAllPlazas = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { search } = req.query;
  const landlordId = parseId(req.query.landlord_id);
  const conditions = ["p.deleted_at IS NULL"];
  const params = [];
  if (search) {
    conditions.push("(p.name LIKE ? OR p.location LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (landlordId) {
    conditions.push("p.landlord_id = ?");
    params.push(landlordId);
  }
  const WHERE = `WHERE ${conditions.join(" AND ")}`;
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM plazas p ${WHERE}`,
    params,
  );
  const [rows] = await db.query(
    `SELECT p.id, p.name, p.location, p.total_units, p.image_url, p.created_at,
       u.id AS landlord_id, u.full_name AS landlord_name, u.username AS landlord_username, u.email AS landlord_email,
       (SELECT COUNT(*) FROM tenancies t WHERE t.plaza_id = p.id AND t.status = 'active') AS occupied_units
     FROM plazas p JOIN users u ON u.id = p.landlord_id
     ${WHERE} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ── GET /api/admin/leases ────────────────────────────────────
const getAllLeases = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { status, search } = req.query;
  const plazaId = parseId(req.query.plaza_id);
  const conditions = [];
  const params = [];
  if (status) {
    conditions.push("t.status = ?");
    params.push(status);
  }
  if (plazaId) {
    conditions.push("t.plaza_id = ?");
    params.push(plazaId);
  }
  if (search) {
    conditions.push(
      "(tenant.full_name LIKE ? OR tenant.email LIKE ? OR p.name LIKE ?)",
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM tenancies t JOIN users tenant ON tenant.id = t.tenant_id JOIN plazas p ON p.id = t.plaza_id ${WHERE}`,
    params,
  );
  const [rows] = await db.query(
    `SELECT t.id, t.unit_number, t.rent_amount, t.security_deposit, t.lease_start, t.lease_end, t.status, t.created_at,
       tenant.id AS tenant_id, tenant.full_name AS tenant_name, tenant.username AS tenant_username, tenant.email AS tenant_email,
       p.id AS plaza_id, p.name AS plaza_name, p.location AS plaza_location,
       landlord.id AS landlord_id, landlord.full_name AS landlord_name, landlord.username AS landlord_username, landlord.email AS landlord_email
     FROM tenancies t JOIN users tenant ON tenant.id = t.tenant_id
     JOIN plazas p ON p.id = t.plaza_id JOIN users landlord ON landlord.id = p.landlord_id
     ${WHERE} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

module.exports = {
  getDashboardStats,
  getAllUsers,
  getUserById,
  updateUser,
  updateUserRole,
  updateUserStatus,
  deleteUser,
  getUserActivityLogs,
  triggerUserPasswordReset,
  getAllPayments,
  getAllMaintenance,
  getAllPlazas,
  getAllLeases,
};
