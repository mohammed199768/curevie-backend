const express = require('express');
const Joi = require('joi');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const pool = require('../../config/db');
const NotificationRepository = require('../../repositories/NotificationRepository');
const { createNotificationService } = require('../notifications/notification.service');

const router = express.Router();
const notifRepo = new NotificationRepository(pool);
const notifService = createNotificationService(notifRepo);

const submitSchema = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  email: Joi.string().email().trim().max(255).required(),
  phone: Joi.string().trim().max(30).allow('', null).optional(),
  message: Joi.string().trim().min(5).max(2000).required(),
});

// POST /api/v1/contact — public, no auth required
router.post('/', apiLimiter, asyncHandler(async (req, res) => {
  const { error, value } = submitSchema.validate(req.body, { stripUnknown: true });
  if (error) {
    return res.status(400).json({ message: error.details[0].message, code: 'VALIDATION_ERROR' });
  }

  const result = await pool.query(
    `INSERT INTO contact_messages (name, email, phone, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [value.name, value.email, value.phone || null, value.message]
  );

  // Notifications are best-effort only.
  try {
    const adminIds = await notifRepo.getAllAdminIds();

    await Promise.allSettled(adminIds.map((adminId) =>
      notifService.createNotification({
        userId: adminId,
        userRole: 'ADMIN',
        type: 'CONTACT_MESSAGE',
        title: `رسالة جديدة من ${value.name}`,
        body: value.message.slice(0, 120),
        data: { contact_message_id: result.rows[0].id },
      })
    ));
  } catch (_) {
    // Do not fail the public submission when notification fan-out fails.
  }

  return res.status(201).json({ message: 'Message received', id: result.rows[0].id });
}));

// GET /api/v1/contact — admin only
router.get('/', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const [countResult, unreadResult, dataResult] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM contact_messages'),
    pool.query('SELECT COUNT(*)::int AS unread_count FROM contact_messages WHERE is_read = FALSE'),
    pool.query(
      `SELECT id, name, email, phone, message, is_read, read_at, created_at
       FROM contact_messages
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
  ]);

  const total = countResult.rows[0]?.total || 0;

  return res.json({
    data: dataResult.rows,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    },
    unread_count: unreadResult.rows[0]?.unread_count || 0,
  });
}));

// PUT /api/v1/contact/:id/read — admin only
router.put('/:id/read', authenticate, adminOnly, apiLimiter, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE contact_messages
     SET is_read = TRUE, read_by = $1, read_at = NOW()
     WHERE id = $2
     RETURNING id`,
    [req.user.id, req.params.id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ message: 'Contact message not found', code: 'CONTACT_MESSAGE_NOT_FOUND' });
  }

  return res.json({ message: 'Marked as read' });
}));

module.exports = router;
