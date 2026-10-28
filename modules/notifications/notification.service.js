const pool = require('../../config/db');
const NotificationRepository = require('../../repositories/NotificationRepository');
const { emitToUser } = require('../../utils/socket');
const { paginate, paginationMeta } = require('../../utils/pagination');
const { logger } = require('../../utils/logger');
const { t } = require('../../utils/i18n/ar');

const NOTIF_TYPES = {
  CASE_CREATED: 'CASE_CREATED',
  CASE_ASSIGNED: 'CASE_ASSIGNED',
  CASE_UPDATED: 'CASE_UPDATED',
  CASE_COMPLETED: 'CASE_COMPLETED',
  CASE_CANCELLED: 'CASE_CANCELLED',
  CASE_CLOSED: 'CASE_CLOSED',
  APPOINTMENT_SCHEDULED: 'APPOINTMENT_SCHEDULED',
  SERVICE_RATED: 'SERVICE_RATED',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_PARTIAL: 'PAYMENT_PARTIAL',
  INVOICE_PAID: 'INVOICE_PAID',
  VIP_GRANTED: 'VIP_GRANTED',
  REPORT_PUBLISHED: 'REPORT_PUBLISHED',
};

function createNotificationService(notifRepo) {
  async function emitUnreadUpdate(userId, userRole) {
    if (!userId || !userRole) return;
    try {
      const unreadCount = await notifRepo.countUnread(userId, userRole);
      emitToUser(userId, 'notification_unread_updated', { unread_count: Number(unreadCount || 0) });
    } catch (_) {
      // Socket delivery must never block the main flow.
    }
  }

  /**
   * Stores notifications and pushes a live unread-count update to every recipient.
   * @param {Array<{userId, userRole, type, title, body, data}>} notifications
   */
  async function createMany(notifications) {
    const valid = notifications.filter((n) => n && n.userId && n.userRole);
    if (!valid.length) return [];

    await notifRepo.createMany(valid);

    const targets = new Map(valid.map((n) => [`${n.userRole}:${n.userId}`, n]));
    await Promise.all([...targets.values()].map((n) => emitUnreadUpdate(n.userId, n.userRole)));
    return valid;
  }

  async function createNotification(notification) {
    const [created] = await createMany([notification]);
    return created || null;
  }

  async function notifyAdmins({ type, title, body, data }) {
    const adminIds = await notifRepo.getAllAdminIds();
    return createMany(adminIds.map((adminId) => ({
      userId: adminId, userRole: 'ADMIN', type, title, body, data,
    })));
  }

  async function notifyPaymentReceived({ caseId, invoiceId, patientId, amount, remaining, method }) {
    const isPaid = Number(remaining) <= 0;
    const data = { case_id: caseId, invoice_id: invoiceId, amount, remaining, method };

    if (patientId) {
      await createNotification({
        userId: patientId,
        userRole: 'PATIENT',
        type: isPaid ? NOTIF_TYPES.INVOICE_PAID : NOTIF_TYPES.PAYMENT_PARTIAL,
        title: isPaid ? t('notifications.payment.invoice_paid_title') : t('notifications.payment.partial_title'),
        body: isPaid
          ? t('notifications.payment.invoice_paid_body')
          : t('notifications.payment.partial_body', { amount, remaining }),
        data,
      });
    }

    await notifyAdmins({
      type: NOTIF_TYPES.PAYMENT_RECEIVED,
      title: t('notifications.payment.admin_title'),
      body: t('notifications.payment.admin_body', {
        amount,
        method,
        statusDetail: isPaid
          ? t('notifications.payment.status_paid')
          : t('notifications.payment.status_remaining', { remaining }),
      }),
      data,
    });
  }

  async function notifyVipGranted({ patientId, discount }) {
    return createNotification({
      userId: patientId,
      userRole: 'PATIENT',
      type: NOTIF_TYPES.VIP_GRANTED,
      title: t('notifications.vip.title'),
      body: t('notifications.vip.body', { discount }),
      data: { discount },
    });
  }

  async function getNotifications(userId, userRole, { page = 1, limit = 20, unreadOnly = false } = {}) {
    const { page: currentPage, limit: currentLimit, offset } = paginate({ page, limit });
    const { data, total, unread_count } = await notifRepo.getNotifications(
      userId,
      userRole,
      { limit: currentLimit, offset, unreadOnly }
    );
    return { data, pagination: paginationMeta(total, currentPage, currentLimit), unread_count };
  }

  async function markAsRead(notificationId, userId, userRole) {
    const notification = await notifRepo.markAsRead(notificationId, userId, userRole);
    if (notification) await emitUnreadUpdate(userId, userRole);
    return notification;
  }

  async function markAllAsRead(userId, userRole) {
    const count = await notifRepo.markAllAsRead(userId, userRole);
    await emitUnreadUpdate(userId, userRole);
    return count;
  }

  async function deleteNotification(notificationId, userId, userRole) {
    const deleted = await notifRepo.deleteNotification(notificationId, userId, userRole);
    if (deleted) await emitUnreadUpdate(userId, userRole);
    return deleted;
  }

  return {
    NOTIF_TYPES,
    createNotification,
    createMany,
    notifyAdmins,
    notifyPaymentReceived,
    notifyVipGranted,
    getNotifications,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  };
}

const notificationService = createNotificationService(new NotificationRepository(pool));

/**
 * Runs a notification side effect after the main operation committed.
 * Failures are logged and never surface to the API caller.
 */
function notifySafely(label, fn) {
  return Promise.resolve()
    .then(fn)
    .catch((err) => logger.warn('NOTIFICATION_FAILED', { label, message: err.message }));
}

module.exports = {
  ...notificationService,
  createNotificationService,
  notifySafely,
};
