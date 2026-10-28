const express = require('express');
const Joi = require('joi');
const { authenticate } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const notificationService = require('./notification.service');

const router = express.Router();

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  unread_only: Joi.boolean().default(false),
});
const idParamSchema = Joi.object({ id: Joi.string().uuid().required() });

router.use(authenticate);

router.get('/', readLimiter, validate(listQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const result = await notificationService.getNotifications(req.user.id, req.user.role, {
    page: req.query.page,
    limit: req.query.limit,
    unreadOnly: req.query.unread_only,
  });
  return res.json(result);
}));

router.put('/read-all', apiLimiter, asyncHandler(async (req, res) => {
  const count = await notificationService.markAllAsRead(req.user.id, req.user.role);
  return res.json({ message: `${count} notifications marked as read`, count });
}));

router.put('/:id/read', apiLimiter, validate(idParamSchema, 'params'), asyncHandler(async (req, res) => {
  const notification = await notificationService.markAsRead(req.params.id, req.user.id, req.user.role);
  if (!notification) {
    return res.status(404).json({ message: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
  }
  return res.json(notification);
}));

router.delete('/:id', apiLimiter, validate(idParamSchema, 'params'), asyncHandler(async (req, res) => {
  const deleted = await notificationService.deleteNotification(req.params.id, req.user.id, req.user.role);
  if (!deleted) {
    return res.status(404).json({ message: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
  }
  return res.json({ message: 'Notification deleted successfully' });
}));

module.exports = router;
