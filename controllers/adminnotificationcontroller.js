// controllers/adminnotificationcontroller.js
// ============================================================
// Admin notification analytics — read-only aggregation
// queries on the notifications table. Wired to
// adminNotificationRoutes.js at /api/admin/notifications/*.
//
// Schema (rentms_full_schema.sql — Section 10):
//   notifications.recipient_id : INT  (not user_id)
//   notifications.sender_id    : INT NULL
//   notifications.type         : VARCHAR(50)
//   notifications.is_read      : BOOLEAN
//   notifications.created_at   : TIMESTAMP
//   notifications.expires_at   : DATETIME NULL
//   — NO plaza_id column on notifications
//
// Import path from routes:
//   require("../controllers/adminnotificationontroller")
// ============================================================

const db = require("../utils/db");
const { AppError, asyncHandler } = require("../utils/errorhandler");

const MAX_TREND_DAYS = 90;
const DEFAULT_TREND_DAYS = 7;

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};
const isValidDate = (v) => v && !isNaN(Date.parse(v));

// ── Shared filter builder ─────────────────────────────────────
// Builds a WHERE clause from optional query params.
// Only columns that actually exist on notifications are used.
const buildWhereClause = ({ from, to, type, recipient_id }) => {
  const conditions = [];
  const params = [];

  if (from) {
    conditions.push("DATE(n.created_at) >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("DATE(n.created_at) <= ?");
    params.push(to);
  }
  if (type) {
    conditions.push("n.type = ?");
    params.push(type);
  }
  if (recipient_id) {
    const id = parseId(recipient_id);
    if (id) {
      conditions.push("n.recipient_id = ?");
      params.push(id);
    }
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
};

// ── Date validation ───────────────────────────────────────────
const validateDates = (from, to) => {
  if (from && !isValidDate(from))
    throw new AppError("Invalid 'from' date. Use YYYY-MM-DD", 400);
  if (to && !isValidDate(to))
    throw new AppError("Invalid 'to' date. Use YYYY-MM-DD", 400);
};

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/notifications/stats
// Overall notification counts with read rate breakdown.
// Filterable by type, recipient_id, and date range.
// Query params: type, recipient_id, from, to
// ═══════════════════════════════════════════════════════════════
const getNotificationStats = asyncHandler(async (req, res) => {
  const { from, to, type, recipient_id } = req.query;
  validateDates(from, to);

  const { whereClause, params } = buildWhereClause({
    from,
    to,
    type,
    recipient_id,
  });

  const [[stats]] = await db.execute(
    `SELECT
       COUNT(*)                                              AS total_notifications,
       SUM(n.is_read = 1)                                   AS total_read,
       SUM(n.is_read = 0)                                   AS total_unread,
       ROUND(
         (SUM(n.is_read = 1) / NULLIF(COUNT(*), 0)) * 100, 2
       )                                                     AS read_rate_percentage,
       COUNT(CASE WHEN n.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                  THEN 1 END)                               AS sent_last_24h,
       COUNT(CASE WHEN n.expires_at IS NOT NULL
                   AND n.expires_at < NOW()
                   AND n.is_read = 0 THEN 1 END)            AS expired_unread
     FROM notifications n
     ${whereClause}`,
    params,
  );

  return res.json({
    success: true,
    data: {
      total_notifications: stats.total_notifications ?? 0,
      total_read: stats.total_read ?? 0,
      total_unread: stats.total_unread ?? 0,
      read_rate_percentage: stats.read_rate_percentage ?? 0,
      sent_last_24h: stats.sent_last_24h ?? 0,
      expired_unread: stats.expired_unread ?? 0,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/notifications/daily-trend
// Daily notification volume over a time window.
// Used by the admin dashboard chart.
// Query params: days (1–90, default 7), from, to, type, recipient_id
// ═══════════════════════════════════════════════════════════════
const getDailyNotificationTrend = asyncHandler(async (req, res) => {
  const { from, to, type, recipient_id } = req.query;

  let rangeCondition = "";
  let rangeParams = [];

  if (from || to) {
    validateDates(from, to);
  } else {
    const days = Math.min(
      MAX_TREND_DAYS,
      Math.max(1, parseInt(req.query.days, 10) || DEFAULT_TREND_DAYS),
    );
    rangeCondition = "n.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)";
    rangeParams = [days];
  }

  const { whereClause, params } = buildWhereClause({
    from,
    to,
    type,
    recipient_id,
  });

  // Merge the range condition with any other filters
  let finalWhere = whereClause;
  let finalParams = [...params];

  if (rangeCondition) {
    const existing = whereClause ? whereClause.replace("WHERE ", "AND ") : "";
    finalWhere = `WHERE ${rangeCondition} ${existing}`;
    finalParams = [...rangeParams, ...params];
  }

  const [rows] = await db.execute(
    `SELECT
       DATE(n.created_at) AS date,
       COUNT(*)           AS total,
       SUM(n.is_read = 1) AS read_count,
       SUM(n.is_read = 0) AS unread_count
     FROM notifications n
     ${finalWhere}
     GROUP BY DATE(n.created_at)
     ORDER BY date ASC`,
    finalParams,
  );

  return res.json({
    success: true,
    data: rows.map((r) => ({
      date: r.date,
      total: r.total,
      read_count: r.read_count ?? 0,
      unread_count: r.unread_count ?? 0,
    })),
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/notifications/engagement
// Read rates and engagement breakdown per notification type.
// Query params: from, to, type, recipient_id
// ═══════════════════════════════════════════════════════════════
const getEngagementMetrics = asyncHandler(async (req, res) => {
  const { from, to, type, recipient_id } = req.query;
  validateDates(from, to);

  const { whereClause, params } = buildWhereClause({
    from,
    to,
    type,
    recipient_id,
  });

  // Per-type breakdown
  const [byType] = await db.execute(
    `SELECT
       n.type,
       COUNT(*)                                              AS total,
       SUM(n.is_read = 1)                                   AS read_count,
       SUM(n.is_read = 0)                                   AS unread_count,
       ROUND(
         (SUM(n.is_read = 1) / NULLIF(COUNT(*), 0)) * 100, 2
       )                                                     AS read_rate_percentage,
       ROUND(
         AVG(CASE WHEN n.is_read = 1
                  THEN TIMESTAMPDIFF(MINUTE, n.created_at, n.read_at)
             END), 1
       )                                                     AS avg_read_time_minutes
     FROM notifications n
     ${whereClause}
     GROUP BY n.type
     ORDER BY read_rate_percentage DESC`,
    params,
  );

  // Overall summary
  const [[summary]] = await db.execute(
    `SELECT
       COUNT(*)                                              AS total,
       SUM(n.is_read = 1)                                   AS total_read,
       ROUND(
         (SUM(n.is_read = 1) / NULLIF(COUNT(*), 0)) * 100, 2
       )                                                     AS overall_read_rate,
       ROUND(
         AVG(CASE WHEN n.is_read = 1
                  THEN TIMESTAMPDIFF(MINUTE, n.created_at, n.read_at)
             END), 1
       )                                                     AS avg_read_time_minutes
     FROM notifications n
     ${whereClause}`,
    params,
  );

  return res.json({
    success: true,
    data: {
      summary: {
        total: summary.total ?? 0,
        total_read: summary.total_read ?? 0,
        overall_read_rate: summary.overall_read_rate ?? 0,
        avg_read_time_minutes: summary.avg_read_time_minutes ?? null,
      },
      by_type: byType.map((r) => ({
        type: r.type,
        total: r.total,
        read_count: r.read_count ?? 0,
        unread_count: r.unread_count ?? 0,
        read_rate_percentage: r.read_rate_percentage ?? 0,
        avg_read_time_minutes: r.avg_read_time_minutes ?? null,
      })),
    },
  });
});

module.exports = {
  getNotificationStats,
  getDailyNotificationTrend,
  getEngagementMetrics,
};
