// fileUploadService.js
// ============================================================
// File upload service — handles post-upload processing,
// file path management, deletion, and DB record updates.
//
// Works on top of uploadMiddleware.js (which handles multer).
// Controllers use uploadMiddleware for the actual upload, then
// call this service to process the result and update the DB.
//
// Upload directories (all under backend/uploads/):
//   profile/       — user avatar images
//   maintenance/   — maintenance request attachments
//   chat/          — chat message attachments
//   receipts/      — auto-generated payment receipts (PDF)
//   general/       — fallback
//
// All file_url values stored in DB are RELATIVE paths
// e.g. "uploads/profile/1234567890.jpg"
// Frontend constructs full URL: http://localhost:5000/uploads/profile/...
// ============================================================

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { AppError } = require("../utils/errorhandler");

const parseId = (value) => {
  const id = parseInt(value, 10);
  return isNaN(id) || id <= 0 ? null : id;
};

// ── ROOT_DIR ─────────────────────────────────────────────────
// Absolute path to the backend folder.
// All relative file paths are resolved from here.
const ROOT_DIR = path.join(__dirname);

// ── getRelativePath ──────────────────────────────────────────
// Convert an absolute file path from multer to a relative
// path suitable for storing in the DB.
// e.g. "C:/project/backend/uploads/profile/abc.jpg"
//   → "uploads/profile/abc.jpg"
const getRelativePath = (absolutePath) => {
  if (!absolutePath) return null;
  return absolutePath
    .replace(ROOT_DIR, "")
    .replace(/\\/g, "/") // normalize Windows backslashes
    .replace(/^\//, ""); // strip leading slash
};

// ── getAbsolutePath ──────────────────────────────────────────
// Convert a relative DB path to an absolute filesystem path.
// e.g. "uploads/profile/abc.jpg"
//   → "C:/project/backend/uploads/profile/abc.jpg"
const getAbsolutePath = (relativePath) => {
  if (!relativePath) return null;
  return path.join(ROOT_DIR, relativePath);
};

// ── buildFileUrl ─────────────────────────────────────────────
// Build the full public URL for a file from its relative path.
// Uses BASE_URL from .env or falls back to localhost.
//
// Usage:
//   buildFileUrl("uploads/profile/abc.jpg")
//   → "http://localhost:5000/uploads/profile/abc.jpg"
const buildFileUrl = (relativePath) => {
  if (!relativePath) return null;
  const base = (
    process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`
  ).replace(/\/$/, "");
  return `${base}/${relativePath.replace(/^\//, "")}`;
};

// ── fileExists ───────────────────────────────────────────────
// Check if a file exists on disk given its relative DB path.
const fileExists = (relativePath) => {
  if (!relativePath) return false;
  return fs.existsSync(getAbsolutePath(relativePath));
};

// ── deleteFile ───────────────────────────────────────────────
// Delete a file from disk given its relative DB path.
// Non-fatal — logs warning if file not found, never throws.
//
// Usage:
//   await deleteFile("uploads/profile/old-avatar.jpg");
const deleteFile = async (relativePath) => {
  if (!relativePath) return false;
  const absPath = getAbsolutePath(relativePath);
  try {
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      return true;
    }
    console.warn(`⚠️  deleteFile: file not found — ${relativePath}`);
    return false;
  } catch (err) {
    console.error(`❌ deleteFile failed for "${relativePath}":`, err.message);
    return false;
  }
};

// ── processUploadedFile ──────────────────────────────────────
// Extract file info from a multer req.file object and return
// a normalised object ready for DB insertion.
//
// Usage (in controller after upload middleware):
//   const file = processUploadedFile(req.file);
//   // file = { relativePath, absolutePath, url, filename, mimetype, size }
const processUploadedFile = (multerFile) => {
  if (!multerFile) throw new AppError("No file uploaded", 400);

  const relativePath = getRelativePath(multerFile.path);
  return {
    relativePath, // store this in DB
    absolutePath: multerFile.path,
    url: buildFileUrl(relativePath),
    filename: multerFile.filename,
    originalName: multerFile.originalname,
    mimetype: multerFile.mimetype,
    size: multerFile.size,
    sizeKB: Math.round(multerFile.size / 1024),
  };
};

// ── processUploadedFiles ─────────────────────────────────────
// Same as processUploadedFile but for req.files (multiple).
const processUploadedFiles = (multerFiles) => {
  if (!multerFiles || multerFiles.length === 0) return [];
  return multerFiles.map(processUploadedFile);
};

// ============================================================
// Domain-specific upload handlers
// Each function handles the upload result for one use case,
// updating the correct DB table/column and deleting old files.
// ============================================================

// ── saveAvatar ───────────────────────────────────────────────
// Save a new avatar for a user. Deletes old avatar from disk.
// Updates users.avatar_url with the relative path.
//
// Usage (in avatarController after upload.profile.single("avatar")):
//   const result = await fileUploadService.saveAvatar(req.user.id, req.file);
const saveAvatar = async (userId, multerFile) => {
  const uid = parseId(userId);
  if (!uid) throw new AppError("Invalid user ID", 400);

  const file = processUploadedFile(multerFile);

  // Validate — avatars must be images only
  if (!file.mimetype.startsWith("image/")) {
    await deleteFile(file.relativePath);
    throw new AppError(
      "Avatar must be an image file (JPEG, PNG, GIF, WebP)",
      400,
    );
  }

  // Fetch old avatar to delete after update
  const [[user]] = await db.execute(
    `SELECT avatar_url FROM users WHERE id = ?`,
    [uid],
  );

  if (!user) {
    await deleteFile(file.relativePath);
    throw new AppError("User not found", 404);
  }

  // Update DB
  await db.execute(
    `UPDATE users SET avatar_url = ?, updated_at = NOW() WHERE id = ?`,
    [file.relativePath, uid],
  );

  // Delete old avatar from disk (after successful DB update)
  if (user.avatar_url) {
    await deleteFile(user.avatar_url);
  }

  return {
    avatar_url: file.relativePath,
    url: file.url,
    size: file.sizeKB,
  };
};

// ── deleteAvatar ─────────────────────────────────────────────
// Remove a user's avatar from disk and clear avatar_url in DB.
const deleteAvatar = async (userId) => {
  const uid = parseId(userId);
  if (!uid) throw new AppError("Invalid user ID", 400);

  const [[user]] = await db.execute(
    `SELECT avatar_url FROM users WHERE id = ?`,
    [uid],
  );
  if (!user) throw new AppError("User not found", 404);

  if (user.avatar_url) {
    await deleteFile(user.avatar_url);
    await db.execute(
      `UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = ?`,
      [uid],
    );
  }
  return true;
};

// ── saveMaintenanceAttachment ─────────────────────────────────
// Attach an uploaded file to a maintenance request.
// Updates maintenance_requests.attachment_url.
//
// Usage:
//   await fileUploadService.saveMaintenanceAttachment(requestId, req.file);
const saveMaintenanceAttachment = async (requestId, multerFile) => {
  const rid = parseId(requestId);
  if (!rid) throw new AppError("Invalid maintenance request ID", 400);

  const file = processUploadedFile(multerFile);

  // Fetch old attachment to delete
  const [[request]] = await db.execute(
    `SELECT attachment_url FROM maintenance_requests WHERE id = ?`,
    [rid],
  );
  if (!request) {
    await deleteFile(file.relativePath);
    throw new AppError("Maintenance request not found", 404);
  }

  await db.execute(
    `UPDATE maintenance_requests
     SET attachment_url = ?, updated_at = NOW()
     WHERE id = ?`,
    [file.relativePath, rid],
  );

  if (request.attachment_url) {
    await deleteFile(request.attachment_url);
  }

  return {
    attachment_url: file.relativePath,
    url: file.url,
    mimetype: file.mimetype,
    size: file.sizeKB,
  };
};

// ── saveChatFile ─────────────────────────────────────────────
// Save a file uploaded in a chat message.
// Returns file info for insertion into the messages table.
// Does NOT insert the message — that's the chat controller's job.
//
// Usage:
//   const fileInfo = await fileUploadService.saveChatFile(req.file);
//   // Then insert message with file_info.relativePath and file_info.fileType
const saveChatFile = async (multerFile) => {
  const file = processUploadedFile(multerFile);

  // Map MIME type to schema ENUM('image','pdf','doc','other')
  let fileType = "other";
  if (file.mimetype.startsWith("image/")) fileType = "image";
  else if (file.mimetype === "application/pdf") fileType = "pdf";
  else if (file.mimetype.includes("word") || file.mimetype.includes("document"))
    fileType = "doc";

  return {
    file_url: file.relativePath, // store in messages.file_url
    file_type: fileType, // store in messages.file_type
    url: file.url,
    mimetype: file.mimetype,
    size: file.sizeKB,
  };
};

// ── saveReceiptFile ──────────────────────────────────────────
// Save a generated PDF receipt path to the receipts table.
// Called by paymentController after PDF generation.
//
// Usage:
//   await fileUploadService.saveReceiptFile(paymentId, receiptNumber, absolutePdfPath);
const saveReceiptFile = async (paymentId, receiptNumber, absolutePdfPath) => {
  const pid = parseId(paymentId);
  if (!pid) throw new AppError("Invalid payment ID", 400);
  if (!receiptNumber) throw new AppError("Receipt number is required", 400);

  const relativePath = getRelativePath(absolutePdfPath);

  await db.execute(
    `INSERT INTO receipts
       (payment_id, receipt_number, receipt_type, file_url, issued_at)
     VALUES (?, ?, 'rent', ?, NOW())`,
    [pid, receiptNumber, relativePath],
  );

  return {
    receipt_number: receiptNumber,
    file_url: relativePath,
    url: buildFileUrl(relativePath),
  };
};

// ── cleanOrphanedFiles ───────────────────────────────────────
// Scan an upload directory and delete files that have no
// corresponding DB record. Run manually or as a cron job.
//
// @param {string} context — "profile" | "maintenance" | "chat"
//
// Usage:
//   const report = await fileUploadService.cleanOrphanedFiles("profile");
const cleanOrphanedFiles = async (context) => {
  const dirMap = {
    profile: { dir: "uploads/profile", table: "users", col: "avatar_url" },
    maintenance: {
      dir: "uploads/maintenance",
      table: "maintenance_requests",
      col: "attachment_url",
    },
    chat: { dir: "uploads/chat", table: "messages", col: "file_url" },
  };

  const config = dirMap[context];
  if (!config) throw new AppError(`Unknown upload context: ${context}`, 400);

  const absDir = getAbsolutePath(config.dir);
  if (!fs.existsSync(absDir)) return { deleted: 0, kept: 0, errors: 0 };

  // Get all DB-registered paths for this context
  const [rows] = await db.execute(
    `SELECT ${config.col} AS file_path FROM ${config.table}
     WHERE ${config.col} IS NOT NULL`,
  );
  const registeredPaths = new Set(rows.map((r) => r.file_path));

  const files = fs.readdirSync(absDir);
  let deleted = 0,
    kept = 0,
    errors = 0;

  for (const filename of files) {
    const relativePath = `${config.dir}/${filename}`;
    if (registeredPaths.has(relativePath)) {
      kept++;
    } else {
      const success = await deleteFile(relativePath);
      success ? deleted++ : errors++;
    }
  }

  console.log(
    `🧹 cleanOrphanedFiles(${context}): deleted=${deleted} kept=${kept} errors=${errors}`,
  );
  return { deleted, kept, errors };
};

module.exports = {
  // Helpers
  getRelativePath,
  getAbsolutePath,
  buildFileUrl,
  fileExists,
  deleteFile,
  processUploadedFile,
  processUploadedFiles,

  // Domain handlers
  saveAvatar,
  deleteAvatar,
  saveMaintenanceAttachment,
  saveChatFile,
  saveReceiptFile,

  // Maintenance
  cleanOrphanedFiles,
};
