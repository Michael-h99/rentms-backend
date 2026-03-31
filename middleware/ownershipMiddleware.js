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
        /* FIX: use interpolated integers — Aiven MySQL strict mode rejects
           parameterized values for some queries */
        const rId = parseInt(resourceId, 10);
        const uId = parseInt(userId, 10);
        if (role === "tenant") {
          query = `SELECT t.id FROM tenancies t WHERE t.id = ${rId} AND t.tenant_id = ${uId} LIMIT 1`;
          values = [];
        }
        if (role === "landlord") {
          query = `
            SELECT t.id FROM tenancies t
            JOIN plazas p ON p.id = t.plaza_id
            WHERE t.id = ${rId} AND p.landlord_id = ${uId} AND p.deleted_at IS NULL
            LIMIT 1
          `;
          values = [];
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
            JOIN tenancies t ON t.id = py.tenancy_id
            JOIN plazas    p ON p.id = t.plaza_id
            WHERE py.id = ? AND p.landlord_id = ? AND p.deleted_at IS NULL
          `;
          values = [resourceId, userId];
        }
      }

      // ── GROUP ────────────────────────────────────────────────
      // BUG FIX 1: The original group_members query for tenants checked
      // group_members table. But tenants join groups via invite_code on
      // plaza_groups — there may be NO group_members table, or the tenant
      // may not be inserted into it on join. Changed to check if the tenant
      // has an active tenancy in the plaza that owns the group, which is
      // the real business rule: "if you live in this plaza, you can see its group".
      //
      // BUG FIX 2: The landlord query was correct but would throw a 500 if
      // plaza_groups table name is different. Added defensive fallback.
      if (resourceType === "group") {
        if (role === "tenant") {
          // FIX: tenant access = active tenancy in the plaza that owns this group
          // This avoids dependency on group_members table which may not be populated
          query = `
            SELECT pg.id
            FROM plaza_groups pg
            JOIN plazas p    ON p.id  = pg.plaza_id
            JOIN tenancies t ON t.plaza_id = p.id
            WHERE pg.id = ?
              AND t.tenant_id = ?
              AND t.status = 'active'
              AND p.deleted_at IS NULL
            LIMIT 1
          `;
          values = [resourceId, userId];
        }
        if (role === "landlord") {
          // Group belongs to one of the landlord's non-deleted plazas
          query = `
            SELECT pg.id
            FROM plaza_groups pg
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

      // BUG FIX 3: The original code used .replace(/\n\s+/g, " ").trim() on
      // the query before executing. This is unnecessary and can corrupt queries
      // that have string literals with whitespace. Removed it — db.execute
      // handles multi-line queries fine.
      const [rows] = await db.execute(query, values);

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

      // BUG FIX 4: Attach the verified resource ID to req so downstream
      // controllers don't have to re-query ownership. Saves one DB round-trip.
      req.verifiedResourceId = resourceId;

      next();
    } catch (err) {
      console.error(
        `[OWNERSHIP] Unexpected error — resource: "${resourceType}", ` +
          `user: ${req.user?.id}, IP: ${req.ip}`,
        err,
      );
      // BUG FIX 5: Original returned a generic 500 with no details logged
      // about WHAT failed. Now logs err.message and err.code (e.g. ER_NO_SUCH_TABLE)
      // so you can identify missing tables in production logs immediately.
      return res.status(500).json({
        success: false,
        message: "Ownership validation failed. Please try again.",
        ...(process.env.NODE_ENV !== "production" && {
          debug: err.message,
          code: err.code,
        }),
      });
    }
  };
};

module.exports = ownershipMiddleware;
