// pagination.js
// ============================================================
// Shared pagination utilities used across all controllers
// Consistent with the { data, pagination } response shape
// used in every model across the codebase
// ============================================================

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── getPagination ────────────────────────────────────────────
// Extract and sanitize page/limit from req.query
//
// Usage:
//   const { page, limit, offset } = getPagination(req.query);
const getPagination = (query = {}) => {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);

  if (isNaN(page) || page < 1) page = DEFAULT_PAGE;
  if (isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

// ── buildPaginationResponse ──────────────────────────────────
// Build consistent paginated response envelope
//
// Usage:
//   return res.json(buildPaginationResponse({ data, total, page, limit }));
const buildPaginationResponse = ({ data, total, page, limit }) => {
  const totalPages = Math.ceil(total / limit) || 1;
  return {
    data,
    pagination: {
      total,
      page,
      limit,
      total_pages: totalPages,
      has_next_page: page < totalPages,
      has_prev_page: page > 1,
    },
  };
};

// ── getPaginationLinks ───────────────────────────────────────
// Generate hypermedia next/prev URL links (optional)
//
// Usage:
//   const links = getPaginationLinks(req, page, limit, total);
const getPaginationLinks = (req, page, limit, total) => {
  const totalPages = Math.ceil(total / limit) || 1;
  const baseUrl = `${req.protocol}://${req.get("host")}${req.path}`;
  const buildUrl = (p) => `${baseUrl}?page=${p}&limit=${limit}`;
  return {
    self: buildUrl(page),
    first: buildUrl(1),
    last: buildUrl(totalPages),
    next: page < totalPages ? buildUrl(page + 1) : null,
    prev: page > 1 ? buildUrl(page - 1) : null,
  };
};

// ── paginateArray ────────────────────────────────────────────
// Paginate an in-memory array when DB pagination isn't used
//
// Usage:
//   const result = paginateArray(allItems, page, limit);
const paginateArray = (arr, page = DEFAULT_PAGE, limit = DEFAULT_LIMIT) => {
  if (!Array.isArray(arr))
    throw new Error("paginateArray: first argument must be an array");
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, limit));
  const offset = (safePage - 1) * safeLimit;
  return buildPaginationResponse({
    data: arr.slice(offset, offset + safeLimit),
    total: arr.length,
    page: safePage,
    limit: safeLimit,
  });
};

// ── parsePaginationFromQuery ─────────────────────────────────
// Convenience wrapper that also returns search/filter params
//
// Usage:
//   const { page, limit, offset, search, status } = parsePaginationFromQuery(req.query);
const parsePaginationFromQuery = (query = {}) => {
  const { page, limit, offset } = getPagination(query);
  return {
    page,
    limit,
    offset,
    search: query.search ? String(query.search).trim() : null,
    status: query.status ? String(query.status).trim() : null,
    role: query.role ? String(query.role).trim() : null,
    sortBy: query.sort_by ? String(query.sort_by).trim() : "created_at",
    order: query.order && query.order.toUpperCase() === "ASC" ? "ASC" : "DESC",
  };
};

module.exports = {
  getPagination,
  buildPaginationResponse,
  getPaginationLinks,
  paginateArray,
  parsePaginationFromQuery,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
