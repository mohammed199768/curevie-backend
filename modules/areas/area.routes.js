// Service areas (districts). Patients pick one when ordering; providers are assigned the areas they cover.
const express = require('express');
const Joi = require('joi');
const pool = require('../../config/db');
const { guestOrAuthenticated, authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { AppError } = require('../../middlewares/errorHandler');
const cache = require('../../utils/cache');

const router = express.Router();

const AREA_CACHE_KEY = 'areas:public';
const slug = Joi.string().trim().lowercase().pattern(/^[a-z0-9_]{2,80}$/);
const idParams = Joi.object({ id: Joi.string().uuid().required() });
const listQuery = Joi.object({ include_inactive: Joi.boolean().default(false) });
const createSchema = Joi.object({
  slug: slug.required(),
  name_ar: Joi.string().trim().min(2).max(120).required(),
  name_en: Joi.string().trim().min(2).max(120).required(),
  city: Joi.string().trim().max(80).default('Amman'),
  sort_order: Joi.number().integer().min(0).max(10000).default(0),
});
const updateSchema = Joi.object({
  name_ar: Joi.string().trim().min(2).max(120),
  name_en: Joi.string().trim().min(2).max(120),
  city: Joi.string().trim().max(80),
  sort_order: Joi.number().integer().min(0).max(10000),
  is_active: Joi.boolean(),
}).min(1);

router.get(
  '/',
  guestOrAuthenticated,
  readLimiter,
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user?.role === 'ADMIN';

    if (!isAdmin) {
      const cached = await cache.get(AREA_CACHE_KEY);
      if (cached) return res.json(cached);
      const { rows } = await pool.query(
        `SELECT id, slug, name_ar, name_en, city FROM areas WHERE is_active = TRUE ORDER BY sort_order, name_en`
      );
      const response = { data: rows };
      await cache.set(AREA_CACHE_KEY, response, 600);
      return res.json(response);
    }

    const { rows } = await pool.query(
      `SELECT a.*,
              (SELECT COUNT(*)::int FROM provider_areas pa
               JOIN service_providers sp ON sp.id = pa.provider_id
               WHERE pa.area_id = a.id AND sp.deleted_at IS NULL AND sp.is_active = TRUE) AS providers_count
       FROM areas a
       WHERE ($1::boolean OR a.is_active = TRUE)
       ORDER BY a.sort_order, a.name_en`,
      [req.query.include_inactive]
    );
    return res.json({ data: rows });
  })
);

router.post(
  '/',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { slug: areaSlug, name_ar: nameAr, name_en: nameEn, city, sort_order: sortOrder } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO areas (slug, name_ar, name_en, city, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [areaSlug, nameAr, nameEn, city, sortOrder]
    );
    await cache.del(AREA_CACHE_KEY);
    return res.status(201).json(rows[0]);
  })
);

router.put(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(idParams, 'params'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const fields = Object.keys(req.body);
    const sets = fields.map((field, index) => `${field} = $${index + 2}`);
    const { rows } = await pool.query(
      `UPDATE areas SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, ...fields.map((field) => req.body[field])]
    );
    if (!rows[0]) throw new AppError('Area not found', 404, 'NOT_FOUND');
    await cache.del(AREA_CACHE_KEY);
    return res.json(rows[0]);
  })
);

module.exports = router;
