// routes/contactroutes.js
// ============================================================
// Base path: /api/contact
//
// PUBLIC route — no authMiddleware. This is the homepage's
// "Get in Touch" form; visitors submitting it aren't logged in,
// so it can't require a JWT like every other route in this app.
// Rate-limited instead (contactLimiter — 5 req / 15 min per IP)
// since it's the one open door into sending real email.
// ============================================================

const express = require("express");
const router = express.Router();

const { contactLimiter } = require("../middleware/ratelimitMiddleware");
const { submitContactForm } = require("../controllers/contactcontroller");

/**
 * POST /api/contact
 * Body: { name, email, message, subject? }
 */
router.post("/", contactLimiter, submitContactForm);

module.exports = router;
