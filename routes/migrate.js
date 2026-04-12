// routes/migrate.js — ONE-TIME: create admin user
const express = require("express");
const router = express.Router();
const db = require("../utils/db");
const bcrypt = require("bcryptjs");

router.get("/migrate", async (req, res) => {
  try {
    /* Check if admin already exists */
    const [[existing]] = await db.execute(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
    );
    if (existing) {
      return res.json({
        success: true,
        message: "Admin already exists — nothing to do.",
      });
    }

    const hash = await bcrypt.hash("Admin@1234", 10);
    await db.execute(
      `INSERT INTO users (username, email, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', NOW(), NOW())`,
      ["admin", "admin@rentms.com", hash],
    );

    return res.json({
      success: true,
      message:
        "✅ Admin created. Email: admin@rentms.com | Password: Admin@1234 — Change after login! Remove this route now.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
