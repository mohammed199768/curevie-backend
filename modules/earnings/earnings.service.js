/**
 * Provider earnings.
 *
 * Every catalog item (service or package) may carry its own provider share: a PERCENT of the line
 * price or a FIXED amount. Items without one use the "earnings.default_share" setting. The base is
 * the price the patient pays for the line (bundle_price, i.e. after any VIP discount); invoice-level
 * adjustments do not change it. A FIXED share never exceeds the line price.
 *
 * When a provider completes a line, the share is calculated once and locked into provider_earnings.
 * Later catalog or setting edits never change a locked row; an admin can correct a PENDING row
 * with a reason (the calculated amount is kept for review). Payouts mark PENDING rows as PAID.
 */
const pool = require('../../config/db');
const SettingsRepository = require('../../repositories/SettingsRepository');
const { AppError } = require('../../middlewares/errorHandler');

const settingsRepo = new SettingsRepository(pool);
const FALLBACK_DEFAULT_SHARE = { type: 'PERCENT', value: 0 };

const toMoney = (value) => Math.round(Number(value || 0) * 1000) / 1000;

function calculate(base, share) {
  const price = toMoney(base);
  const value = Number(share.value);
  if (share.type === 'FIXED') return toMoney(Math.min(value, price));
  return toMoney((price * value) / 100);
}

async function defaultShare(db) {
  return (await settingsRepo.get('earnings.default_share', db)) || FALLBACK_DEFAULT_SHARE;
}

/**
 * Share rule and resulting amount for each line item id (estimate, nothing is stored).
 * @returns {Promise<Map<string, {base_amount, share_type, share_value, share_source, amount}>>}
 */
async function estimateForLines(lineIds, db = pool) {
  const ids = [...new Set(lineIds.filter(Boolean))];
  if (!ids.length) return new Map();

  const [fallback, { rows }] = await Promise.all([
    defaultShare(db),
    db.query(
      `SELECT cs.id, cs.bundle_price,
              COALESCE(s.provider_share_type, p.provider_share_type) AS share_type,
              COALESCE(s.provider_share_value, p.provider_share_value) AS share_value
       FROM case_services cs
       LEFT JOIN services s ON cs.item_type = 'SERVICE' AND s.id = cs.service_id
       LEFT JOIN packages p ON cs.item_type = 'PACKAGE' AND p.id = cs.package_id
       WHERE cs.id = ANY($1::uuid[])`,
      [ids]
    ),
  ]);

  return new Map(rows.map((row) => {
    const share = row.share_type
      ? { type: row.share_type, value: Number(row.share_value), source: 'ITEM' }
      : { type: fallback.type, value: Number(fallback.value), source: 'DEFAULT' };
    return [row.id, {
      base_amount: toMoney(row.bundle_price),
      share_type: share.type,
      share_value: share.value,
      share_source: share.source,
      amount: calculate(row.bundle_price, share),
    }];
  }));
}

/** Locks the earning of a line the provider just completed (inside the completion transaction). */
async function lockForCompletedLine(client, line, providerId) {
  const estimate = (await estimateForLines([line.id], client)).get(line.id);
  if (!estimate) return null;
  const { rows } = await client.query(
    `INSERT INTO provider_earnings
       (provider_id, case_id, case_service_id, item_name, base_amount, share_type, share_value,
        share_source, amount, calculated_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (case_service_id) DO NOTHING
     RETURNING *`,
    [providerId, line.case_id, line.id, line.item_name, estimate.base_amount, estimate.share_type,
      estimate.share_value, estimate.share_source, estimate.amount]
  );
  return rows[0] || null;
}

/** Locked earnings of a case keyed by line id. */
async function lockedForCase(caseId, db = pool) {
  const { rows } = await db.query(
    'SELECT case_service_id, amount, status, share_type, share_value, share_source FROM provider_earnings WHERE case_id = $1',
    [caseId]
  );
  return new Map(rows.map((row) => [row.case_service_id, row]));
}

