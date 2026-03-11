// config/constants.js
// ============================================================
// Schema-aligned constants (rentms_full_schema.sql v2.0).
// Import only what's needed — don't use these as substitutes
// for the inline validation arrays in models/controllers that
// need to validate against DB ENUMs directly.
//
// IMPORTANT — schema alignment notes:
//   ROLES       : 'landlord' | 'tenant' | 'admin'  (no super_admin)
//   USER_STATUS : 'active' | 'suspended' | 'blacklisted'  (no inactive)
//   TENANCY_STATUS  : 'active' | 'expired'  (no terminated)
//   PAYMENT_METHODS : 'card' | 'momo' | 'bank'  (schema ENUM)
//   PAYMENT_STATUS  : 'paid' | 'pending' | 'failed'
//   MAINTENANCE_STATUS  : 'pending' | 'in_progress' | 'resolved' | 'rejected'
//                         (no cancelled — schema uses rejected)
//   MAINTENANCE_PRIORITY: 'low' | 'medium' | 'high'
// ============================================================

const ROLES = {
  ADMIN: "admin",
  LANDLORD: "landlord",
  TENANT: "tenant",
};

const USER_STATUS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  BLACKLISTED: "blacklisted",
};

const TENANCY_STATUS = {
  ACTIVE: "active",
  EXPIRED: "expired",
};

// Schema ENUM: ENUM('card','momo','bank')
const PAYMENT_METHODS = {
  CARD: "card",
  MOMO: "momo",
  BANK: "bank",
};

const PAYMENT_STATUS = {
  PAID: "paid",
  PENDING: "pending",
  FAILED: "failed",
};

// Schema ENUM: 'pending'|'in_progress'|'resolved'|'rejected'
const MAINTENANCE_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  RESOLVED: "resolved",
  REJECTED: "rejected",
};

const MAINTENANCE_PRIORITY = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

const RECEIPT_TYPES = {
  RENT: "rent",
  DEPOSIT: "deposit",
  OTHER: "other",
};

const DELIVERY_CHANNELS = {
  IN_APP: "in_app",
  EMAIL: "email",
  PUSH: "push",
};

module.exports = {
  ROLES,
  USER_STATUS,
  TENANCY_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  MAINTENANCE_STATUS,
  MAINTENANCE_PRIORITY,
  RECEIPT_TYPES,
  DELIVERY_CHANNELS,
};
