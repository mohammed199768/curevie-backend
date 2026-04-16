const { emitToUser } = require('../../utils/socket');
const { paginate, paginationMeta } = require('../../utils/pagination');
const { t } = require('../../utils/i18n/ar');

const NOTIF_TYPES = {
  REQUEST_CREATED: 'REQUEST_CREATED',
  REQUEST_ACCEPTED: 'REQUEST_ACCEPTED',
  REQUEST_ASSIGNED: 'REQUEST_ASSIGNED',
  REQUEST_COMPLETED: 'REQUEST_COMPLETED',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
  CASE_ASSIGNED: 'CASE_ASSIGNED',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_PARTIAL: 'PAYMENT_PARTIAL',
  INVOICE_PAID: 'INVOICE_PAID',
  VIP_GRANTED: 'VIP_GRANTED',
  POINTS_EARNED: 'POINTS_EARNED',
  COUPON_APPLIED: 'COUPON_APPLIED',
  REPORT_PUBLISHED: 'REPORT_PUBLISHED',
};

function createNotificationService(notifRepo) {
  async function emitNotificationUnreadUpdate(userId, userRole, client = null) {
    if (!userId || !userRole) return;

    try {
      const unreadCount = await notifRepo.countUnread(userId, userRole, client);
      emitToUser(userId, 'notification_unread_updated', {
        unread_count: Number(unreadCount || 0),
      });
    } catch {
      // Socket delivery should never block the main notification flow.
    }
  }

  async function createNotification(data, client = null) {
    const notification = await notifRepo.createNotification(data, client);
    await emitNotificationUnreadUpdate(data.userId, data.userRole, client);
    return notification;
  }

  async function createMany(notifications, client = null) {
    if (!notifications.length) return [];

    await notifRepo.createMany(notifications, client);

    const uniqueTargets = Array.from(
      new Map(
        notifications
          .filter((notification) => notification?.userId && notification?.userRole)
          .map((notification) => [
            `${notification.userRole}:${notification.userId}`,
            { userId: notification.userId, userRole: notification.userRole },
          ])
      ).values()
    );

    await Promise.all(
      uniqueTargets.map((target) =>
        emitNotificationUnreadUpdate(target.userId, target.userRole, client)
      )
    );

    return notifications;
  }

  async function notifyRequestCreated(
    { requestId, requestType, guestName, patientId, serviceType },
    client
  ) {
    const adminIds = await notifRepo.getAllAdminIds(client);

    if (adminIds.length) {
      const adminNotifs = adminIds.map((adminId) => ({
        userId: adminId,
        userRole: 'ADMIN',
        type: NOTIF_TYPES.REQUEST_CREATED,
        title: t('notifications.new_request.admin_title'),
        body: t('notifications.new_request.admin_body', {
          serviceType,
          requestSource:
            requestType === 'GUEST' ? guestName : t('labels.registered_patient'),
        }),
        data: { requestId, requestType, serviceType },
      }));
      await createMany(adminNotifs, client);
    }

    if (patientId) {
      await createNotification(
        {
          userId: patientId,
          userRole: 'PATIENT',
          type: NOTIF_TYPES.REQUEST_CREATED,
          title: t('notifications.new_request.patient_title'),
          body: t('notifications.new_request.patient_body', { serviceType }),
          data: { requestId, serviceType },
        },
        client
      );
    }
  }

  async function notifyRequestStatusChanged(
    { requestId, status, patientId, providerId, adminNotes },
    client
  ) {
    const statusMessages = {
      ACCEPTED: {
        title: t('notifications.request_status.accepted_title'),
        body: t('notifications.request_status.accepted_body'),
      },
      ASSIGNED: {
        title: t('notifications.request_status.assigned_title'),
        body: t('notifications.request_status.assigned_body'),
      },
      COMPLETED: {
        title: t('notifications.request_status.completed_title'),
        body: t('notifications.request_status.completed_body'),
      },
      CANCELLED: {
        title: t('notifications.request_status.cancelled_title'),
        body: adminNotes || t('notifications.request_status.cancelled_body'),
      },
    };

    const msg = statusMessages[status];
    if (!msg) return;

    const notifications = [];

    if (patientId) {
      notifications.push({
        userId: patientId,
        userRole: 'PATIENT',
        type: NOTIF_TYPES[`REQUEST_${status}`],
        title: msg.title,
        body: msg.body,
        data: { requestId, status },
      });
    }

    if (status === 'ASSIGNED' && providerId) {
      notifications.push({
        userId: providerId,
        userRole: 'PROVIDER',
        type: NOTIF_TYPES.REQUEST_ASSIGNED,
        title: t('notifications.request_status.assigned_provider_title'),
        body: t('notifications.request_status.assigned_provider_body'),
        data: { requestId },
      });
    }

    await createMany(notifications, client);
  }

  async function notifyCaseAssigned({ caseId, providerId, patientName }, client) {
    if (!caseId || !providerId) return;

    const patientLabel = patientName ? ` for ${patientName}` : '';

    await createNotification(
      {
        userId: providerId,
        userRole: 'PROVIDER',
        type: NOTIF_TYPES.CASE_ASSIGNED,
        title: 'New case assigned',
        body: `A new case${patientLabel} has been assigned to you.`,
        data: { case_id: caseId, caseId },
      },
      client
    );
  }

  async function notifyPaymentReceived(
    { invoiceId, patientId, amount, remaining, method },
    client
  ) {
    const isPaid = remaining <= 0;

    if (patientId) {
      await createNotification(
        {
          userId: patientId,
          userRole: 'PATIENT',
          type: isPaid ? NOTIF_TYPES.INVOICE_PAID : NOTIF_TYPES.PAYMENT_PARTIAL,
          title: isPaid
            ? t('notifications.payment.invoice_paid_title')
            : t('notifications.payment.partial_title'),
          body: isPaid
            ? t('notifications.payment.invoice_paid_body')
            : t('notifications.payment.partial_body', { amount, remaining }),
          data: { invoiceId, amount, remaining, method },
        },
        client
      );
    }

    const adminIds = await notifRepo.getAllAdminIds(client);
    if (adminIds.length) {
      const adminNotifs = adminIds.map((adminId) => ({
        userId: adminId,
        userRole: 'ADMIN',
        type: NOTIF_TYPES.PAYMENT_RECEIVED,
        title: t('notifications.payment.admin_title'),
        body: t('notifications.payment.admin_body', {
          amount,
          method,
          statusDetail: isPaid
            ? t('notifications.payment.status_paid')
            : t('notifications.payment.status_remaining', { remaining }),
        }),
        data: { invoiceId, amount, remaining, method },
      }));
      await createMany(adminNotifs, client);
    }
  }

  async function notifyVipGranted({ patientId, discount }, client) {
    await createNotification(
      {
        userId: patientId,
        userRole: 'PATIENT',
        type: NOTIF_TYPES.VIP_GRANTED,
        title: t('notifications.vip.title'),
        body: t('notifications.vip.body', { discount }),
        data: { discount },
      },
      client
    );
  }

  async function notifyPointsEarned({ patientId, points, totalPoints }, client) {
    await createNotification(
      {
        userId: patientId,
        userRole: 'PATIENT',
        type: NOTIF_TYPES.POINTS_EARNED,
        title: t('notifications.points.title'),
        body: t('notifications.points.body', { points, totalPoints }),
        data: { points, totalPoints },
      },
      client
    );
  }

  async function notifyReportPublished(caseOrRequest, maybePatientId) {
    const payload =
      caseOrRequest && typeof caseOrRequest === 'object'
        ? caseOrRequest
        : { requestId: caseOrRequest, patientId: maybePatientId };

    const patientId = payload.patientId || payload.patient_id || null;
    const caseId = payload.caseId || payload.case_id || null;
    const requestId = payload.requestId || payload.request_id || caseId || null;

    if (!patientId) return;

    await createNotification({
      userId: patientId,
      userRole: 'PATIENT',
      type: NOTIF_TYPES.REPORT_PUBLISHED,
      title: 'Your medical report is ready',
      body: 'Your medical report has been reviewed and is now available.',
      data: {
        ...(caseId ? { case_id: caseId, caseId } : {}),
        ...(requestId ? { request_id: requestId, requestId } : {}),
      },
    });
  }

  async function getNotifications(
    userId,
    userRole,
    { page = 1, limit = 20, unreadOnly = false } = {}
  ) {
    const { page: currentPage, limit: currentLimit, offset } = paginate({
      page,
      limit,
    });

    const { data, total, unread_count } = await notifRepo.getNotifications(
      userId,
      userRole,
      { limit: currentLimit, offset, unreadOnly }
    );

    return {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit),
      unread_count,
    };
  }

  async function markAsRead(notificationId, userId) {
    const notification = await notifRepo.markAsRead(notificationId, userId);
    if (notification) {
      await emitNotificationUnreadUpdate(notification.user_id, notification.user_role);
    }
    return notification;
  }

  async function markAllAsRead(userId, userRole) {
    const count = await notifRepo.markAllAsRead(userId, userRole);
    await emitNotificationUnreadUpdate(userId, userRole);
    return count;
  }

  async function deleteNotification(notificationId, userId) {
    const deleted = await notifRepo.deleteNotification(notificationId, userId);
    if (deleted) {
      await emitNotificationUnreadUpdate(deleted.user_id, deleted.user_role);
    }
    return deleted;
  }

  return {
    NOTIF_TYPES,
    createNotification,
    createMany,
    notifyRequestCreated,
    notifyRequestStatusChanged,
    notifyCaseAssigned,
    notifyPaymentReceived,
    notifyVipGranted,
    notifyPointsEarned,
    notifyReportPublished,
    getNotifications,
    markAsRead,
    markAllAsRead,
    deleteNotification,
  };
}

