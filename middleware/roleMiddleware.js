// middleware/roleMiddleware.js
// ============================================================
// Role-based access control middleware.
// Must run AFTER authMiddleware — requires req.user.id + req.user.role.
//
// Usage:
//   roleMiddleware(["admin"])
//   roleMiddleware(["admin", "landlord"])
//   roleMiddleware(["tenant"])
//
// Accepts a string as a convenience alias for single-role use:
//   roleMiddleware("landlord")  →  treated as ["landlord"]
//   This covers inviteCodeRoutes.js and any other legacy callers.
//
// Validation fires at factory call time (startup) — invalid roles
// throw immediately rather than silently passing at request time.
// ============================================================

const VALID_ROLES = ["tenant", "landlord", "admin"];

const roleMiddleware = (allowedRoles = []) => {
  // ── Coerce string → array for single-role convenience ──────
  // Allows: roleMiddleware("landlord") as well as roleMiddleware(["landlord"])
  const normalised =
    typeof allowedRoles === "string" ? [allowedRoles] : allowedRoles;

  // ── Startup-time validation ─────────────────────────────────
  if (!Array.isArray(normalised) || normalised.length === 0) {
    throw new Error(
      `roleMiddleware: allowedRoles must be a non-empty array or string. ` +
        `Valid roles are: ${VALID_ROLES.join(", ")}`,
    );
  }

  const unrecognised = normalised.filter((r) => !VALID_ROLES.includes(r));
  if (unrecognised.length > 0) {
    throw new Error(
      `roleMiddleware: unrecognised role(s): "${unrecognised.join('", "')}". ` +
        `Valid roles are: ${VALID_ROLES.join(", ")}`,
    );
  }

  // Frozen copy — prevents external mutation affecting in-flight requests
  const allowedSet = Object.freeze([...normalised]);

  // ── Per-request middleware ──────────────────────────────────
  return (req, res, next) => {
    try {
      // 401 — not authenticated (authMiddleware should have caught this first)
      if (!req.user?.id || !req.user?.role) {
        return res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
      }

      const { id: userId, role: userRole } = req.user;

      // 403 — authenticated but role not permitted
      if (!allowedSet.includes(userRole)) {
        console.warn(
          `[ROLE] Access denied — user: ${userId}, role: "${userRole}", ` +
            `required: [${allowedSet.join(", ")}] — IP: ${req.ip}`,
        );
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You do not have permission to perform this action.",
        });
      }

      next();
    } catch (err) {
      console.error(
        `[ROLE] Unexpected error — user: ${req.user?.id}, IP: ${req.ip}`,
        err,
      );
      return res.status(500).json({
        success: false,
        message: "Authorization check failed. Please try again.",
      });
    }
  };
};

module.exports = { roleMiddleware, VALID_ROLES };
