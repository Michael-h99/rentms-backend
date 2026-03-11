// errorHandler.js
const chalk = require("chalk");

// ── AppError ─────────────────────────────────────────────────
// Custom error class for structured operational errors.
// Use instead of plain Error when throwing known errors
// so the global handler can return the correct HTTP status.
//
// Usage:
//   throw new AppError("Plaza not found", 404);
//   throw new AppError("Unauthorized", 403);
class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.name = this.constructor.name; // "AppError" in stack traces
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Common AppError factories ─────────────────────────────────
// Shortcuts for the most common error types across the codebase
const notFound = (msg = "Resource not found") => new AppError(msg, 404);
const unauthorized = (msg = "Unauthorized") => new AppError(msg, 401);
const forbidden = (msg = "Access denied") => new AppError(msg, 403);
const badRequest = (msg = "Bad request") => new AppError(msg, 400);
const conflict = (msg = "Resource already exists") => new AppError(msg, 409);
const serverError = (msg = "Internal server error") =>
  new AppError(msg, 500, false);
const unprocessable = (msg = "Unprocessable entity") => new AppError(msg, 422);

// ── handleJwtError ───────────────────────────────────────────
// Map JWT error names to clean AppError responses.
const handleJwtError = (err) => {
  if (err.name === "TokenExpiredError")
    return new AppError("Your session has expired. Please log in again.", 401);
  if (err.name === "JsonWebTokenError")
    return new AppError("Invalid token. Please log in again.", 401);
  if (err.name === "NotBeforeError")
    return new AppError("Token not yet active. Please try again.", 401);
  return null;
};

// ── handleDbError ────────────────────────────────────────────
// Map MySQL error codes to clean AppError responses.
const handleDbError = (err) => {
  if (err.code === "ER_DUP_ENTRY") {
    // Extract the duplicate field name from the MySQL message if possible
    const match = err.message.match(/for key '(.+?)'/);
    const field = match ? match[1].replace(/.*\./, "") : "value";
    return new AppError(`A record with this ${field} already exists.`, 409);
  }
  if (err.code === "ER_NO_REFERENCED_ROW_2")
    return new AppError("Related record not found.", 400);
  if (err.code === "ER_ROW_IS_REFERENCED_2")
    return new AppError(
      "Cannot delete — this record is referenced by other data.",
      400,
    );
  if (err.code === "ER_BAD_NULL_ERROR")
    return new AppError("A required field is missing.", 400);
  if (err.code === "ER_DATA_TOO_LONG")
    return new AppError("A value is too long for the field.", 400);
  if (err.code === "ER_TRUNCATED_WRONG_VALUE")
    return new AppError("Invalid value format.", 400);
  if (err.code === "ECONNREFUSED")
    return new AppError(
      "Database connection refused. Please try again later.",
      503,
    );
  return null;
};

// ── handleMulterError ────────────────────────────────────────
// Map Multer upload errors to clean AppError responses.
const handleMulterError = (err) => {
  if (err.code === "LIMIT_FILE_SIZE")
    return new AppError("File is too large. Maximum size is 10MB.", 400);
  if (err.code === "LIMIT_FILE_COUNT")
    return new AppError("Too many files uploaded at once.", 400);
  if (err.code === "LIMIT_UNEXPECTED_FILE")
    return new AppError("Unexpected file field in upload.", 400);
  if (err.code === "INVALID_FILE_TYPE")
    return new AppError(err.message || "Unsupported file type.", 400);
  return null;
};

// ── logError ─────────────────────────────────────────────────
// Structured console logging per environment.
const logError = (err, req) => {
  const timestamp = new Date().toISOString();
  const user = req?.user
    ? `user_id=${req.user.id} role=${req.user.role}`
    : "unauthenticated";
  const route = req ? `${req.method} ${req.originalUrl}` : "unknown route";
  const ip = req?.ip || "unknown";

  if (process.env.NODE_ENV === "development") {
    console.error(chalk.red.bold(`\n❌ [${timestamp}] Error`));
    console.error(chalk.yellow(`   Route   : ${route}`));
    console.error(chalk.yellow(`   User    : ${user}`));
    console.error(chalk.yellow(`   IP      : ${ip}`));
    console.error(chalk.yellow(`   Message : ${err.message}`));
    console.error(chalk.yellow(`   Status  : ${err.statusCode || 500}`));
    console.error(chalk.red(`   Stack   :\n${err.stack}\n`));
  } else {
    // Production — JSON only, no stack traces
    console.error(
      JSON.stringify({
        timestamp,
        level: "error",
        route,
        user,
        ip,
        message: err.message,
        statusCode: err.statusCode || 500,
        isOperational: err.isOperational || false,
      }),
    );
  }
};

// ── globalErrorHandler ───────────────────────────────────────
// Express error handling middleware.
// Must be mounted LAST in app.js after all routes:
//   app.use(globalErrorHandler)
const globalErrorHandler = (err, req, res, next) => {
  let error = err;

  // Resolve known error types into AppError instances
  const jwtError = handleJwtError(err);
  const dbError = handleDbError(err);
  const multerError = handleMulterError(err);

  if (jwtError) error = jwtError;
  else if (dbError) error = dbError;
  else if (multerError) error = multerError;

  logError(error, req);

  const statusCode = error.statusCode || 500;
  const isDev = process.env.NODE_ENV === "development";

  // Non-operational errors (bugs) — hide details in production
  if (!error.isOperational && !isDev) {
    return res.status(500).json({
      status: "error",
      message: "Something went wrong. Please try again later.",
    });
  }

  return res.status(statusCode).json({
    status: "error",
    message: error.message,
    ...(isDev && { stack: error.stack }),
  });
};

// ── asyncHandler ─────────────────────────────────────────────
// Wraps async controller functions to catch rejected promises
// and forward them to globalErrorHandler automatically.
// Eliminates try/catch boilerplate in every controller.
//
// Usage:
//   router.get("/", asyncHandler(async (req, res) => { ... }));
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  AppError,
  globalErrorHandler,
  asyncHandler,
  // Factories
  notFound,
  unauthorized,
  forbidden,
  badRequest,
  conflict,
  serverError,
  unprocessable,
};
