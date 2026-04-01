// routes/migrate.js — ONE-TIME migration
const express = require("express");
const router = express.Router();
const db = require("../utils/db");

router.get("/migrate", async (req, res) => {
  try {
    /* Check if column already exists first */
    const [[row]] = await db.execute(`
      SELECT COUNT(*) AS cnt
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'plazas'
        AND COLUMN_NAME  = 'image_url'
    `);

    if (row.cnt > 0) {
      return res.json({
        success: true,
        message: "image_url column already exists — nothing to do.",
      });
    }

    await db.execute(
      `ALTER TABLE plazas ADD COLUMN image_url VARCHAR(500) NULL DEFAULT NULL`,
    );
    return res.json({
      success: true,
      message:
        "✅ Migration complete. image_url column added to plazas. Remove this route now.",
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: err.message, code: err.code });
  }
});

module.exports = router;
