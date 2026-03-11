// services/analyticsService.js
// ============================================================
// Analytics service — aggregated statistics for admin and
// landlord dashboards, reports pages, and charts.
//
// Uses schema views where available:
//   v_active_tenancies   — active leases with full context
//   v_payment_summary    — payment totals per tenancy
//   v_overdue_tenants    — no payment this month
//   v_expiring_leases    — expiring within 30 days
//
// Import path from controllers (backend/controllers/):
//   const AnalyticsService = require("../services/analyticsService");
//
// All utils live one level up from services/:
//   require("../utils/db")
//   require("../utils/errorHandler")   ← capital H
//   require("../utils/formatDate")
// ============================================================

const db = require("../utils/db");
const { AppError } = require("../utils/errorhandler");
const {
  getCurrentMonthRange,
  getMonthRange,
  toISODate,
} = require("../utils/formatdate");

const parseId = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? null : n;
};

class AnalyticsService {
  // ── getAdminOverview ────────────────────────────────────
  // Single call that returns all top-level numbers for
  // the admin dashboard: users, plazas, leases, revenue
  // this month, maintenance, invites.
  //
  // Usage:
  //   const stats = await AnalyticsService.getAdminOverview();
  static async getAdminOverview() {
    const { start, end } = getCurrentMonthRange();

    const [[users]] = await db.execute(
      `SELECT
         COUNT(*)                                      AS total_users,
         SUM(role = 'landlord')                        AS total_landlords,
         SUM(role = 'tenant')                          AS total_tenants,
         SUM(role = 'admin')                           AS total_admins,
         SUM(status = 'active'  AND deleted_at IS NULL) AS active_users,
         SUM(status = 'suspended')                     AS suspended_users,
         SUM(DATE(created_at)   = CURDATE())           AS registered_today
       FROM users
       WHERE deleted_at IS NULL`,
    );

    const [[plazas]] = await db.execute(
      `SELECT
         COUNT(*)                   AS total_plazas,
         COALESCE(SUM(total_units), 0) AS total_units
       FROM plazas
       WHERE deleted_at IS NULL`,
    );

    const [[leases]] = await db.execute(
      `SELECT
         COUNT(*)                    AS total_leases,
         SUM(status = 'active')      AS active_leases,
         SUM(status = 'expired')     AS expired_leases
       FROM tenancies`,
    );

    const [[revenue]] = await db.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'paid'    THEN amount ELSE 0 END), 0) AS collected_this_month,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pending_this_month,
         COALESCE(SUM(CASE WHEN status = 'failed'  THEN amount ELSE 0 END), 0) AS failed_this_month,
         COUNT(CASE WHEN status = 'paid'    THEN 1 END)                        AS paid_count,
         COUNT(CASE WHEN status = 'pending' THEN 1 END)                        AS pending_count,
         COUNT(CASE WHEN status = 'failed'  THEN 1 END)                        AS failed_count
       FROM payments
       WHERE payment_date BETWEEN ? AND ?`,
      [start, end],
    );

    const [[maintenance]] = await db.execute(
      `SELECT
         COUNT(*)                          AS total,
         SUM(status = 'pending')           AS pending,
         SUM(status = 'in_progress')       AS in_progress,
         SUM(status = 'resolved')          AS resolved,
         SUM(status = 'rejected')          AS rejected,
         SUM(priority = 'high'
           AND status NOT IN ('resolved','rejected')) AS open_high_priority
       FROM maintenance_requests`,
    );

    const [[invites]] = await db.execute(
      `SELECT
         COUNT(*)                    AS total,
         SUM(status = 'active')      AS active,
         SUM(status = 'used')        AS used,
         SUM(status = 'expired')     AS expired,
         SUM(status = 'revoked')     AS revoked
       FROM invite_codes`,
    );

    const [[overdue]] = await db.execute(
      `SELECT COUNT(*) AS overdue_count FROM v_overdue_tenants`,
    );

    const [[expiring]] = await db.execute(
      `SELECT COUNT(*) AS expiring_count FROM v_expiring_leases`,
    );

    return {
      users: { ...users },
      plazas: { ...plazas },
      leases: { ...leases },
      revenue: { ...revenue, period: `${start} → ${end}` },
      maintenance: { ...maintenance },
      invites: { ...invites },
      alerts: {
        overdue_tenants: overdue.overdue_count,
        expiring_leases: expiring.expiring_count,
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ── getLandlordOverview ─────────────────────────────────
  // Dashboard stats for a specific landlord.
  // Covers plazas, tenants, this month's revenue,
  // overdue tenants, expiring leases, open maintenance.
  //
  // Usage:
  //   const stats = await AnalyticsService.getLandlordOverview(req.user.id);
  static async getLandlordOverview(landlordId) {
    const lid = parseId(landlordId);
    if (!lid) throw new AppError("Invalid landlord ID", 400);

    const { start, end } = getCurrentMonthRange();

    const [[plazas]] = await db.execute(
      `SELECT
         COUNT(*)                          AS total_plazas,
         COALESCE(SUM(total_units), 0)     AS total_units
       FROM plazas
       WHERE landlord_id = ? AND deleted_at IS NULL`,
      [lid],
    );

    const [[leases]] = await db.execute(
      `SELECT
         COUNT(*)                             AS total_tenants,
         SUM(t.status = 'active')             AS active_tenants,
         SUM(t.status = 'expired')            AS expired_tenants,
         COALESCE(SUM(t.rent_amount), 0)      AS total_monthly_rent
       FROM tenancies t
       JOIN plazas p ON p.id = t.plaza_id
       WHERE p.landlord_id = ?`,
      [lid],
    );

    const [[revenue]] = await db.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN py.status = 'paid'    THEN py.amount ELSE 0 END), 0) AS collected_this_month,
         COALESCE(SUM(CASE WHEN py.status = 'pending' THEN py.amount ELSE 0 END), 0) AS pending_this_month,
         COUNT(CASE WHEN py.status = 'paid'    THEN 1 END)                           AS paid_count,
         COUNT(CASE WHEN py.status = 'failed'  THEN 1 END)                           AS failed_count
       FROM payments py
       JOIN tenancies t  ON t.id  = py.tenancy_id
       JOIN plazas    p  ON p.id  = t.plaza_id
       WHERE p.landlord_id = ?
         AND py.payment_date BETWEEN ? AND ?`,
      [lid, start, end],
    );

    const [[maintenance]] = await db.execute(
      `SELECT
         COUNT(*)                    AS total,
         SUM(m.status = 'pending')   AS pending,
         SUM(m.status = 'in_progress') AS in_progress,
         SUM(m.status = 'resolved')  AS resolved,
         SUM(m.priority = 'high'
           AND m.status NOT IN ('resolved','rejected')) AS open_high_priority
       FROM maintenance_requests m
       JOIN plazas p ON p.id = m.plaza_id
       WHERE p.landlord_id = ?`,
      [lid],
    );

    const [[overdue]] = await db.execute(
      `SELECT COUNT(*) AS overdue_count
       FROM v_overdue_tenants
       WHERE landlord_id = ?`,
      [lid],
    );

    const [[expiring]] = await db.execute(
      `SELECT COUNT(*) AS expiring_count
       FROM v_expiring_leases
       WHERE landlord_id = ?`,
      [lid],
    );

    return {
      plazas: { ...plazas },
      leases: { ...leases },
      revenue: { ...revenue, period: `${start} → ${end}` },
      maintenance: { ...maintenance },
      alerts: {
        overdue_tenants: overdue.overdue_count,
        expiring_leases: expiring.expiring_count,
      },
      generated_at: new Date().toISOString(),
    };
  }

  // ── getRevenueByMonth ───────────────────────────────────
  // Monthly revenue totals for the last N months.
  // Optionally scoped to a specific landlord.
  // Used for the revenue trend line/bar chart.
  //
  // Usage:
  //   const data = await AnalyticsService.getRevenueByMonth(6, landlordId);
  static async getRevenueByMonth(months = 6, landlordId = null) {
    const safeMonths = Math.min(24, parseInt(months, 10) || 6);

    let JOIN = "";
    let EXTRA = "py.status = 'paid'";

    if (landlordId && parseId(landlordId)) {
      JOIN =
        "JOIN tenancies t ON t.id = py.tenancy_id JOIN plazas p ON p.id = t.plaza_id";
      EXTRA = `py.status = 'paid' AND p.landlord_id = ${parseId(landlordId)}`;
    }

    const [rows] = await db.execute(
      `SELECT
         DATE_FORMAT(py.payment_date, '%Y-%m')   AS month,
         DATE_FORMAT(py.payment_date, '%b %Y')   AS month_label,
         COALESCE(SUM(py.amount), 0)             AS total_collected,
         COUNT(*)                                AS payment_count,
         COUNT(DISTINCT py.tenancy_id)           AS active_tenants_paying
       FROM payments py ${JOIN}
       WHERE ${EXTRA}
         AND py.payment_date >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
       GROUP BY DATE_FORMAT(py.payment_date, '%Y-%m')
       ORDER BY month ASC`,
      [safeMonths],
    );

    return rows;
  }

  // ── getRevenueByPlaza ───────────────────────────────────
  // Total collected vs pending per plaza for a landlord.
  // Used for the per-plaza breakdown chart.
  //
  // Usage:
  //   const data = await AnalyticsService.getRevenueByPlaza(landlordId);
  static async getRevenueByPlaza(landlordId) {
    const lid = parseId(landlordId);
    if (!lid) throw new AppError("Invalid landlord ID", 400);

    const { start, end } = getCurrentMonthRange();

    const [rows] = await db.execute(
      `SELECT
         p.id           AS plaza_id,
         p.name         AS plaza_name,
         p.location,
         p.total_units,
         COUNT(DISTINCT CASE WHEN t.status = 'active' THEN t.id END) AS occupied_units,
         COALESCE(SUM(CASE WHEN py.status = 'paid'
                            AND py.payment_date BETWEEN ? AND ?
                           THEN py.amount END), 0)                   AS collected_this_month,
         COALESCE(SUM(CASE WHEN py.status = 'pending' THEN py.amount END), 0) AS total_pending,
         COALESCE(SUM(CASE WHEN py.status = 'paid'   THEN py.amount END), 0)  AS total_all_time
       FROM plazas p
       LEFT JOIN tenancies t  ON t.plaza_id    = p.id
       LEFT JOIN payments  py ON py.tenancy_id = t.id
       WHERE p.landlord_id = ? AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY collected_this_month DESC`,
      [start, end, lid],
    );

    return rows;
  }

  // ── getPaymentTrend ─────────────────────────────────────
  // Daily payment totals for the last N days.
  // Breaks down collected vs pending per day.
  // Used for the area/line chart on the payments page.
  //
  // Usage:
  //   const data = await AnalyticsService.getPaymentTrend(30, landlordId);
  static async getPaymentTrend(days = 30, landlordId = null) {
    const safeDays = Math.min(90, parseInt(days, 10) || 30);

    let JOIN = "";
    let EXTRA = "";

    if (landlordId && parseId(landlordId)) {
      JOIN =
        "JOIN tenancies t ON t.id = py.tenancy_id JOIN plazas p ON p.id = t.plaza_id";
      EXTRA = `AND p.landlord_id = ${parseId(landlordId)}`;
    }

    const [rows] = await db.execute(
      `SELECT
         DATE(py.payment_date)                                               AS date,
         COALESCE(SUM(CASE WHEN py.status = 'paid'    THEN py.amount END), 0) AS collected,
         COALESCE(SUM(CASE WHEN py.status = 'pending' THEN py.amount END), 0) AS pending,
         COALESCE(SUM(CASE WHEN py.status = 'failed'  THEN py.amount END), 0) AS failed,
         COUNT(*)                                                              AS transactions
       FROM payments py ${JOIN}
       WHERE py.payment_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${EXTRA}
       GROUP BY DATE(py.payment_date)
       ORDER BY date ASC`,
      [safeDays],
    );

    return rows;
  }

  // ── getPaymentMethodBreakdown ───────────────────────────
  // Count and total amount per payment method (card, momo, bank).
  // Used for the pie/donut chart on the payments reports page.
  //
  // Usage:
  //   const data = await AnalyticsService.getPaymentMethodBreakdown(landlordId);
  static async getPaymentMethodBreakdown(landlordId = null) {
    let JOIN = "";
    let WHERE = "py.status = 'paid'";

    if (landlordId && parseId(landlordId)) {
      JOIN =
        "JOIN tenancies t ON t.id = py.tenancy_id JOIN plazas p ON p.id = t.plaza_id";
      WHERE = `py.status = 'paid' AND p.landlord_id = ${parseId(landlordId)}`;
    }

    const [rows] = await db.execute(
      `SELECT
         py.payment_method,
         COUNT(*)               AS transaction_count,
         COALESCE(SUM(py.amount), 0) AS total_amount,
         ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS percentage
       FROM payments py ${JOIN}
       WHERE ${WHERE}
       GROUP BY py.payment_method
       ORDER BY total_amount DESC`,
    );

    return rows;
  }

  // ── getOccupancyRate ────────────────────────────────────
  // Occupied vs total units per plaza with occupancy %.
  // Used for the plaza occupancy cards/chart.
  //
  // Usage:
  //   const data = await AnalyticsService.getOccupancyRate(landlordId);
  static async getOccupancyRate(landlordId) {
    const lid = parseId(landlordId);
    if (!lid) throw new AppError("Invalid landlord ID", 400);

    const [rows] = await db.execute(
      `SELECT
         p.id                  AS plaza_id,
         p.name                AS plaza_name,
         p.location,
         p.total_units,
         COUNT(CASE WHEN t.status = 'active' THEN 1 END) AS occupied_units,
         p.total_units - COUNT(CASE WHEN t.status = 'active' THEN 1 END) AS vacant_units,
         ROUND(
           COUNT(CASE WHEN t.status = 'active' THEN 1 END) * 100.0
           / NULLIF(p.total_units, 0),
           1
         )                     AS occupancy_rate_pct
       FROM plazas p
       LEFT JOIN tenancies t ON t.plaza_id = p.id
       WHERE p.landlord_id = ? AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY occupancy_rate_pct DESC`,
      [lid],
    );

    return rows;
  }

  // ── getMaintenanceStats ─────────────────────────────────
  // Breakdown by status and priority.
  // Includes average resolution time in hours.
  // Optional landlord scope.
  //
  // Usage:
  //   const stats = await AnalyticsService.getMaintenanceStats(landlordId);
  static async getMaintenanceStats(landlordId = null) {
    let JOIN = "";
    let WHERE = "1 = 1";

    if (landlordId && parseId(landlordId)) {
      JOIN = "JOIN plazas p ON p.id = m.plaza_id";
      WHERE = `p.landlord_id = ${parseId(landlordId)}`;
    }

    const [[byStatus]] = await db.execute(
      `SELECT
         COUNT(*)                          AS total,
         SUM(m.status = 'pending')         AS pending,
         SUM(m.status = 'in_progress')     AS in_progress,
         SUM(m.status = 'resolved')        AS resolved,
         SUM(m.status = 'rejected')        AS rejected
       FROM maintenance_requests m ${JOIN}
       WHERE ${WHERE}`,
    );

    const [[byPriority]] = await db.execute(
      `SELECT
         SUM(m.priority = 'high'   AND m.status NOT IN ('resolved','rejected')) AS open_high,
         SUM(m.priority = 'medium' AND m.status NOT IN ('resolved','rejected')) AS open_medium,
         SUM(m.priority = 'low'    AND m.status NOT IN ('resolved','rejected')) AS open_low,
         SUM(m.priority = 'high')   AS total_high,
         SUM(m.priority = 'medium') AS total_medium,
         SUM(m.priority = 'low')    AS total_low
       FROM maintenance_requests m ${JOIN}
       WHERE ${WHERE}`,
    );

    const [[resolution]] = await db.execute(
      `SELECT
         ROUND(AVG(TIMESTAMPDIFF(HOUR, m.created_at, m.resolved_at)), 1) AS avg_resolution_hours,
         MIN(TIMESTAMPDIFF(HOUR, m.created_at, m.resolved_at))           AS min_resolution_hours,
         MAX(TIMESTAMPDIFF(HOUR, m.created_at, m.resolved_at))           AS max_resolution_hours
       FROM maintenance_requests m ${JOIN}
       WHERE ${WHERE}
         AND m.status      = 'resolved'
         AND m.resolved_at IS NOT NULL`,
    );

    // Monthly trend (last 6 months)
    const [monthlyTrend] = await db.execute(
      `SELECT
         DATE_FORMAT(m.created_at, '%Y-%m')  AS month,
         DATE_FORMAT(m.created_at, '%b %Y')  AS month_label,
         COUNT(*)                            AS submitted,
         SUM(m.status = 'resolved')          AS resolved
       FROM maintenance_requests m ${JOIN}
       WHERE ${WHERE}
         AND m.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY DATE_FORMAT(m.created_at, '%Y-%m')
       ORDER BY month ASC`,
    );

    return {
      by_status: { ...byStatus },
      by_priority: { ...byPriority },
      resolution: { ...resolution },
      monthly_trend: monthlyTrend,
    };
  }

  // ── getUserGrowth ───────────────────────────────────────
  // Daily new registrations for the last N days.
  // Broken down by role (tenant / landlord).
  // Used for the user growth line chart on the admin reports page.
  //
  // Usage:
  //   const data = await AnalyticsService.getUserGrowth(30);
  static async getUserGrowth(days = 30) {
    const safeDays = Math.min(90, parseInt(days, 10) || 30);

    const [rows] = await db.execute(
      `SELECT
         DATE(created_at)         AS date,
         COUNT(*)                 AS total_new,
         SUM(role = 'tenant')     AS new_tenants,
         SUM(role = 'landlord')   AS new_landlords
       FROM users
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         AND deleted_at IS NULL
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [safeDays],
    );

    return rows;
  }

  // ── getTopLandlords ─────────────────────────────────────
  // Admin — landlords ranked by revenue collected this month
  // and all time. Used on the admin reports leaderboard.
  //
  // Usage:
  //   const data = await AnalyticsService.getTopLandlords(10);
  static async getTopLandlords(limit = 10) {
    const safeLimit = Math.min(50, parseInt(limit, 10) || 10);
    const { start, end } = getCurrentMonthRange();

    const [rows] = await db.execute(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.avatar_url,
         u.created_at         AS member_since,
         COUNT(DISTINCT p.id) AS plaza_count,
         COUNT(DISTINCT t.id) AS tenant_count,
         COALESCE(SUM(
           CASE WHEN py.status = 'paid'
                 AND py.payment_date BETWEEN ? AND ?
           THEN py.amount END
         ), 0)                AS revenue_this_month,
         COALESCE(SUM(
           CASE WHEN py.status = 'paid'
           THEN py.amount END
         ), 0)                AS revenue_all_time
       FROM users u
       LEFT JOIN plazas    p  ON p.landlord_id  = u.id AND p.deleted_at IS NULL
       LEFT JOIN tenancies t  ON t.plaza_id      = p.id
       LEFT JOIN payments  py ON py.tenancy_id   = t.id
       WHERE u.role       = 'landlord'
         AND u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY revenue_this_month DESC
       LIMIT ?`,
      [start, end, safeLimit],
    );

    return rows;
  }

  // ── getInviteCodeStats ──────────────────────────────────
  // Invite code usage breakdown — total, used, expired, active.
  // Optionally scoped to a landlord.
  // Used on the invite codes management page.
  //
  // Usage:
  //   const stats = await AnalyticsService.getInviteCodeStats(landlordId);
  static async getInviteCodeStats(landlordId = null) {
    const WHERE =
      landlordId && parseId(landlordId)
        ? `WHERE landlord_id = ${parseId(landlordId)}`
        : "";

    const [[stats]] = await db.execute(
      `SELECT
         COUNT(*)                    AS total,
         SUM(status = 'active')      AS active,
         SUM(status = 'used')        AS used,
         SUM(status = 'expired')     AS expired,
         SUM(status = 'revoked')     AS revoked,
         SUM(used_count > 0)         AS ever_claimed
       FROM invite_codes ${WHERE}`,
    );

    // Usage trend last 30 days
    const TREND_WHERE =
      landlordId && parseId(landlordId)
        ? `AND landlord_id = ${parseId(landlordId)}`
        : "";

    const [trend] = await db.execute(
      `SELECT
         DATE(created_at)       AS date,
         COUNT(*)               AS created,
         SUM(status = 'used')   AS claimed
       FROM invite_codes
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ${TREND_WHERE}
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
    );

    return { ...stats, trend };
  }

  // ── getLateFeeStats ─────────────────────────────────────
  // Late fee summary — pending vs paid totals.
  // Optionally scoped to a landlord.
  //
  // Usage:
  //   const stats = await AnalyticsService.getLateFeeStats(landlordId);
  static async getLateFeeStats(landlordId = null) {
    let JOIN = "";
    let WHERE = "1 = 1";

    if (landlordId && parseId(landlordId)) {
      JOIN =
        "JOIN tenancies t ON t.id = lf.tenancy_id JOIN plazas p ON p.id = t.plaza_id";
      WHERE = `p.landlord_id = ${parseId(landlordId)}`;
    }

    const [[stats]] = await db.execute(
      `SELECT
         COUNT(*)                                          AS total_fees,
         SUM(lf.status = 'pending')                       AS pending_count,
         SUM(lf.status = 'paid')                          AS paid_count,
         COALESCE(SUM(CASE WHEN lf.status = 'pending' THEN lf.amount END), 0) AS pending_amount,
         COALESCE(SUM(CASE WHEN lf.status = 'paid'    THEN lf.amount END), 0) AS collected_amount
       FROM late_fees lf ${JOIN}
       WHERE ${WHERE}`,
    );

    return stats;
  }

  // ── getSystemHealth ─────────────────────────────────────
  // Admin — row counts for every table + error indicators
  // from email_logs and push_logs in the last 24 hours.
  // Used on the admin system-health page.
  //
  // Usage:
  //   const health = await AnalyticsService.getSystemHealth();
  static async getSystemHealth() {
    const tables = [
      "users",
      "plazas",
      "invite_codes",
      "tenancies",
      "payments",
      "receipts",
      "late_fees",
      "maintenance_requests",
      "messages",
      "notifications",
      "activity_logs",
      "device_tokens",
      "push_logs",
      "email_logs",
    ];

    const rowCounts = {};
    for (const table of tables) {
      const [[row]] = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
      rowCounts[table] = Number(row.n);
    }

    const [[emailErrors]] = await db.execute(
      `SELECT COUNT(*) AS failed_emails
       FROM email_logs
       WHERE status = 'failed'
         AND sent_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );

    const [[pushErrors]] = await db.execute(
      `SELECT COUNT(*) AS failed_pushes
       FROM push_logs
       WHERE status = 'failed'
         AND sent_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );

    const [[failedPayments]] = await db.execute(
      `SELECT COUNT(*) AS failed_payments
       FROM payments
       WHERE status = 'failed'
         AND payment_date >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );

    const [[suspendedUsers]] = await db.execute(
      `SELECT COUNT(*) AS suspended_users
       FROM users WHERE status = 'suspended'`,
    );

    return {
      row_counts: rowCounts,
      last_24h: {
        failed_emails: emailErrors.failed_emails,
        failed_pushes: pushErrors.failed_pushes,
        failed_payments: failedPayments.failed_payments,
      },
      flags: {
        suspended_users: suspendedUsers.suspended_users,
      },
      checked_at: new Date().toISOString(),
    };
  }

  // ── getMonthlyReport ───────────────────────────────────
  // Full monthly report for a landlord covering a specific
  // year/month. Used by the landlord reports page.
  //
  // Usage:
  //   const report = await AnalyticsService.getMonthlyReport(landlordId, 2026, 3);
  static async getMonthlyReport(landlordId, year, month) {
    const lid = parseId(landlordId);
    if (!lid) throw new AppError("Invalid landlord ID", 400);

    const safeYear = parseInt(year, 10) || new Date().getFullYear();
    const safeMonth = parseInt(month, 10) || new Date().getMonth() + 1;
    const { start, end } = getMonthRange(safeYear, safeMonth);

    // Revenue
    const [[revenue]] = await db.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN py.status = 'paid'    THEN py.amount END), 0) AS collected,
         COALESCE(SUM(CASE WHEN py.status = 'pending' THEN py.amount END), 0) AS pending,
         COALESCE(SUM(CASE WHEN py.status = 'failed'  THEN py.amount END), 0) AS failed,
         COUNT(*)                                                              AS total_transactions
       FROM payments py
       JOIN tenancies t ON t.id  = py.tenancy_id
       JOIN plazas    p ON p.id  = t.plaza_id
       WHERE p.landlord_id     = ?
         AND py.payment_date BETWEEN ? AND ?`,
      [lid, start, end],
    );

    // Per-payment breakdown
    const [payments] = await db.execute(
      `SELECT
         py.id, py.amount, py.status, py.payment_method,
         py.reference, py.payment_date,
         t.unit_number,
         p.name          AS plaza_name,
         u.full_name     AS tenant_name,
         u.email         AS tenant_email
       FROM payments py
       JOIN tenancies t ON t.id  = py.tenancy_id
       JOIN plazas    p ON p.id  = t.plaza_id
       JOIN users     u ON u.id  = t.tenant_id
       WHERE p.landlord_id     = ?
         AND py.payment_date BETWEEN ? AND ?
       ORDER BY py.payment_date DESC`,
      [lid, start, end],
    );

    // New tenants this month
    const [[newTenants]] = await db.execute(
      `SELECT COUNT(*) AS count
       FROM tenancies t
       JOIN plazas p ON p.id = t.plaza_id
       WHERE p.landlord_id = ?
         AND DATE(t.created_at) BETWEEN ? AND ?`,
      [lid, start, end],
    );

    // Maintenance submitted this month
    const [[newMaintenance]] = await db.execute(
      `SELECT COUNT(*) AS count,
              SUM(m.status = 'resolved') AS resolved
       FROM maintenance_requests m
       JOIN plazas p ON p.id = m.plaza_id
       WHERE p.landlord_id = ?
         AND DATE(m.created_at) BETWEEN ? AND ?`,
      [lid, start, end],
    );

    return {
      period: { year: safeYear, month: safeMonth, start, end },
      revenue: { ...revenue },
      payments,
      new_tenants: newTenants.count,
      maintenance: { ...newMaintenance },
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = AnalyticsService;