let configuredNotificationService = null;

function configureNotificationService(notifRepo) {
  configuredNotificationService = createNotificationService(notifRepo);
  return module.exports;
}

function getConfiguredNotificationService() {
  if (!configuredNotificationService) {
    throw new Error('Notification service is not configured');
  }

  return configuredNotificationService;
}

async function createNotification(...args) {
  return getConfiguredNotificationService().createNotification(...args);
}

async function createMany(...args) {
  return getConfiguredNotificationService().createMany(...args);
}

async function notifyRequestCreated(...args) {
  return getConfiguredNotificationService().notifyRequestCreated(...args);
}

async function notifyRequestStatusChanged(...args) {
  return getConfiguredNotificationService().notifyRequestStatusChanged(...args);
}

async function notifyCaseAssigned(...args) {
  return getConfiguredNotificationService().notifyCaseAssigned(...args);
}

async function notifyPaymentReceived(...args) {
  return getConfiguredNotificationService().notifyPaymentReceived(...args);
}

async function notifyVipGranted(...args) {
  return getConfiguredNotificationService().notifyVipGranted(...args);
}

async function notifyPointsEarned(...args) {
  return getConfiguredNotificationService().notifyPointsEarned(...args);
}

async function notifyReportPublished(...args) {
  return getConfiguredNotificationService().notifyReportPublished(...args);
}

async function getNotifications(...args) {
  return getConfiguredNotificationService().getNotifications(...args);
}

async function markAsRead(...args) {
  return getConfiguredNotificationService().markAsRead(...args);
}

async function markAllAsRead(...args) {
  return getConfiguredNotificationService().markAllAsRead(...args);
}

async function deleteNotification(...args) {
  return getConfiguredNotificationService().deleteNotification(...args);
}

module.exports = {
  NOTIF_TYPES,
  configureNotificationService,
  createNotificationService,
  createNotification,
  createMany,
  notifyRequestCreated,
  notifyRequestStatusChanged,
  notifyCaseAssigned,
  notifyPaymentReceived,
  notifyVipGranted,
  notifyPointsEarned,
  notifyReportPublished,
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};
