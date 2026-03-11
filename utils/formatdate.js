// formatDate.js
// ============================================================
// Date formatting utilities used across controllers,
// email templates, receipts, and API responses.
// All functions accept a Date object, ISO string, or timestamp.
// Returns null for invalid inputs — never throws.
// ============================================================

// ── isValidDate ──────────────────────────────────────────────
const isValidDate = (value) => {
  if (!value) return false;
  const date = new Date(value);
  return !isNaN(date.getTime());
};

// ── toDate ───────────────────────────────────────────────────
const toDate = (value) => {
  if (!isValidDate(value)) return null;
  return new Date(value);
};

// ── formatDate ───────────────────────────────────────────────
// Output: "18 February 2026"
// Usage : formatDate(payment.payment_date)
const formatDate = (value, locale = "en-GB") => {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

// ── formatShortDate ──────────────────────────────────────────
// Output: "18/02/2026"
// Usage : formatShortDate(lease.lease_start)
const formatShortDate = (value, locale = "en-GB") => {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

// ── formatDateTime ───────────────────────────────────────────
// Output: "18 February 2026, 14:35"
// Usage : formatDateTime(notification.created_at)
const formatDateTime = (value, locale = "en-GB") => {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

// ── formatTime ───────────────────────────────────────────────
// Output: "14:35"
// Usage : formatTime(message.created_at)
const formatTime = (value, locale = "en-GB") => {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

// ── toISODate ────────────────────────────────────────────────
// Output: "2026-02-18"
// Usage : toISODate(lease.lease_end) — for DB inserts/comparisons
const toISODate = (value) => {
  const date = toDate(value);
  if (!date) return null;
  return date.toISOString().split("T")[0];
};

// ── toISODateTime ────────────────────────────────────────────
// Output: "2026-02-18T14:35:00.000Z"
// Usage : API responses, logging timestamps
const toISODateTime = (value) => {
  const date = toDate(value);
  if (!date) return null;
  return date.toISOString();
};

// ── formatRelative ───────────────────────────────────────────
// Output: "just now", "5 minutes ago", "3 days ago"
// Usage : formatRelative(notification.created_at)
const formatRelative = (value) => {
  const date = toDate(value);
  if (!date) return null;

  const diffMs = Date.now() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffSecs < 10) return "just now";
  if (diffSecs < 60) return `${diffSecs} seconds ago`;
  if (diffMins === 1) return "1 minute ago";
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffWeeks === 1) return "1 week ago";
  if (diffWeeks < 4) return `${diffWeeks} weeks ago`;
  if (diffMonths === 1) return "1 month ago";
  if (diffMonths < 12) return `${diffMonths} months ago`;

  return formatDate(value); // fall back to full date for old entries
};

// ── getDaysUntil ─────────────────────────────────────────────
// Days from today to a future date. Negative = past.
// Usage: getDaysUntil(lease.lease_end) — lease expiry warnings
const getDaysUntil = (value) => {
  const date = toDate(value);
  if (!date) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - now.getTime()) / 86400000);
};

// ── getDaysSince ─────────────────────────────────────────────
// Days from a past date to today. Negative = future.
// Usage: getDaysSince(tenancy.created_at) — tenancy duration
const getDaysSince = (value) => {
  const days = getDaysUntil(value);
  return days !== null ? -days : null;
};

// ── isExpired ────────────────────────────────────────────────
// Usage: isExpired(lease.lease_end)
const isExpired = (value) => {
  const date = toDate(value);
  if (!date) return null;
  return date.getTime() < Date.now();
};

// ── isExpiringSoon ───────────────────────────────────────────
// Usage: isExpiringSoon(lease.lease_end, 30)
const isExpiringSoon = (value, days = 30) => {
  const daysUntil = getDaysUntil(value);
  if (daysUntil === null) return false;
  return daysUntil >= 0 && daysUntil <= days;
};

// ── getMonthName ─────────────────────────────────────────────
// Output: "February"
// Usage : getMonthName(payment.payment_date) — report headings
const getMonthName = (value, locale = "en-GB") => {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleDateString(locale, { month: "long" });
};

// ── formatMonthYear ──────────────────────────────────────────
// Output: "February 2026"
// Usage : formatMonthYear(payment.payment_date) — payment history grouping
const formatMonthYear = (value, locale = "en-GB") => {
  const date = toDate(value);
  if (!date) return null;
  return date.toLocaleDateString(locale, { month: "long", year: "numeric" });
};

// ── nowISO ───────────────────────────────────────────────────
// Output: "2026-02-18T14:35:00.000Z"
// Usage : nowISO() — timestamps in logs and receipts
const nowISO = () => new Date().toISOString();

// ── today ────────────────────────────────────────────────────
// Output: "2026-02-18"
// Usage : today() — DB date comparisons
const today = () => toISODate(new Date());

// ── getCurrentMonthRange ─────────────────────────────────────
// Returns { start, end } ISO dates for the current month.
// Usage: DB queries filtered to current month's payments
const getCurrentMonthRange = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start: toISODate(start), end: toISODate(end) };
};

// ── getMonthRange ────────────────────────────────────────────
// Returns { start, end } ISO dates for any given month/year.
// Usage: getMonthRange(2026, 2) → { start: "2026-02-01", end: "2026-02-28" }
const getMonthRange = (year, month) => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { start: toISODate(start), end: toISODate(end) };
};

// ── addDays ──────────────────────────────────────────────────
// Add N days to a date. Returns ISO date string.
// Usage: addDays(new Date(), 30) — invite code expiry
const addDays = (value, days) => {
  const date = toDate(value);
  if (!date) return null;
  date.setDate(date.getDate() + days);
  return toISODate(date);
};

// ── formatGhanaDateTime ──────────────────────────────────────
// Ghana timezone (GMT+0, no DST) formatted datetime.
// Output: "18 Feb 2026, 14:35 GMT"
// Usage : Receipt timestamps, email notifications
const formatGhanaDateTime = (value) => {
  const date = toDate(value);
  if (!date) return null;
  return (
    date.toLocaleString("en-GB", {
      timeZone: "Africa/Accra",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " GMT"
  );
};

module.exports = {
  // Formatters
  formatDate,
  formatShortDate,
  formatDateTime,
  formatTime,
  formatMonthYear,
  formatGhanaDateTime,
  getMonthName,

  // ISO helpers
  toISODate,
  toISODateTime,
  nowISO,
  today,

  // Range helpers
  getCurrentMonthRange,
  getMonthRange,
  addDays,

  // Relative
  formatRelative,

  // Calculations
  getDaysUntil,
  getDaysSince,

  // Checks
  isExpired,
  isExpiringSoon,
  isValidDate,
  toDate,
};
