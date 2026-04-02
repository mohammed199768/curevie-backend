const express = require('express');
const Joi = require('joi');
const { authenticate } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const pool = require('../../config/db');
const NotificationRepository = require('../../repositories/NotificationRepository');
const notificationService = require('./notification.service'); // AUDIT-FIX: P3-STEP8-DIP - notification routes now configure the service singleton explicitly.

const notifRepo = new NotificationRepository(pool);
notificationService.configureNotificationService(notifRepo); // AUDIT-FIX: P3-STEP8-DIP - route-level composition now wires the backward-compatible notification singleton explicitly.
const notifService = notificationService; // AUDIT-FIX: P3-STEP8-COMPAT - keep the existing local service variable shape for route handlers.

const router = express.Router();

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  unread_only: Joi.boolean().default(false),
});

router.get('/', authenticate, readLimiter, asyncHandler(async (req, res) => {
  const { error, value } = listQuerySchema.validate(req.query, { convert: true, stripUnknown: true });
  if (error) {
    return res.status(400).json({ message: error.details[0].message, code: 'VALIDATION_ERROR' });
  }

  const result = await notifService.getNotifications(
    req.user.id,
    req.user.role,
    { page: value.page, limit: value.limit, unreadOnly: value.unread_only }
  );

  return res.json(result);
}));

router.put('/read-all', authenticate, apiLimiter, asyncHandler(async (req, res) => {
  const count = await notifService.markAllAsRead(req.user.id, req.user.role);
  return res.json({ message: `${count} notifications marked as read`, count });
}));

router.put('/:id/read', authenticate, asyncHandler(async (req, res) => {
  const notif = await notifService.markAsRead(req.params.id, req.user.id);
  if (!notif) {
    return res.status(404).json({ message: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
  }

  return res.json(notif);
}));

router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  const deleted = await notifService.deleteNotification(req.params.id, req.user.id);
  if (!deleted) {
    return res.status(404).json({ message: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
  }

  return res.json({ message: 'Notification deleted successfully' });
}));

module.exports = router;
