// app.js
// ============================================================
// Main server entry point — lives in backend/ root
// ============================================================

require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const morgan = require("morgan");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const chalk = require("chalk");
const nodemailer = require("nodemailer");
const webpush = require("web-push");

const db = require("./utils/db");

const {
  authLimiter,
  paymentLimiter,
  generalLimiter,
} = require("./middleware/ratelimitMiddleware");
const {
  notFoundHandler,
  errorHandler,
} = require("./middleware/errorMiddleware");

const authroutes = require("./routes/authroutes");
const tenantroutes = require("./routes/tenantsroutes");
const landlordroutes = require("./routes/landlordroutes");
const adminroutes = require("./routes/adminroutes");
const adminnotificationroutes = require("./routes/adminnotificationroutes");
const paymentroutes = require("./routes/paymentroutes");
const chatroutes = require("./routes/chatroutes");
const maintenanceroutes = require("./routes/maintenanceroutes");
const notificationroutes = require("./routes/notificationroutes");
const emailroutes = require("./routes/emailroutes");
const pushroutes = require("./routes/pushroutes");
const invitecoderoutes = require("./routes/invitecoderoutes");
// TEMP: migration route — remove after visiting /api/migrate once
const migrateroutes = require("./routes/migrate");

const REQUIRED_ENV = ["JWT_SECRET", "DB_HOST", "DB_USER", "DB_NAME"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(
    chalk.red(
      `❌ Missing required env vars: ${missingEnv.join(", ")}\n   Check your .env file`,
    ),
  );
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(compression());

// ── Helmet — relax cross-origin policies so uploaded images
//    can be loaded by the Vercel frontend
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
  }),
);

const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : [
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use("/api", generalLimiter);

// ── Serve uploaded files with CORP header so browsers
//    allow cross-origin image loading from the Vercel frontend
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(path.join(__dirname, "uploads")),
);

const logStream = fs.createWriteStream(
  path.join(__dirname, "logs", "server.log"),
  { flags: "a" },
);

morgan.token("statusColor", (req, res) => {
  const s = res.statusCode;
  if (s >= 500) return chalk.red(String(s));
  if (s >= 400) return chalk.yellow(String(s));
  if (s >= 300) return chalk.cyan(String(s));
  return chalk.green(String(s));
});

app.use(
  morgan(":method :url :statusColor :res[content-length] - :response-time ms"),
);
app.use(morgan("combined", { stream: logStream }));

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);

io.on("connection", (socket) => {
  console.log(chalk.blue("🔌 Socket connected:"), socket.id);

  socket.on("join", (userId) => {
    const uid = parseInt(userId, 10);
    if (!uid || uid <= 0) return;
    socket.join(`user_${uid}`);
    console.log(chalk.blue(`✅ User ${uid} joined room user_${uid}`));
  });

  socket.on("join_admin", () => {
    socket.join("admin_room");
    console.log(chalk.blue("✅ Socket joined admin_room:", socket.id));
  });

  socket.on("join_group", (groupId) => {
    const gid = parseInt(groupId, 10);
    if (!gid || gid <= 0) return;
    socket.join(`group_${gid}`);
    console.log(chalk.blue(`✅ Socket joined group_${gid}`));
  });

  socket.on("disconnect", (reason) => {
    console.log(
      chalk.gray("❌ Socket disconnected:", socket.id, `(${reason})`),
    );
  });
});

const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

transporter.verify((err) => {
  if (err) console.error(chalk.red("❌ Email transporter error:"), err.message);
  else console.log(chalk.green("📩 Email transporter ready"));
});

app.set("transporter", transporter);

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.EMAIL_USER || "admin@rentms.com"}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  app.set("webpush", webpush);
  console.log(chalk.green("🔔 Web Push (VAPID) configured"));
} else {
  console.warn(
    chalk.yellow("⚠️  VAPID keys not set — push notifications disabled"),
  );
  app.set("webpush", null);
}

// ── Routes ────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authroutes);
app.use("/api/tenant", tenantroutes);
app.use("/api/landlord", landlordroutes);
app.use("/api/admin", adminroutes);
app.use("/api/admin/notifications", adminnotificationroutes);
app.use("/api/payments", paymentLimiter, paymentroutes);
app.use("/api/chat", chatroutes);
app.use("/api/maintenance", maintenanceroutes);
app.use("/api/notifications", notificationroutes);
app.use("/api/email", emailroutes);
app.use("/api/push", pushroutes);
app.use("/api/invite-codes", invitecoderoutes);
// TEMP: run once at /api/migrate then remove this line + routes/migrate.js
app.use("/api", migrateroutes);

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "🚀 Rent Management System API is running",
    version: "2.0.0",
    environment: process.env.NODE_ENV || "Production",
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = parseInt(process.env.PORT, 10) || 5000;

(async () => {
  try {
    await db.execute("SELECT 1");
    console.log(chalk.green("✅ Database connection verified"));

    server.listen(PORT, () => {
      console.log("─────────────────────────────────────────────────");
      console.log(
        chalk.greenBright(`✅ Server running → http://localhost:${PORT}`),
      );
      console.log(
        chalk.cyan(`🌍 Environment : ${process.env.NODE_ENV || "production"}`),
      );
      console.log(chalk.cyan(`🔗 Frontend    : ${ALLOWED_ORIGINS[0]}`));
      console.log(chalk.cyan(`📋 Logs        : logs/server.log`));
      console.log(chalk.cyan(`📁 Uploads     : /uploads`));
      console.log("─────────────────────────────────────────────────");
    });
  } catch (err) {
    console.error(chalk.red("❌ Database connection failed:"), err.message);
    process.exit(1);
  }
})();

const gracefulShutdown = (signal) => {
  console.log(
    chalk.yellow(`\n⚠️  ${signal} received — shutting down gracefully...`),
  );
  server.close(() => {
    console.log(chalk.green("✅ Server closed"));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error(chalk.red("🔥 Unhandled Promise Rejection:"), reason);
});

process.on("uncaughtException", (error) => {
  console.error(chalk.red("💥 Uncaught Exception:"), error.message);
  console.error(error.stack);
  process.exit(1);
});

module.exports = { app, server, io };
