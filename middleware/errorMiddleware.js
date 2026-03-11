// middleware/errorMiddleware.js
// ============================================================
// Thin wrappers that delegate to the project's centralised
// error handling in utils/errorHandler.js.
//
// DO NOT add new error handling logic here — add it to
// utils/errorHandler.js (globalErrorHandler / handleDbError /
// handleJwtError / handleMulterError) so it is consistent
// across the entire codebase.
//
// Mount order in app.js:
//   app.use(notFoundHandler);   // catches unknown routes → 404
//   app.use(errorHandler);      // handles all thrown errors
//
// Usage of AppError in controllers (via utils/errorHandler):
//   throw new AppError("Plaza not found", 404);
//   throw new AppError("Unauthorized", 401);
// ============================================================

const { AppError, globalErrorHandler } = require("../utils/errorhandler");

// ── 404 — Unknown Route Handler ───────────────────────────────
// Creates a structured AppError so globalErrorHandler can
// handle it consistently with all other errors.
// Mount BEFORE errorHandler.
const notFoundHandler = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

// ── Global Error Handler ──────────────────────────────────────
// Delegates entirely to globalErrorHandler from utils/errorHandler.js.
// Handles: AppError, JWT errors, Multer errors, MySQL errors,
// operational vs non-operational errors, dev/prod stack traces.
const errorHandler = globalErrorHandler;

module.exports = { notFoundHandler, errorHandler };
