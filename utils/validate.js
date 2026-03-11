// validate.js
// ============================================================
// Shared validation utilities used across controllers and models
// All validators return { isValid: boolean, errors: object }
// ============================================================

// ── Enums — must match rentms_full_schema.sql exactly ───────
const VALID_ROLES = ["tenant", "landlord", "admin"];
const VALID_PAYMENT_METHODS = ["card", "momo", "bank"]; // schema ENUM
const VALID_MOMO_PROVIDERS = ["MTN", "Vodafone", "AirtelTigo"]; // schema ENUM
const VALID_PAYMENT_STATUSES = ["paid", "pending", "failed"]; // schema ENUM
const VALID_TENANCY_STATUSES = ["active", "expired"]; // schema ENUM
const VALID_MAINTENANCE_PRIORITIES = ["low", "medium", "high"];
const VALID_MAINTENANCE_STATUSES = [
  "pending",
  "in_progress",
  "resolved",
  "rejected",
]; // schema ENUM
const VALID_USER_STATUSES = ["active", "suspended", "blacklisted"];
const VALID_INVITE_STATUSES = ["active", "used", "expired", "revoked"];
const VALID_RECEIPT_TYPES = ["rent", "deposit", "other"];
const VALID_DELIVERY_CHANNELS = ["in_app", "email", "push"];
const MIN_PASSWORD_LENGTH = 8;

// ── isEmpty ──────────────────────────────────────────────────
const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