/** Only open lines get an estimate: a completed line without a locked row predates earnings and has none. */
const ESTIMABLE_STATUSES = ['PENDING', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'];

/**
 * Earning to show on each line: the locked row when it exists, otherwise the current estimate.
 * @returns {Promise<Map<string, object>>}
 */
async function earningsForLines(caseId, lines, db = pool) {
  const locked = await lockedForCase(caseId, db);
  const estimates = await estimateForLines(
    lines.filter((line) => !locked.has(line.id) && ESTIMABLE_STATUSES.includes(line.status)).map((line) => line.id),
    db
  );
  return new Map(lines.map((line) => {
    const row = locked.get(line.id);
    if (row) {
      return [line.id, {
        amount: Number(row.amount), locked: true, status: row.status,
        share_type: row.share_type, share_value: Number(row.share_value), share_source: row.share_source,
      }];
    }
    const estimate = estimates.get(line.id);
    return [line.id, estimate ? { ...estimate, locked: false, status: null } : null];
  }));
}

const EARNING_COLUMNS = `
  e.id, e.provider_id, sp.full_name AS provider_name, e.case_id, e.case_service_id, e.item_name,
  e.base_amount, e.share_type, e.share_value, e.share_source, e.amount, e.calculated_amount,
  e.adjustment_reason, e.adjusted_at, e.status, e.payout_id, e.paid_at, e.created_at,
  COALESCE(pt.full_name, c.guest_name) AS patient_name, a.name_ar AS area_name_ar, a.name_en AS area_name_en
`;
const EARNING_JOINS = `
  FROM provider_earnings e
  JOIN service_providers sp ON sp.id = e.provider_id
  JOIN cases c ON c.id = e.case_id
  LEFT JOIN patients pt ON pt.id = c.patient_id
  LEFT JOIN areas a ON a.id = c.area_id
`;

function earningsFilter({ providerId, status, from, to }) {
  const params = [];
  const where = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  if (providerId) where.push(`e.provider_id = ${add(providerId)}`);
  if (status) where.push(`e.status = ${add(status)}`);
  if (from) where.push(`e.created_at >= ${add(from)}::timestamptz`);
  if (to) where.push(`e.created_at < ${add(to)}::timestamptz`);
  return { params, add, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

async function listEarnings(filters, { page, limit }) {
  const { params, add, whereSql } = earningsFilter(filters);
  const countParams = [...params];
  const [rows, count, totals] = await Promise.all([
    pool.query(
      `SELECT ${EARNING_COLUMNS} ${EARNING_JOINS} ${whereSql}
       ORDER BY e.created_at DESC LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM provider_earnings e ${whereSql}`, countParams),
    pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0) AS pending_total,
              COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
              COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS paid_total,
              COALESCE(SUM(amount), 0) AS lifetime_total,
              COUNT(*)::int AS jobs_count
       FROM provider_earnings e ${whereSql}`,
      countParams
    ),
  ]);
  const summary = totals.rows[0];
  return {
    data: rows.rows,
    summary: {
      pending_total: Number(summary.pending_total),
      pending_count: summary.pending_count,
      paid_total: Number(summary.paid_total),
      lifetime_total: Number(summary.lifetime_total),
      jobs_count: summary.jobs_count,
    },
    total: count.rows[0].total,
  };
}

/** Balance per provider, for the admin overview. */
async function providerBalances() {
  const { rows } = await pool.query(
    `SELECT sp.id AS provider_id, sp.full_name, sp.type, sp.phone, sp.is_active,
            COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PENDING'), 0) AS pending_total,
            COUNT(e.id) FILTER (WHERE e.status = 'PENDING')::int AS pending_count,
            COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PAID'), 0) AS paid_total,
            COUNT(e.id)::int AS jobs_count,
            (SELECT MAX(created_at) FROM provider_payouts po WHERE po.provider_id = sp.id) AS last_payout_at
     FROM service_providers sp
     LEFT JOIN provider_earnings e ON e.provider_id = sp.id
     GROUP BY sp.id
     HAVING COUNT(e.id) > 0 OR sp.is_active
     ORDER BY pending_total DESC, sp.full_name`
  );
  return rows.map((row) => ({
    ...row,
    pending_total: Number(row.pending_total),
    paid_total: Number(row.paid_total),
  }));
}

async function listPayouts({ providerId, limit = 50 }) {
  const params = [limit];
  const where = providerId ? `WHERE po.provider_id = $2` : '';
  if (providerId) params.push(providerId);
  const { rows } = await pool.query(
    `SELECT po.*, sp.full_name AS provider_name, adm.full_name AS created_by_name,
            (SELECT COUNT(*)::int FROM provider_earnings e WHERE e.payout_id = po.id) AS earnings_count
     FROM provider_payouts po
     JOIN service_providers sp ON sp.id = po.provider_id
     LEFT JOIN admins adm ON adm.id = po.created_by
     ${where}
     ORDER BY po.created_at DESC
     LIMIT $1`,
    params
  );
  return rows;
}

/** Pays out PENDING earnings of one provider (all of them, or the given ids). */
async function createPayout(admin, { provider_id: providerId, earning_ids: earningIds, method, reference, notes }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: earnings } = await client.query(
      `SELECT id, amount FROM provider_earnings
       WHERE provider_id = $1 AND status = 'PENDING' ${earningIds?.length ? 'AND id = ANY($2::uuid[])' : ''}
       ORDER BY created_at
       FOR UPDATE`,
      earningIds?.length ? [providerId, earningIds] : [providerId]
    );
    if (earningIds?.length && earnings.length !== new Set(earningIds).size) {
      throw new AppError('Some earnings are not pending for this provider', 409, 'EARNINGS_NOT_PENDING');
    }
    if (!earnings.length) throw new AppError('Nothing to pay out', 409, 'NOTHING_TO_PAY');

    const amount = toMoney(earnings.reduce((sum, row) => sum + Number(row.amount), 0));
    if (amount <= 0) throw new AppError('The selected earnings total zero', 409, 'NOTHING_TO_PAY');

    const { rows } = await client.query(
      `INSERT INTO provider_payouts (provider_id, amount, method, reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [providerId, amount, method, reference || null, notes || null, admin.id]
    );
    await client.query(
      `UPDATE provider_earnings SET status = 'PAID', payout_id = $1, paid_at = NOW()
       WHERE id = ANY($2::uuid[])`,
      [rows[0].id, earnings.map((row) => row.id)]
    );
    await client.query('COMMIT');
    return { payout: rows[0], earnings_count: earnings.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Corrects a PENDING earning; the calculated amount stays for review. */
async function adjustEarning(admin, earningId, { amount, reason }) {
  const { rows } = await pool.query(
    `UPDATE provider_earnings
     SET amount = $2, adjustment_reason = $3, adjusted_by = $4, adjusted_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING *`,
    [earningId, toMoney(amount), reason, admin.id]
  );
  if (rows[0]) return rows[0];
  const exists = await pool.query('SELECT status FROM provider_earnings WHERE id = $1', [earningId]);
  if (!exists.rows[0]) throw new AppError('Earning not found', 404, 'NOT_FOUND');
  throw new AppError('Paid earnings cannot be changed', 409, 'EARNING_PAID');
}

module.exports = {
  ESTIMABLE_STATUSES,
  calculate,
  estimateForLines,
  lockForCompletedLine,
  earningsForLines,
  listEarnings,
  providerBalances,
  listPayouts,
  createPayout,
  adjustEarning,
};
