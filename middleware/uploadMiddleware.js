// middleware/uploadMiddleware.js
// ============================================================
// Centralised multer configuration for all file uploads.
// Provides context-specific upload instances, MIME validation,
// safe filename generation, and a shared error handler.
//
// Upload contexts → storage paths:
//   general        → uploads/general/
//   group_messages → uploads/group_messages/
//   maintenance    → uploads/maintenance/
//   profile        → uploads/profile/
//   chat           → uploads/chat/
//   receipts       → uploads/receipts/   ← PDF receipts (paymentController)
//
// Usage in routes:
//   upload.chat.single("file")
//   upload.maintenance.single("attachment")
//   upload.profile.single("avatar")
//   upload.receipts.single("file")
//   upload.groupMessage.single("file")
//
// Always mount handleUploadError AFTER routes that use upload:
//   router.use(handleUploadError)
// ============================================================

const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ── Limits ───────────────────────────────────────────────────
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES_PER_REQUEST = 5;

// ── MIME → allowed extensions ─────────────────────────────────
// Single source of truth — never trust originalname extension alone.
const ALLOWED_MIME_TO_EXT = Object.freeze({
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
});

const ALLOWED_MIME_TYPES = Object.keys(ALLOWED_MIME_TO_EXT);

// ── Upload subdirectories per context ────────────────────────
const UPLOAD_CONTEXTS = Object.freeze({
  general: "uploads/general",
  group_messages: "uploads/group_messages",
  maintenance: "uploads/maintenance",
  profile: "uploads/profile",
  chat: "uploads/chat",
  receipts: "uploads/receipts", // PDF receipts — paymentController
});

// ── Create directories at startup ────────────────────────────
Object.values(UPLOAD_CONTEXTS).forEach((dir) => {
  const fullPath = path.join(__dirname, "..", dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// ── Dynamic disk storage per context ─────────────────────────
const createStorage = (context = "general") => {
  const subDir = UPLOAD_CONTEXTS[context] || UPLOAD_CONTEXTS.general;

  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(__dirname, "..", subDir));
    },

    filename: (req, file, cb) => {
      // Extension derived from MIME — never from originalname
      const allowedExts = ALLOWED_MIME_TO_EXT[file.mimetype];
      const ext = allowedExts ? allowedExts[0] : "";
      const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${suffix}${ext}`);
    },
  });
};

// ── File filter — MIME + extension cross-check ────────────────
const fileFilter = (req, file, cb) => {
  const allowedExts = ALLOWED_MIME_TO_EXT[file.mimetype];

  if (!allowedExts) {
    console.warn(
      `[UPLOAD] Rejected — MIME: "${file.mimetype}", ` +
        `user: ${req.user?.id ?? "unauthenticated"}, IP: ${req.ip}`,
    );
    const err = new Error(
      `Unsupported file type "${file.mimetype}". ` +
        `Allowed: images (jpeg, png, gif, webp), PDF, DOC, DOCX.`,
    );
    err.code = "INVALID_FILE_TYPE";
    err.status = 400;
    return cb(err, false);
  }

  // Cross-check declared extension against MIME — catches renamed files
  const originalExt = path.extname(file.originalname).toLowerCase();
  if (originalExt && !allowedExts.includes(originalExt)) {
    console.warn(
      `[UPLOAD] Extension/MIME mismatch — ext: "${originalExt}", ` +
        `MIME: "${file.mimetype}", user: ${req.user?.id ?? "unauthenticated"}, IP: ${req.ip}`,
    );
    const err = new Error(
      `File extension "${originalExt}" does not match declared type "${file.mimetype}".`,
    );
    err.code = "INVALID_FILE_TYPE";
    err.status = 400;
    return cb(err, false);
  }

  cb(null, true);
};

// ── Multer instance factory ───────────────────────────────────
const createUploader = (context = "general") =>
  multer({
    storage: createStorage(context),
    fileFilter,
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
      files: MAX_FILES_PER_REQUEST,
    },
  });

// ── Named upload instances ────────────────────────────────────
// Use .single("field"), .array("field", n), or .fields([...])
const upload = {
  general: createUploader("general"),
  groupMessage: createUploader("group_messages"),
  maintenance: createUploader("maintenance"),
  profile: createUploader("profile"),
  chat: createUploader("chat"),
  receipts: createUploader("receipts"),
};

// ── Upload error handler middleware ──────────────────────────
// Mount AFTER all routes that use upload middleware:
//   router.use(handleUploadError)
//
// Response format matches the rest of the codebase:
//   { success: false, message: "..." }
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const MESSAGES = {
      LIMIT_FILE_SIZE: `File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB.`,
      LIMIT_FILE_COUNT: `Too many files. Maximum ${MAX_FILES_PER_REQUEST} per request.`,
      LIMIT_UNEXPECTED_FILE:
        "Unexpected file field. Check the field name in your request.",
    };
    const message = MESSAGES[err.code] || `Upload error: ${err.message}`;
    return res.status(400).json({ success: false, message });
  }

  // Tagged errors from fileFilter
  if (err?.code === "INVALID_FILE_TYPE") {
    return res.status(400).json({ success: false, message: err.message });
  }

  // Pass anything else to the global error handler
  next(err);
};

module.exports = {
  upload,
  handleUploadError,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_REQUEST,
  ALLOWED_MIME_TYPES,
  UPLOAD_CONTEXTS,
};
