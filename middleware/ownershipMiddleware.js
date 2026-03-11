// middleware/ownershipMiddleware.js
// ============================================================
// Resource ownership enforcement — second layer of access control
// after authMiddleware + roleMiddleware.
//
// Usage:
//   ownershipMiddleware("plaza")
//   ownershipMiddleware("tenancy")
//   ownershipMiddleware("maintenance_request")
//   ownershipMiddleware("payment")
//   ownershipMiddleware("group")
//
// Requirements:
//   authMiddleware must run first — req.user.id + req.user.role required.
//
// Role behaviour:
//   admin    — bypasses all ownership checks (passes immediately)
//   landlord — verified against their owned plazas
//   tenant   — verified against their own records
//
// Schema notes (rentms_full_schema.sql):
//   maintenance_requests.plaza_id (NOT tenancy_id)
//   payments join through tenancies (no payments.tenant_id column)
//   plazas.deleted_at — soft-delete; excluded from checks
//   plazas has NO company_id column
//   group tables: plaza_groups, group_members (used by landlordController)
//
// Resource ID resolution:
//   Checks req.params.id first, then req.params.payment_id,
//   req.params.tenancy_id, req.params.plaza_id — covers all route
//   param naming conventions in the codebase.
// ============================================================

const db = require("../utils/db");

const VALID_RESOURCE_TYPES = [
  "tenancy",
  "plaza",
  "maintenance_request",
  "payment",
  "group",
];

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

// Resolve resource ID from whichever param key the route uses
const resolveResourceId = (params) =>
  parseId(params.id) ||
  parseId(params.payment_id) ||
  parseId(params.tenancy_id) ||
  parseId(params.plaza_id) ||
  parseId(params.group_id) ||
  null;

const ownershipMiddleware = (resourceType) => {
  if (!VALID_RESOURCE_TYPES.includes(resourceType)) {
    throw new Error(
      `ownershipMiddleware: unknown resourceType "${resourceType}". ` +
        `Must be one of: ${VALID_RESOURCE_TYPES.join(", ")}`,
    );
  }

  return async (req, res, next) => {
    try {
      // Guard — authMiddleware should always run first
      if (!req.user?.id || !req.user?.role) {
        return res
          .status(401)
          .json({ success: false, message: "Authentication required" });
      }

      const { id: userId, role } = req.user;

      // Admins bypass all ownership checks
      if (role === "admin") return next();

      const resourceId = resolveResourceId(req.params);
      if (!resourceId) {
        return res.status(400).json({
          success: false,
          message: "A valid numeric resource ID is required",
        });
      }

      let query = null;
      let values = [];

      // ── TENANCY ─────────────────────────────────────────────
      if (resourceType === "tenancy") {
        if (role === "tenant") {
          // Tenant owns the tenancy directly
          query = `SELECT t.id FROM tenancies t WHERE t.id = ? AND t.tenant_id = ?`;
          values = [resourceId, userId];
        }
        if (role === "landlord") {
          // Tenancy belongs to one of the landlord's non-deleted plazas
          query = `
            SELECT t.id FROM tenancies t
            JOIN plazas p ON p.id = t.plaza_id
            WHERE t.id = ? AND p.landlord_id = ? AND p.deleted_at IS NULL
          `;
          values = [resourceId, userId];
        }
      }

      // ── PLAZA ────────────────────────────────────────────────
      if (resourceType === "plaza") {
        if (role === "tenant") {
          // Tenants cannot manage plazas — explicit 403
          console.warn(
            `[OWNERSHIP] Tenant ${userId} attempted plaza access — ` +
              `resource ${resourceId} — IP: ${req.ip}`,
          );
          return res.status(403).json({
            success: false,
            message: "Tenants are not permitted to manage plazas",
          });
        }
        if (role === "landlord") {
          query = `
            SELECT id FROM plazas
            WHERE id = ? AND landlord_id = ? AND deleted_at IS NULL
          `;
          values = [resourceId, userId];
        }
      }

      // ── MAINTENANCE REQUEST ──────────────────────────────────
      // maintenance_requests.plaza_id is the FK — no tenancy_id column
      if (resourceType === "maintenance_request") {
        if (role === "tenant") {
          // Tenant owns the request directly
          query = `SELECT id FROM maintenance_requests WHERE id = ? AND tenant_id = ?`;
          values = [resourceId, userId];
        }
        if (role === "landlord") {
          // Request belongs to one of the landlord's non-deleted plazas
          query = `
            SELECT mr.id FROM maintenance_requests mr
            JOIN plazas p ON p.id = mr.plaza_id
            WHERE mr.id = ? AND p.landlord_id = ? AND p.deleted_at IS NULL
          `;
          values = [resourceId, userId];
        }
      }

      // ── PAYMENT ──────────────────────────────────────────────
      // payments has no tenant_id — must join through tenancies
      if (resourceType === "payment") {
        if (role === "tenant") {
          query = `
            SELECT py.id FROM payments py
            JOIN tenancies t ON t.id = py.tenancy_id
            WHERE py.id = ? AND t.tenant_id = ?
          `;
          values = [resourceId, userId];
        }
        if (role === "landlord") {
          query = `
            SELECT py.id FROM payments py
            JOIN tenancies t ON t.id  = py.tenancy_id
            JOIN plazas    p ON p.id  = t.plaza_id
            WHERE py.id = ? AND p.landlord_id = ? AND p.deleted_at IS NULL
          `;
          values = [resourceId, userId];
        }
      }

      // ── GROUP ────────────────────────────────────────────────
      // Tables: plaza_groups (id, plaza_id, name), group_members (group_id, user_id)
      if (resourceType === "group") {
        if (role === "tenant") {
          // Tenant is a member of the group
          query = `
            SELECT gm.group_id FROM group_members gm
            WHERE gm.group_id = ? AND gm.user_id = ?
          `;
          values = [resourceId, userId];
        }
        if (role === "landlord") {
          // Group belongs to one of the landlord's non-deleted plazas
          query = `
            SELECT pg.id FROM plaza_groups pg
            JOIN plazas p ON p.id = pg.plaza_id
            WHERE pg.id = ? AND p.landlord_id = ? AND p.deleted_at IS NULL
          `;
          values = [resourceId, userId];
        }
      }

      // No query built — role has no defined access path for this resource
      if (!query) {
        console.warn(
          `[OWNERSHIP] No query matched — role: "${role}", ` +
            `resource: "${resourceType}", id: ${resourceId}, user: ${userId} — IP: ${req.ip}`,
        );
        return res
          .status(403)
          .json({ success: false, message: "Access denied" });
      }

      const [rows] = await db.execute(
        query.replace(/\n\s+/g, " ").trim(),
        values,
      );

      if (!rows?.length) {
        console.warn(
          `[OWNERSHIP] Check failed — role: "${role}", ` +
            `resource: "${resourceType}", id: ${resourceId}, user: ${userId} — IP: ${req.ip}`,
        );
        return res.status(403).json({
          success: false,
          message: "You do not have access to this resource",
        });
      }

      next();
    } catch (err) {
      console.error(
        `[OWNERSHIP] Unexpected error — resource: "${resourceType}", ` +
          `user: ${req.user?.id}, IP: ${req.ip}`,
        err,
      );
      return res.status(500).json({
        success: false,
        message: "Ownership validation failed. Please try again.",
      });
    }
  };
};

module.exports = ownershipMiddleware;
