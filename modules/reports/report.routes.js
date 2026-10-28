// Admin financial reporting on cases. All day/month boundaries are computed in Asia/Amman.
const express = require('express');
const Joi = require('joi');
const pool = require('../../config/db');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { SERVICE_KIND_SQL } = require('../cases/case.constants');

const router = express.Router();

const TIME_ZONE = 'Asia/Amman';
const dateOnly = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const financialQuerySchema = Joi.object({
  period: Joi.string().valid('daily', 'monthly', 'yearly').default('monthly'),
  from: dateOnly,
  to: dateOnly,
  year: Joi.number().integer().min(2000).max(2100),
  month: Joi.number().integer().min(1).max(12),
});

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Today's date in Amman as { y, m, d }. */
function ammanToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves the report window as local Amman dates: [fromDate, toDateExclusive).
 */
function resolveRange({ period, from, to, year, month }) {
  const today = ammanToday();
  if (from || to) {
    return { period: 'custom', fromDate: from || '2000-01-01', toDate: addDays(to || `${today.y}-${pad(today.m)}-${pad(today.d)}`, 1) };
  }
  if (period === 'daily') {
    const day = `${today.y}-${pad(today.m)}-${pad(today.d)}`;
    return { period, fromDate: day, toDate: addDays(day, 1) };
  }
  const y = year || today.y;
  if (period === 'yearly') return { period, fromDate: `${y}-01-01`, toDate: `${y + 1}-01-01` };
  const m = month || today.m;
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  return { period, fromDate: `${y}-${pad(m)}-01`, toDate: nextMonth };
}

const IN_RANGE = (column) => `${column} >= ($1::date)::timestamp AT TIME ZONE '${TIME_ZONE}'
  AND ${column} < ($2::date)::timestamp AT TIME ZONE '${TIME_ZONE}'`;