// ── validateRequired ─────────────────────────────────────────
const validateRequired = (fields) => {
  const errors = {};
  for (const key in fields) {
    if (isEmpty(fields[key])) errors[key] = `${key} is required`;
  }
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateEmail ────────────────────────────────────────────
const validateEmail = (email) => {
  const errors = {};
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (isEmpty(email)) errors.email = "Email is required";
  else if (typeof email !== "string") errors.email = "Email must be a string";
  else if (!emailRegex.test(email.trim()))
    errors.email = "Invalid email format";
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validatePassword ─────────────────────────────────────────
// Min 8 chars, uppercase, lowercase, number, special char
const validatePassword = (password) => {
  const errors = {};
  const passwordRegex =
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()\-_=+]).{8,}$/;
  if (isEmpty(password)) errors.password = "Password is required";
  else if (typeof password !== "string")
    errors.password = "Password must be a string";
  else if (password.length < MIN_PASSWORD_LENGTH)
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  else if (!passwordRegex.test(password))
    errors.password =
      "Password must include uppercase, lowercase, a number, and a special character";
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateId ───────────────────────────────────────────────
const validateId = (id, fieldName = "id") => {
  const errors = {};
  const parsed = parseInt(id, 10);
  if (isEmpty(id)) errors[fieldName] = `${fieldName} is required`;
  else if (isNaN(parsed) || parsed <= 0)
    errors[fieldName] = `${fieldName} must be a valid positive numeric ID`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateArray ────────────────────────────────────────────
const validateArray = (arr, fieldName = "value") => {
  const errors = {};
  if (!Array.isArray(arr)) errors[fieldName] = `${fieldName} must be an array`;
  else if (arr.length === 0)
    errors[fieldName] = `${fieldName} must be a non-empty array`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateRole ─────────────────────────────────────────────
const validateRole = (role) => {
  const errors = {};
  if (isEmpty(role)) errors.role = "Role is required";
  else if (!VALID_ROLES.includes(role))
    errors.role = `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateUserStatus ───────────────────────────────────────
const validateUserStatus = (status) => {
  const errors = {};
  if (isEmpty(status)) errors.status = "Status is required";
  else if (!VALID_USER_STATUSES.includes(status))
    errors.status = `Invalid status. Must be one of: ${VALID_USER_STATUSES.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateAmount ───────────────────────────────────────────
const validateAmount = (amount, fieldName = "amount") => {
  const errors = {};
  const parsed = parseFloat(amount);
  if (isEmpty(amount) && amount !== 0)
    errors[fieldName] = `${fieldName} is required`;
  else if (isNaN(parsed) || parsed <= 0)
    errors[fieldName] = `${fieldName} must be a positive number`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validatePaymentMethod ────────────────────────────────────
// Schema ENUM: 'card','momo','bank'
const validatePaymentMethod = (method) => {
  const errors = {};
  if (isEmpty(method)) errors.payment_method = "Payment method is required";
  else if (!VALID_PAYMENT_METHODS.includes(method))
    errors.payment_method = `Invalid payment method. Must be one of: ${VALID_PAYMENT_METHODS.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateMomoProvider ─────────────────────────────────────
const validateMomoProvider = (provider) => {
  const errors = {};
  if (isEmpty(provider)) errors.momo_provider = "MoMo provider is required";
  else if (!VALID_MOMO_PROVIDERS.includes(provider))
    errors.momo_provider = `Invalid provider. Must be one of: ${VALID_MOMO_PROVIDERS.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validatePaymentStatus ────────────────────────────────────
// Schema ENUM: 'paid','pending','failed'
const validatePaymentStatus = (status) => {
  const errors = {};
  if (isEmpty(status)) errors.status = "Payment status is required";
  else if (!VALID_PAYMENT_STATUSES.includes(status))
    errors.status = `Invalid status. Must be one of: ${VALID_PAYMENT_STATUSES.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateTenancyStatus ────────────────────────────────────
// Schema ENUM: 'active','expired'
const validateTenancyStatus = (status) => {
  const errors = {};
  if (isEmpty(status)) errors.status = "Tenancy status is required";
  else if (!VALID_TENANCY_STATUSES.includes(status))
    errors.status = `Invalid tenancy status. Must be one of: ${VALID_TENANCY_STATUSES.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateInviteStatus ─────────────────────────────────────
const validateInviteStatus = (status) => {
  const errors = {};
  if (isEmpty(status)) errors.status = "Invite status is required";
  else if (!VALID_INVITE_STATUSES.includes(status))
    errors.status = `Invalid invite status. Must be one of: ${VALID_INVITE_STATUSES.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateMaintenancePriority ──────────────────────────────
const validateMaintenancePriority = (priority) => {
  const errors = {};
  if (isEmpty(priority)) errors.priority = "Priority is required";
  else if (!VALID_MAINTENANCE_PRIORITIES.includes(priority))
    errors.priority = `Invalid priority. Must be one of: ${VALID_MAINTENANCE_PRIORITIES.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateMaintenanceStatus ────────────────────────────────
// Schema ENUM: 'pending','in_progress','resolved','rejected'
const validateMaintenanceStatus = (status) => {
  const errors = {};
  if (isEmpty(status)) errors.status = "Status is required";
  else if (!VALID_MAINTENANCE_STATUSES.includes(status))
    errors.status = `Invalid status. Must be one of: ${VALID_MAINTENANCE_STATUSES.join(", ")}`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateDate ─────────────────────────────────────────────
const validateDate = (value, fieldName = "date") => {
  const errors = {};
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (isEmpty(value)) errors[fieldName] = `${fieldName} is required`;
  else if (!dateRegex.test(value) || isNaN(Date.parse(value)))
    errors[fieldName] =
      `${fieldName} must be a valid date in YYYY-MM-DD format`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateDateRange ────────────────────────────────────────
const validateDateRange = (startDate, endDate) => {
  const errors = {};
  const start = validateDate(startDate, "start_date");
  const end = validateDate(endDate, "end_date");
  if (!start.isValid) Object.assign(errors, start.errors);
  if (!end.isValid) Object.assign(errors, end.errors);
  if (start.isValid && end.isValid && new Date(endDate) <= new Date(startDate))
    errors.end_date = "end_date must be after start_date";
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validatePagination ───────────────────────────────────────
const validatePagination = ({ page, limit } = {}) => {
  const errors = {};
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  if (page !== undefined && (isNaN(parsedPage) || parsedPage < 1))
    errors.page = "page must be a positive integer";
  if (
    limit !== undefined &&
    (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)
  )
    errors.limit = "limit must be between 1 and 100";
  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    page: isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage,
    limit:
      isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 100),
  };
};

// ── validatePhone ────────────────────────────────────────────
// Ghana phone numbers: 10 digits starting with 0, or +233 format
const validatePhone = (phone, fieldName = "phone") => {
  const errors = {};
  const ghanaRegex = /^(?:\+233|0)[235][0-9]{8}$/;
  if (isEmpty(phone)) errors[fieldName] = `${fieldName} is required`;
  else if (!ghanaRegex.test(phone.trim()))
    errors[fieldName] =
      `${fieldName} must be a valid Ghana phone number (e.g. 0244000000)`;
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateUsername ─────────────────────────────────────────
// 3–50 chars, alphanumeric + underscore only
const validateUsername = (username) => {
  const errors = {};
  const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;
  if (isEmpty(username)) errors.username = "Username is required";
  else if (!usernameRegex.test(username.trim()))
    errors.username =
      "Username must be 3–50 characters, letters, numbers, or underscores only";
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── validateInviteCode ───────────────────────────────────────
// Codes are 8 hex chars uppercase e.g. "A1B2C3D4"
const validateInviteCode = (code) => {
  const errors = {};
  const codeRegex = /^[A-F0-9]{8}$/;
  if (isEmpty(code)) errors.code = "Invite code is required";
  else if (!codeRegex.test(code.trim()))
    errors.code = "Invalid invite code format";
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── mergeErrors ──────────────────────────────────────────────
const mergeErrors = (...results) => {
  const errors = {};
  for (const result of results) Object.assign(errors, result.errors);
  return { isValid: Object.keys(errors).length === 0, errors };
};

// ── Exports ──────────────────────────────────────────────────
module.exports = {
  // Core
  isEmpty,
  validateRequired,
  validateEmail,
  validatePassword,
  validateId,
  validateArray,
  validatePhone,
  validateUsername,
  validateInviteCode,

  // Domain-specific
  validateRole,
  validateUserStatus,
  validateAmount,
  validatePaymentMethod,
  validateMomoProvider,
  validatePaymentStatus,
  validateTenancyStatus,
  validateInviteStatus,
  validateMaintenancePriority,
  validateMaintenanceStatus,
  validateDate,
  validateDateRange,
  validatePagination,

  // Utility
  mergeErrors,

  // Constants
  VALID_ROLES,
  VALID_PAYMENT_METHODS,
  VALID_MOMO_PROVIDERS,
  VALID_PAYMENT_STATUSES,
  VALID_TENANCY_STATUSES,
  VALID_MAINTENANCE_PRIORITIES,
  VALID_MAINTENANCE_STATUSES,
  VALID_USER_STATUSES,
  VALID_INVITE_STATUSES,
  VALID_RECEIPT_TYPES,
  VALID_DELIVERY_CHANNELS,
};
