// routes/migrate.js
// ONE-TIME migration — adds image_url column to plazas table
// Visit /api/migrate once then remove this file

const express = require("express");
const router = express.Router();
const db = require("../utils/db");

router.get("/migrate", async (req, res) => {
  const results = [];
  try {
    // Add image_url column to plazas if it doesn't exist
    await db.execute(`
      ALTER TABLE plazas
      ADD COLUMN IF NOT EXISTS image_url VARCHAR(500) NULL DEFAULT NULL
    `);
    results.push({ step: "alter plazas", status: "✅ image_url column added" });

    return res.json({
      success: true,
      message: "Migration complete. Remove this route now.",
      results,
    });
  } catch (err) {
    // If column already exists, MySQL throws error 1060
    if (
      err.code === "ER_DUP_FIELDNAME" ||
      err.message.includes("Duplicate column")
    ) {
      return res.json({
        success: true,
        message: "Column already exists — no action needed.",
        results: [
          { step: "alter plazas", status: "✅ image_url already exists" },
        ],
      });
    }
    return res
      .status(500)
      .json({ success: false, message: err.message, code: err.code });
  }
});

module.exports = router;
