// utils/db.js
const mysql = require("mysql2");
require("dotenv").config();

// ============================================================
// Guard — fail fast if required DB environment variables missing
// A missing variable causes silent connection failures that are
// hard to debug — better to crash immediately with a clear message
// ============================================================
const required = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_PORT"];
for (const key of required) {
  if (!process.env[key] && process.env[key] !== "") {
    throw new Error(`FATAL: Missing required environment variable: ${key}`);
  }
}

// ============================================================
// Connection Pool
// mysql2/promise used throughout the codebase for async/await
// connectionLimit: 15 — suitable for a single-server project
// connectTimeout: 10s — prevents hanging on bad host config
// ============================================================
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT, 10),
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  connectTimeout: 10000, // 10 seconds
  timezone: "Z", // Store all dates in UTC
  dateStrings: false, // Return JS Date objects not strings
});

// ============================================================
// Promise wrapper — used by all models with db.execute()
// Exported as the default so all files can do:
//   const db = require("../utils/db");
//   const [rows] = await db.execute(...)
// ============================================================
const promisePool = db.promise();

// ============================================================
// Test connection on startup — verifies credentials immediately
// rather than silently failing on the first real query
// ============================================================
promisePool
  .getConnection()
  .then((connection) => {
    console.log("✅ Connected to MySQL database");
    console.log(`   Host     : ${process.env.DB_HOST}:${process.env.DB_PORT}`);
    console.log(`   Database : ${process.env.DB_NAME}`);
    connection.release();
  })
  .catch((err) => {
    console.error("❌ MySQL connection failed:", err.message);
    console.error(
      "   Check DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT in .env",
    );
    // Exit on startup — no point running an API with no database
    process.exit(1);
  });

// ============================================================
// Pool event listeners — catch errors that occur after startup
// Without this, idle connection errors crash the process silently
// ============================================================
db.on("connection", (connection) => {
  connection.on("error", (err) => {
    console.error("❌ MySQL connection error:", err.message);
  });
});

// ============================================================
// Export the promise pool — all models use await db.execute()
// ============================================================
module.exports = promisePool;
