// config/multer.js
// ============================================================
// Central multer configuration — exported as named instances
// used by uploadMiddleware.js.
//
// This file owns:
//   - Upload directory paths
//   - Allowed MIME types + extension cross-check
//   - File size / count limits
//   - Safe filename generation (timestamp + random suffix)
//
// uploadMiddleware.js imports from here and wraps these into
// named upload instances (upload.chat, upload.maintenance etc.)
// ready to use in route files.
//
// Directory structure created on startup:
//   uploads/
//   ├── avatars/          ← profile pictures
//   ├── chat/             ← direct message attachments
//   ├── general/          ← miscellaneous uploads
//   ├── group_messages/   ← group chat attachments
//   ├── maintenance/      ← maintenance request attachments
//   └── receipts/         ← PDF payment receipts
// ============================================================

const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ── Limits ───────────────────────────────────────────────────
// MAX_FILE_SIZE_MB from .env — defaults to 10MB
const MAX_FILE_SIZE_BYTES =
  (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10) * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 5;

// ── Allowed MIME types → valid extensions ────────────────────
// MIME is the authoritative check — extension is cross-validated
// to catch renamed files (e.g. script.js renamed to photo.jpg)
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

// ── Upload context → subdirectory map ────────────────────────
const UPLOAD_CONTEXTS = Object.freeze({
  avatars: "uploads/avatars",
  chat: "uploads/chat",
  general: "uploads/general",
  group_messages: "uploads/group_messages",
  maintenance: "uploads/maintenance",
  receipts: "uploads/receipts",
});

// ── Ensure all upload directories exist at startup ───────────
const PROJECT_ROOT = path.join(__dirname, "..");

Object.values(UPLOAD_CONTEXTS).forEach((dir) => {
  const fullPath = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// ── Storage factory ───────────────────────────────────────────
// Each context gets its own diskStorage instance pointing
// to the correct subdirectory.
const createStorage = (context = "general") => {
  const subDir = UPLOAD_CONTEXTS[context] ?? UPLOAD_CONTEXTS.general;

  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, path.join(PROJECT_ROOT, subDir));
    },

    filename: (_req, file, cb) => {
      // Extension from MIME map — never trust originalname extension alone
      const exts = ALLOWED_MIME_TO_EXT[file.mimetype];
      const ext = exts ? exts[0] : "";
      const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      cb(null, name);
    },
  });
};

// ── File filter ───────────────────────────────────────────────
// 1. Rejects unsupported MIME types entirely
// 2. Cross-checks declared file extension against MIME type
//    to catch files that have been renamed to bypass type checks
const fileFilter = (req, file, cb) => {
  const allowedExts = ALLOWED_MIME_TO_EXT[file.mimetype];

  // Step 1 — MIME check
  if (!allowedExts) {
    console.warn(
      `[UPLOAD] Rejected unsupported MIME "${file.mimetype}" — ` +
        `user: ${req.user?.id ?? "unauthenticated"}, IP: ${req.ip}`,
    );
    const err = new Error(
      `Unsupported file type "${file.mimetype}". ` +
        `Allowed: images (jpeg/png/gif/webp), PDF, DOC, DOCX.`,
    );
    err.code = "INVALID_FILE_TYPE";
    err.status = 400;
    return cb(err, false);
  }

  // Step 2 — Extension cross-check
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
// Import and use in routes:
//   const { upload } = require("../config/multer");
//   router.post("/", upload.chat.single("file"), handler);
//   router.post("/", upload.maintenance.single("attachment"), handler);
//   router.post("/", upload.avatars.single("avatar"), handler);
const upload = {
  avatars: createUploader("avatars"),
  chat: createUploader("chat"),
  general: createUploader("general"),
  groupMessage: createUploader("group_messages"),
  maintenance: createUploader("maintenance"),
  receipts: createUploader("receipts"),
};

module.exports = {
  upload,
  createUploader,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_REQUEST,
  ALLOWED_MIME_TYPES,
  ALLOWED_MIME_TO_EXT,
  UPLOAD_CONTEXTS,
};