router.get(
  '/cases/financial',
  authenticate,
  adminOnly,
  readLimiter,
  validate(financialQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const range = resolveRange(req.query);
    const params = [range.fromDate, range.toDate];

    const [summary, cases, collections, methods, topServices, daily, register] = await Promise.all([
      // Billing of the cases created in the window (cancelled invoices excluded from revenue).
      pool.query(`
        SELECT
          COUNT(*)::int AS total_invoices,
          COUNT(*) FILTER (WHERE ci.payment_status = 'PAID')::int AS paid_invoices,
          COUNT(*) FILTER (WHERE ci.payment_status = 'PARTIAL')::int AS partial_invoices,
          COUNT(*) FILTER (WHERE ci.payment_status = 'PENDING')::int AS pending_invoices,
          COUNT(*) FILTER (WHERE ci.payment_status = 'CANCELLED')::int AS cancelled_invoices,
          COALESCE(SUM(ci.original_amount) FILTER (WHERE ci.payment_status <> 'CANCELLED'), 0) AS gross_revenue,
          COALESCE(SUM(ci.final_amount) FILTER (WHERE ci.payment_status <> 'CANCELLED'), 0) AS net_revenue,
          COALESCE(SUM(ci.remaining_amount) FILTER (WHERE ci.payment_status <> 'CANCELLED'), 0) AS pending_revenue,
          COALESCE(SUM(GREATEST(ci.original_amount - ci.final_amount, 0))
            FILTER (WHERE ci.payment_status <> 'CANCELLED'), 0) AS total_discounts
        FROM case_invoices ci
        JOIN cases c ON c.id = ci.case_id
        WHERE ${IN_RANGE('c.created_at')}
      `, params),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_cases,
          COUNT(*) FILTER (WHERE c.status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE c.status = 'ACCEPTED')::int AS accepted,
          COUNT(*) FILTER (WHERE c.status = 'IN_PROGRESS')::int AS in_progress,
          COUNT(*) FILTER (WHERE c.status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE c.status = 'CLOSED')::int AS closed,
          COUNT(*) FILTER (WHERE c.status = 'CANCELLED')::int AS cancelled,
          COUNT(*) FILTER (WHERE c.patient_id IS NULL)::int AS guest_cases,
          COUNT(*) FILTER (WHERE c.patient_id IS NOT NULL)::int AS patient_cases
        FROM cases c
        WHERE ${IN_RANGE('c.created_at')}
      `, params),
      // Money actually received in the window, whatever day the case was created.
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS collected_revenue, COUNT(*)::int AS payments_count
        FROM case_payment_records
        WHERE approval_status = 'APPROVED' AND ${IN_RANGE('created_at')}
      `, params),
      pool.query(`
        SELECT method AS payment_method, COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total
        FROM case_payment_records
        WHERE approval_status = 'APPROVED' AND ${IN_RANGE('created_at')}
        GROUP BY method
        ORDER BY total DESC
      `, params),
      pool.query(`
        SELECT cs.item_name AS service_name, cs.item_type, ${SERVICE_KIND_SQL} AS service_kind,
               COUNT(*)::int AS count, COALESCE(SUM(cs.bundle_price), 0) AS revenue
        FROM case_services cs
        JOIN cases c ON c.id = cs.case_id
        LEFT JOIN services s ON s.id = cs.service_id
        WHERE cs.status <> 'CANCELLED' AND ${IN_RANGE('c.created_at')}
        GROUP BY cs.item_name, cs.item_type, service_kind
        ORDER BY revenue DESC, count DESC
        LIMIT 10
      `, params),
      pool.query(`
        WITH days AS (
          SELECT (c.created_at AT TIME ZONE '${TIME_ZONE}')::date AS date,
                 COUNT(*)::int AS cases,
                 COALESCE(SUM(ci.final_amount) FILTER (WHERE ci.payment_status <> 'CANCELLED'), 0) AS revenue
          FROM cases c
          LEFT JOIN case_invoices ci ON ci.case_id = c.id
          WHERE ${IN_RANGE('c.created_at')}
          GROUP BY 1
        ),
        paid AS (
          SELECT (created_at AT TIME ZONE '${TIME_ZONE}')::date AS date, COALESCE(SUM(amount), 0) AS collected
          FROM case_payment_records
          WHERE approval_status = 'APPROVED' AND ${IN_RANGE('created_at')}
          GROUP BY 1
        )
        SELECT COALESCE(days.date, paid.date) AS date,
               COALESCE(days.cases, 0) AS cases,
               COALESCE(days.revenue, 0) AS revenue,
               COALESCE(paid.collected, 0) AS collected
        FROM days FULL OUTER JOIN paid ON paid.date = days.date
        ORDER BY 1
      `, params),
      pool.query(`
        SELECT
          c.id AS case_id, cs.id AS case_service_id, ci.id AS invoice_id,
          cs.provider_id, COALESCE(sp.full_name, 'Unassigned') AS provider_name,
          COALESCE(p.full_name, c.guest_name, '-') AS patient_name,
          cs.item_name AS service_name, cs.item_type, ${SERVICE_KIND_SQL} AS service_kind,
          cs.bundle_price AS amount, cs.status::text AS service_status,
          COALESCE(ci.payment_status::text, 'PENDING') AS payment_status,
          c.status::text AS case_status, c.created_at, ci.approved_at AS paid_at
        FROM case_services cs
        JOIN cases c ON c.id = cs.case_id
        LEFT JOIN services s ON s.id = cs.service_id
        LEFT JOIN patients p ON p.id = c.patient_id
        LEFT JOIN case_invoices ci ON ci.case_id = c.id
        LEFT JOIN service_providers sp ON sp.id = cs.provider_id
        WHERE ${IN_RANGE('c.created_at')}
        ORDER BY c.created_at DESC, cs.created_at ASC
        LIMIT 2000
      `, params),
    ]);

    res.json({
      period: { type: range.period, from: range.fromDate, to_exclusive: range.toDate, time_zone: TIME_ZONE },
      summary: { ...summary.rows[0], ...collections.rows[0] },
      cases: cases.rows[0],
      payment_methods: methods.rows,
      top_services: topServices.rows,
      daily_breakdown: daily.rows,
      case_register: register.rows,
    });
  })
);

module.exports = router;
