// ═══════════════════════════════════════════════════════════════
// GET /api/admin/plazas
// All plazas platform-wide — paginated.
// Query params: page, limit, search, landlord_id
// ═══════════════════════════════════════════════════════════════
const getAllPlazas = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { search } = req.query;
  const landlordId = parseId(req.query.landlord_id);

  const conditions = ["p.deleted_at IS NULL"];
  const params = [];

  if (search) {
    conditions.push("(p.name LIKE ? OR p.location LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (landlordId) {
    conditions.push("p.landlord_id = ?");
    params.push(landlordId);
  }

  const WHERE = `WHERE ${conditions.join(" AND ")}`;

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM plazas p ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT
       p.id, p.name, p.location, p.total_units, p.image_url,
       p.created_at,
       u.id   AS landlord_id,
       u.full_name  AS landlord_name,
       u.username   AS landlord_username,
       u.email      AS landlord_email,
       (SELECT COUNT(*) FROM tenancies t WHERE t.plaza_id = p.id AND t.status = 'active') AS occupied_units
     FROM plazas p
     JOIN users u ON u.id = p.landlord_id
     ${WHERE}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/admin/leases
// All tenancies (leases) platform-wide — paginated.
// Query params: page, limit, status, search, plaza_id
// ═══════════════════════════════════════════════════════════════
const getAllLeases = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || DEFAULT_LIMIT);
  const offset = (page - 1) * limit;
  const { status, search } = req.query;
  const plazaId = parseId(req.query.plaza_id);

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push("t.status = ?");
    params.push(status);
  }
  if (plazaId) {
    conditions.push("t.plaza_id = ?");
    params.push(plazaId);
  }
  if (search) {
    conditions.push(
      "(tenant.full_name LIKE ? OR tenant.email LIKE ? OR p.name LIKE ?)",
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const WHERE = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM tenancies t
     JOIN users  tenant ON tenant.id = t.tenant_id
     JOIN plazas p      ON p.id      = t.plaza_id
     ${WHERE}`,
    params,
  );

  const [rows] = await db.query(
    `SELECT
       t.id, t.unit_number, t.rent_amount, t.security_deposit,
       t.lease_start, t.lease_end, t.status, t.created_at,
       tenant.id         AS tenant_id,
       tenant.full_name  AS tenant_name,
       tenant.username   AS tenant_username,
       tenant.email      AS tenant_email,
       p.id              AS plaza_id,
       p.name            AS plaza_name,
       p.location        AS plaza_location,
       landlord.id       AS landlord_id,
       landlord.full_name  AS landlord_name,
       landlord.username   AS landlord_username,
       landlord.email      AS landlord_email
     FROM tenancies t
     JOIN users  tenant   ON tenant.id   = t.tenant_id
     JOIN plazas p        ON p.id        = t.plaza_id
     JOIN users  landlord ON landlord.id = p.landlord_id
     ${WHERE}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return res.json({
    success: true,
    ...buildPaginationResponse({ data: rows, total, page, limit }),
  });
});
