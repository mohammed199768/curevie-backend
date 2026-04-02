const NOTIF_TYPES = {
  REQUEST_CREATED: 'REQUEST_CREATED',
  REQUEST_ACCEPTED: 'REQUEST_ACCEPTED',
  REQUEST_ASSIGNED: 'REQUEST_ASSIGNED',
  REQUEST_COMPLETED: 'REQUEST_COMPLETED',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_PARTIAL: 'PAYMENT_PARTIAL',
  INVOICE_PAID: 'INVOICE_PAID',
  VIP_GRANTED: 'VIP_GRANTED',
  POINTS_EARNED: 'POINTS_EARNED',
  COUPON_APPLIED: 'COUPON_APPLIED',
  REPORT_PUBLISHED: 'REPORT_PUBLISHED',
};

const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace duplicated notification pagination math
const { t } = require('../../utils/i18n/ar'); // AUDIT-FIX: DRY — centralized notification copy lives in the shared Arabic i18n catalog

function createNotificationService(notifRepo) {
  async function createNotification(data, client = null) {
    return notifRepo.createNotification(data, client);
  }

  async function createMany(notifications, client = null) {
    return notifRepo.createMany(notifications, client);
  }

  async function notifyRequestCreated({ requestId, requestType, guestName, patientId, serviceType }, client) {
    const adminIds = await notifRepo.getAllAdminIds(client);

    if (adminIds.length) {
      const adminNotifs = adminIds.map((adminId) => ({
        userId: adminId,
        userRole: 'ADMIN',
        type: NOTIF_TYPES.REQUEST_CREATED,
        title: t('notifications.new_request.admin_title'), // AUDIT-FIX: DRY — centralized notification title replaces duplicated inline Arabic literal
        body: t('notifications.new_request.admin_body', { serviceType, requestSource: requestType === 'GUEST' ? guestName : t('labels.registered_patient') }), // AUDIT-FIX: DRY — centralized templated copy replaces duplicated inline Arabic literal
        data: { requestId, requestType, serviceType },
      }));
      await notifRepo.createMany(adminNotifs, client);
    }

    if (patientId) {
      await notifRepo.createNotification({
        userId: patientId,
        userRole: 'PATIENT',
        type: NOTIF_TYPES.REQUEST_CREATED,
        title: t('notifications.new_request.patient_title'), // AUDIT-FIX: DRY — centralized notification title replaces duplicated inline Arabic literal
        body: t('notifications.new_request.patient_body', { serviceType }), // AUDIT-FIX: DRY — centralized templated copy replaces duplicated inline Arabic literal
        data: { requestId, serviceType },
      }, client);
    }
  }

  async function notifyRequestStatusChanged({ requestId, status, patientId, providerId, adminNotes }, client) {
    const statusMessages = {
      ACCEPTED: { title: t('notifications.request_status.accepted_title'), body: t('notifications.request_status.accepted_body') }, // AUDIT-FIX: DRY — accepted-status copy now comes from the shared i18n catalog
      ASSIGNED: { title: t('notifications.request_status.assigned_title'), body: t('notifications.request_status.assigned_body') }, // AUDIT-FIX: DRY — assigned-status copy now comes from the shared i18n catalog
      COMPLETED: { title: t('notifications.request_status.completed_title'), body: t('notifications.request_status.completed_body') }, // AUDIT-FIX: DRY — completed-status copy now comes from the shared i18n catalog
      CANCELLED: { title: t('notifications.request_status.cancelled_title'), body: adminNotes || t('notifications.request_status.cancelled_body') }, // AUDIT-FIX: DRY — cancelled-status copy now comes from the shared i18n catalog
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
        title: t('notifications.request_status.assigned_provider_title'), // AUDIT-FIX: DRY — provider assignment title now comes from the shared i18n catalog
        body: t('notifications.request_status.assigned_provider_body'), // AUDIT-FIX: DRY — provider assignment body now comes from the shared i18n catalog
        data: { requestId },
      });
    }

    await notifRepo.createMany(notifications, client);
  }

  async function notifyPaymentReceived({ invoiceId, patientId, amount, remaining, method }, client) {
    const isPaid = remaining <= 0;

    if (patientId) {
      await notifRepo.createNotification({
        userId: patientId,
        userRole: 'PATIENT',
        type: isPaid ? NOTIF_TYPES.INVOICE_PAID : NOTIF_TYPES.PAYMENT_PARTIAL,
        title: isPaid ? t('notifications.payment.invoice_paid_title') : t('notifications.payment.partial_title'), // AUDIT-FIX: DRY — patient payment titles now come from the shared i18n catalog
        body: isPaid
          ? t('notifications.payment.invoice_paid_body') // AUDIT-FIX: DRY — paid-in-full copy now comes from the shared i18n catalog
          : t('notifications.payment.partial_body', { amount, remaining }), // AUDIT-FIX: DRY — partial-payment copy now comes from the shared i18n catalog
        data: { invoiceId, amount, remaining, method },
      }, client);
    }

    const adminIds = await notifRepo.getAllAdminIds(client);
    if (adminIds.length) {
      const adminNotifs = adminIds.map((adminId) => ({
        userId: adminId,
        userRole: 'ADMIN',
        type: NOTIF_TYPES.PAYMENT_RECEIVED,
        title: t('notifications.payment.admin_title'), // AUDIT-FIX: DRY — admin payment title now comes from the shared i18n catalog
        body: t('notifications.payment.admin_body', {
          amount,
          method,
          statusDetail: isPaid
            ? t('notifications.payment.status_paid')
            : t('notifications.payment.status_remaining', { remaining }),
        }), // AUDIT-FIX: DRY — admin payment body now comes from the shared i18n catalog
        data: { invoiceId, amount, remaining, method },
      }));
      await notifRepo.createMany(adminNotifs, client);
    }
  }

  async function notifyVipGranted({ patientId, discount }, client) {
    await notifRepo.createNotification({
      userId: patientId,
      userRole: 'PATIENT',
      type: NOTIF_TYPES.VIP_GRANTED,
      title: t('notifications.vip.title'), // AUDIT-FIX: DRY — VIP title now comes from the shared i18n catalog
      body: t('notifications.vip.body', { discount }), // AUDIT-FIX: DRY — VIP body now comes from the shared i18n catalog
      data: { discount },
    }, client);
  }

  async function notifyPointsEarned({ patientId, points, totalPoints }, client) {
    await notifRepo.createNotification({
      userId: patientId,
      userRole: 'PATIENT',
      type: NOTIF_TYPES.POINTS_EARNED,
      title: t('notifications.points.title'), // AUDIT-FIX: DRY — points title now comes from the shared i18n catalog
      body: t('notifications.points.body', { points, totalPoints }), // AUDIT-FIX: DRY — points body now comes from the shared i18n catalog
      data: { points, totalPoints },
    }, client);
  }

  async function notifyReportPublished(requestId, patientId) {
    if (!patientId) return;

    await notifRepo.createNotification({
      userId: patientId,
      userRole: 'PATIENT',
      type: NOTIF_TYPES.REPORT_PUBLISHED,
      title: 'Your medical report is ready',
      body: 'Your medical report has been reviewed and is now available.',
      data: { request_id: requestId },
    });
  }

  async function getNotifications(userId, userRole, { page = 1, limit = 20, unreadOnly = false } = {}) {
    const { page: currentPage, limit: currentLimit, offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — centralize notification page/limit sanitizing through the shared helper
    const { data, total, unread_count } = await notifRepo.getNotifications(
      userId, userRole, { limit: currentLimit, offset, unreadOnly }
    );

    return {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for notification listings
      unread_count,
    };
  }

  async function markAsRead(notificationId, userId) {
    return notifRepo.markAsRead(notificationId, userId);
  }

  async function markAllAsRead(userId, userRole) {
    return notifRepo.markAllAsRead(userId, userRole);
  }

  async function deleteNotification(notificationId, userId) {
    return notifRepo.deleteNotification(notificationId, userId);
  }

  return {
    NOTIF_TYPES,
    createNotification,
    createMany,
    notifyRequestCreated,
    notifyRequestStatusChanged,
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

let configuredNotificationService = null; // AUDIT-FIX: P3-STEP8-DIP - notification-service singleton wiring now happens outside the module.

function configureNotificationService(notifRepo) { // AUDIT-FIX: P3-STEP8-DIP - composition roots can configure the backward-compatible notification singleton explicitly.
  configuredNotificationService = createNotificationService(notifRepo); // AUDIT-FIX: P3-STEP8-DIP - cache the injected repository-backed service for legacy method callers.
  return module.exports; // AUDIT-FIX: P3-STEP8-COMPAT - keep the historical object export shape available after configuration.
} // AUDIT-FIX: P3-STEP8-DIP - configuration helper ends the composition-root bridge for notification consumers.

function getConfiguredNotificationService() { // AUDIT-FIX: P3-STEP8-DIP - centralize singleton access so the legacy surface stays intact without config/db.
  if (!configuredNotificationService) throw new Error('Notification service is not configured'); // AUDIT-FIX: P3-STEP8-DIP - fail fast if a composition root forgot to inject dependencies.
  return configuredNotificationService; // AUDIT-FIX: P3-STEP8-DIP - return the injected singleton for legacy method callers.
} // AUDIT-FIX: P3-STEP8-DIP - singleton accessor ends the compatibility bridge.

async function createNotification(...args) { return getConfiguredNotificationService().createNotification(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level createNotification method without a service-level DB import.
async function createMany(...args) { return getConfiguredNotificationService().createMany(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level createMany method without a service-level DB import.
async function notifyRequestCreated(...args) { return getConfiguredNotificationService().notifyRequestCreated(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level notifyRequestCreated method without a service-level DB import.
async function notifyRequestStatusChanged(...args) { return getConfiguredNotificationService().notifyRequestStatusChanged(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level notifyRequestStatusChanged method without a service-level DB import.
async function notifyPaymentReceived(...args) { return getConfiguredNotificationService().notifyPaymentReceived(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level notifyPaymentReceived method without a service-level DB import.
async function notifyVipGranted(...args) { return getConfiguredNotificationService().notifyVipGranted(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level notifyVipGranted method without a service-level DB import.
async function notifyPointsEarned(...args) { return getConfiguredNotificationService().notifyPointsEarned(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level notifyPointsEarned method without a service-level DB import.
async function notifyReportPublished(...args) { return getConfiguredNotificationService().notifyReportPublished(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level notifyReportPublished method without a service-level DB import.
async function getNotifications(...args) { return getConfiguredNotificationService().getNotifications(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getNotifications method without a service-level DB import.
async function markAsRead(...args) { return getConfiguredNotificationService().markAsRead(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level markAsRead method without a service-level DB import.
async function markAllAsRead(...args) { return getConfiguredNotificationService().markAllAsRead(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level markAllAsRead method without a service-level DB import.
async function deleteNotification(...args) { return getConfiguredNotificationService().deleteNotification(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level deleteNotification method without a service-level DB import.

module.exports = {
  NOTIF_TYPES,
  configureNotificationService,
  createNotificationService,
  createNotification,
  createMany,
  notifyRequestCreated,
  notifyRequestStatusChanged,
  notifyPaymentReceived,
  notifyVipGranted,
  notifyPointsEarned,
  notifyReportPublished,
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};
