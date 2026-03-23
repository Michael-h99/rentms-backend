// migrate.js
// ============================================================
// One-time migration script — creates missing tables
// Run once then DELETE this file from your backend
//
// Usage: Add this route temporarily to app.js, deploy,
// visit /api/migrate once, then remove the route and redeploy.
// ============================================================

const express = require("express");
const router = express.Router();
const db = require("../utils/db");

router.get("/migrate", async (req, res) => {
  const results = [];

  try {
    // ── 1. group_members table ──────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS group_members (
        id        INT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
        group_id  INT      NOT NULL,
        user_id   INT      NOT NULL,
        joined_at DATETIME NOT NULL DEFAULT NOW(),
        UNIQUE KEY uq_group_user (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES plaza_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id)  REFERENCES users(id)        ON DELETE CASCADE
      )
    `);
    results.push({
      table: "group_members",
      status: "✅ created or already exists",
    });

    // ── 2. Auto-add all active tenants to their plaza groups ─
    // So existing tenants don't need to re-join manually
    const [tenancies] = await db.execute(`
      SELECT DISTINCT t.tenant_id, pg.id AS group_id
      FROM tenancies t
      JOIN plaza_groups pg ON pg.plaza_id = t.plaza_id
      WHERE t.status = 'active'
    `);

    let inserted = 0;
    for (const row of tenancies) {
      try {
        await db.execute(
          `INSERT IGNORE INTO group_members (group_id, user_id, joined_at)
           VALUES (?, ?, NOW())`,
          [row.group_id, row.tenant_id],
        );
        inserted++;
      } catch (e) {
        // ignore duplicate key errors
      }
    }
    results.push({
      step: "seed group_members",
      status: `✅ inserted ${inserted} existing tenant-group memberships`,
    });

    return res.json({
      success: true,
      message: "Migration complete. Remove this route from app.js now.",
      results,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      code: err.code,
      results,
    });
  }
});

module.exports = router;
