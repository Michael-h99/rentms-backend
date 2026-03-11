// seedData.js — fixed to match rentms_full_schema.sql v2.0
require("dotenv").config();
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// ── Constants (inline — no external dependency needed) ──────
const ROLES = { ADMIN: "admin", LANDLORD: "landlord", TENANT: "tenant" };
const USER_STATUS = { ACTIVE: "active" };
const PAYMENT_METHODS = { MOBILE_MONEY: "momo", BANK_TRANSFER: "bank" };
const PAYMENT_STATUS = { PAID: "paid" };
const TENANCY_STATUS = { ACTIVE: "active" };

const generateId = (prefix = "ID") =>
  `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

const generateInviteCode = () =>
  crypto.randomBytes(4).toString("hex").toUpperCase();

// ── Main Seeder ─────────────────────────────────────────────
async function seedDatabase() {
  const SEED_PASSWORD = process.env.SEED_PASSWORD || "Password123!";

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "rent_management_system",
    port: process.env.DB_PORT || 3306,
  });

  console.log("✅ Connected to database");

  try {
    await connection.beginTransaction();

    // ── Clear tables (schema-accurate order, FK-safe) ──────
    console.log("🗑️  Clearing existing data...");
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");

    const tables = [
      "push_logs",
      "email_logs",
      "activity_logs",
      "notifications",
      "messages",
      "maintenance_requests",
      "receipts",
      "payments",
      "late_fees",
      "tenancies",
      "invite_codes",
      "plazas",
      "device_tokens",
      "users",
    ];

    for (const table of tables) {
      try {
        await connection.query(`DELETE FROM \`${table}\``);
      } catch {
        // Table might not exist in an older schema version — skip silently
        console.log(`   ⚠️  Skipped missing table: ${table}`);
      }
    }
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    console.log("✅ Tables cleared");

    // ── Hash password ──────────────────────────────────────
    const hashedPassword = await bcrypt.hash(SEED_PASSWORD, 12);
    console.log("🔑 Password hashed");

    // ── Users ──────────────────────────────────────────────
    console.log("👤 Seeding users...");

    const [adminRow] = await connection.execute(
      `INSERT INTO users
         (username, email, phone, full_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        "superAdmin",
        "admin@rent.com",
        "0200000000",
        "Super Admin",
        hashedPassword,
        ROLES.ADMIN,
        USER_STATUS.ACTIVE,
      ],
    );

    const [landlordRow] = await connection.execute(
      `INSERT INTO users
         (username, email, phone, full_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        "johnLandlord",
        "landlord@rent.com",
        "0240000000",
        "John Mensah",
        hashedPassword,
        ROLES.LANDLORD,
        USER_STATUS.ACTIVE,
      ],
    );

    const [t1] = await connection.execute(
      `INSERT INTO users
         (username, email, phone, full_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        "janeTenant",
        "tenant@rent.com",
        "0550000000",
        "Jane Asante",
        hashedPassword,
        ROLES.TENANT,
        USER_STATUS.ACTIVE,
      ],
    );

    const [t2] = await connection.execute(
      `INSERT INTO users
         (username, email, phone, full_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        "kobiTenant",
        "tenant2@rent.com",
        "0244000001",
        "Kobi Acheampong",
        hashedPassword,
        ROLES.TENANT,
        USER_STATUS.ACTIVE,
      ],
    );

    const [t3] = await connection.execute(
      `INSERT INTO users
         (username, email, phone, full_name, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        "amaOwusu",
        "tenant3@rent.com",
        "0209000002",
        "Ama Owusu",
        hashedPassword,
        ROLES.TENANT,
        USER_STATUS.ACTIVE,
      ],
    );

    console.log("✅ Users seeded (1 admin, 1 landlord, 3 tenants)");

    // ── Plazas ─────────────────────────────────────────────
    console.log("🏢 Seeding plazas...");

    const [plaza1] = await connection.execute(
      `INSERT INTO plazas (landlord_id, name, location, total_units, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [landlordRow.insertId, "Sunrise Apartments", "Spintex Road, Accra", 10],
    );

    const [plaza2] = await connection.execute(
      `INSERT INTO plazas (landlord_id, name, location, total_units, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [landlordRow.insertId, "Harbour View Flats", "Community 1, Tema", 6],
    );

    console.log("✅ Plazas seeded (2 plazas)");

    // ── Invite Codes ───────────────────────────────────────
    console.log("🔑 Seeding invite codes...");

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);

    const [code1] = await connection.execute(
      `INSERT INTO invite_codes
         (code, landlord_id, plaza_id, unit_number, rent_amount,
          max_uses, used_count, claimed_by,
          lease_start, lease_end, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        generateInviteCode(),
        landlordRow.insertId,
        plaza1.insertId,
        "A1",
        1500.0,
        1,
        1,
        t1.insertId,
        "2026-01-01",
        "2026-12-31",
        "used",
        expiry,
      ],
    );

    const [code2] = await connection.execute(
      `INSERT INTO invite_codes
         (code, landlord_id, plaza_id, unit_number, rent_amount,
          max_uses, used_count, claimed_by,
          lease_start, lease_end, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        generateInviteCode(),
        landlordRow.insertId,
        plaza1.insertId,
        "A2",
        1200.0,
        1,
        1,
        t2.insertId,
        "2026-01-01",
        "2026-12-31",
        "used",
        expiry,
      ],
    );

    const [code3] = await connection.execute(
      `INSERT INTO invite_codes
         (code, landlord_id, plaza_id, unit_number, rent_amount,
          max_uses, used_count, claimed_by,
          lease_start, lease_end, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        generateInviteCode(),
        landlordRow.insertId,
        plaza2.insertId,
        "B1",
        1800.0,
        1,
        1,
        t3.insertId,
        "2025-03-01",
        "2026-03-01",
        "used",
        expiry,
      ],
    );

    // One active unused code
    await connection.execute(
      `INSERT INTO invite_codes
         (code, landlord_id, plaza_id, unit_number, rent_amount,
          max_uses, used_count, lease_start, lease_end, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        generateInviteCode(),
        landlordRow.insertId,
        plaza1.insertId,
        "A3",
        1400.0,
        1,
        0,
        "2026-04-01",
        "2027-03-31",
        "active",
        expiry,
      ],
    );

    console.log("✅ Invite codes seeded");

    // ── Tenancies ──────────────────────────────────────────
    console.log("📋 Seeding tenancies...");

    const [ten1] = await connection.execute(
      `INSERT INTO tenancies
         (tenant_id, plaza_id, invite_code_id, unit_number, rent_amount,
          lease_start, lease_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        t1.insertId,
        plaza1.insertId,
        code1.insertId,
        "A1",
        1500.0,
        "2026-01-01",
        "2026-12-31",
        TENANCY_STATUS.ACTIVE,
      ],
    );

    const [ten2] = await connection.execute(
      `INSERT INTO tenancies
         (tenant_id, plaza_id, invite_code_id, unit_number, rent_amount,
          lease_start, lease_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        t2.insertId,
        plaza1.insertId,
        code2.insertId,
        "A2",
        1200.0,
        "2026-01-01",
        "2026-12-31",
        TENANCY_STATUS.ACTIVE,
      ],
    );

    const [ten3] = await connection.execute(
      `INSERT INTO tenancies
         (tenant_id, plaza_id, invite_code_id, unit_number, rent_amount,
          lease_start, lease_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        t3.insertId,
        plaza2.insertId,
        code3.insertId,
        "B1",
        1800.0,
        "2025-03-01",
        "2026-03-01",
        TENANCY_STATUS.ACTIVE,
      ],
    );

    console.log("✅ Tenancies seeded (3 active)");

    // ── Payments ───────────────────────────────────────────
    console.log("💳 Seeding payments...");

    // 3 months of payments for tenant 1
    for (let i = 0; i < 3; i++) {
      const ref = generateId("PMT");
      const [pay] = await connection.execute(
        `INSERT INTO payments
           (tenancy_id, amount, currency, payment_method, status,
            reference, payment_date, created_at, updated_at)
         VALUES (?, ?, 'GHS', ?, ?, ?, NOW(), NOW(), NOW())`,
        [
          ten1.insertId,
          1500.0,
          PAYMENT_METHODS.MOBILE_MONEY,
          PAYMENT_STATUS.PAID,
          ref,
        ],
      );
      await connection.execute(
        `INSERT INTO receipts
           (payment_id, receipt_number, receipt_type, issued_at)
         VALUES (?, ?, 'rent', NOW())`,
        [pay.insertId, generateId("RCT")],
      );
    }

    // 2 months for tenant 2
    for (let i = 0; i < 2; i++) {
      const ref = generateId("PMT");
      const [pay] = await connection.execute(
        `INSERT INTO payments
           (tenancy_id, amount, currency, payment_method, status,
            reference, payment_date, created_at, updated_at)
         VALUES (?, ?, 'GHS', ?, ?, ?, NOW(), NOW(), NOW())`,
        [
          ten2.insertId,
          1200.0,
          PAYMENT_METHODS.BANK_TRANSFER,
          PAYMENT_STATUS.PAID,
          ref,
        ],
      );
      await connection.execute(
        `INSERT INTO receipts
           (payment_id, receipt_number, receipt_type, issued_at)
         VALUES (?, ?, 'rent', NOW())`,
        [pay.insertId, generateId("RCT")],
      );
    }

    // 1 payment for tenant 3
    const ref3 = generateId("PMT");
    const [pay3] = await connection.execute(
      `INSERT INTO payments
         (tenancy_id, amount, currency, payment_method, status,
          reference, payment_date, created_at, updated_at)
       VALUES (?, ?, 'GHS', ?, ?, ?, NOW(), NOW(), NOW())`,
      [
        ten3.insertId,
        1800.0,
        PAYMENT_METHODS.MOBILE_MONEY,
        PAYMENT_STATUS.PAID,
        ref3,
      ],
    );
    await connection.execute(
      `INSERT INTO receipts
         (payment_id, receipt_number, receipt_type, issued_at)
       VALUES (?, ?, 'rent', NOW())`,
      [pay3.insertId, generateId("RCT")],
    );

    console.log("✅ Payments & receipts seeded (6 payments, 6 receipts)");

    // ── Maintenance Requests ───────────────────────────────
    console.log("🔧 Seeding maintenance requests...");

    await connection.execute(
      `INSERT INTO maintenance_requests
         (tenant_id, plaza_id, title, description, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        t1.insertId,
        plaza1.insertId,
        "Leaking Tap",
        "Kitchen tap has been leaking for 2 days",
        "high",
        "pending",
      ],
    );

    await connection.execute(
      `INSERT INTO maintenance_requests
         (tenant_id, plaza_id, title, description, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        t2.insertId,
        plaza1.insertId,
        "Broken Window",
        "Living room window latch is broken",
        "medium",
        "in_progress",
      ],
    );

    await connection.execute(
      `INSERT INTO maintenance_requests
         (tenant_id, plaza_id, title, description, priority, status,
          resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
      [
        t3.insertId,
        plaza2.insertId,
        "Power Outage in Unit",
        "No electricity in bedroom",
        "high",
        "resolved",
      ],
    );

    console.log("✅ Maintenance requests seeded");

    // ── Notifications ──────────────────────────────────────
    console.log("🔔 Seeding notifications...");

    await connection.execute(
      `INSERT INTO notifications
         (recipient_id, type, message, is_read, delivery_channel, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        t1.insertId,
        "payment_reminder",
        "Your rent of GHS 1,500 is due in 3 days",
        false,
        "in_app",
      ],
    );

    await connection.execute(
      `INSERT INTO notifications
         (recipient_id, type, message, is_read, delivery_channel, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        t3.insertId,
        "lease_expiring",
        "Your lease expires on 2026-03-01. Please contact your landlord to renew.",
        false,
        "in_app",
      ],
    );

    await connection.execute(
      `INSERT INTO notifications
         (recipient_id, type, message, is_read, delivery_channel, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        landlordRow.insertId,
        "maintenance_request",
        "New maintenance request from Jane Asante: Leaking Tap",
        false,
        "in_app",
      ],
    );

    await connection.execute(
      `INSERT INTO notifications
         (recipient_id, type, message, is_read, delivery_channel, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        landlordRow.insertId,
        "payment_received",
        "Payment of GHS 1,500 received from Jane Asante (Unit A1)",
        true,
        "in_app",
      ],
    );

    console.log("✅ Notifications seeded");

    // ── Commit ─────────────────────────────────────────────
    await connection.commit();

    console.log("\n🎉 Database seeded successfully!");
    console.log("─────────────────────────────────────────────");
    console.log(`📧 Admin    : admin@rent.com`);
    console.log(`📧 Landlord : landlord@rent.com`);
    console.log(`📧 Tenant 1 : tenant@rent.com`);
    console.log(`📧 Tenant 2 : tenant2@rent.com`);
    console.log(`📧 Tenant 3 : tenant3@rent.com`);
    console.log(`🔑 Password : ${SEED_PASSWORD}`);
    console.log("─────────────────────────────────────────────\n");
  } catch (err) {
    await connection.rollback();
    console.error("❌ Seeding failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await connection.end();
    console.log("🔌 Database connection closed");
  }
}

seedDatabase();
