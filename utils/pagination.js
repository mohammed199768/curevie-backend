// AUDIT-FIX: Q2 — centralized pagination utility
// Replaces 12+ duplicated instances of: const offset = (page - 1) * limit
// Usage: const { page, limit, offset } = paginate(req.query);

/**
 * Safely parse and calculate pagination parameters.
 * @param {object} query - req.query or any object with page/limit
 * @param {object} defaults - override default page size
 * @returns {{ page: number, limit: number, offset: number }}
 */
function paginate(query = {}, defaults = {}) {
  const maxLimit = defaults.maxLimit ?? 100;
  const defaultLimit = defaults.defaultLimit ?? 20;

  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit) || defaultLimit));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Build a standard pagination response object.
 * @param {number} total - total record count
 * @param {number} page
 * @param {number} limit
 */
function paginationMeta(total, page, limit) {
  return {
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };
}

module.exports = { paginate, paginationMeta };
