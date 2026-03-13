// routes/inviteCodeRoutes.js
// Mounted at:
//   /api/landlords/invite-codes  (landlord-only CRUD)
//   /api/auth/validate-code      (public, mounted in authroutes.js)

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/authMiddleware");
const { roleMiddleware } = require("../middleware/roleMiddleware");
const { generalLimiter } = require("../middleware/ratelimitMiddleware");

const {
  listCodes,
  createCode,
  revokeCode,
} = require("../controllers/invitecodecontroller");

// All landlord invite code routes require auth + landlord role
router.use(authMiddleware);
router.use(roleMiddleware(["landlord"]));

/**
 * GET  /api/landlords/invite-codes
 * Query: ?status=active|used|expired|revoked&plaza_id=1&page=1&limit=50
 */
router.get("/", generalLimiter, listCodes);

/**
 * POST /api/landlords/invite-codes
 * Body: { plaza_id, unit_number, rent_amount, max_uses, lease_start, lease_end, expires_at }
 */
router.post("/", generalLimiter, createCode);

/**
 * DELETE /api/landlords/invite-codes/:id
 * Revokes an active code owned by the authenticated landlord
 */
router.delete("/:id", generalLimiter, revokeCode);

module.exports = router;



