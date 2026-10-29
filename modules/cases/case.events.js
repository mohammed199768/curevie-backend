// Side effects that follow a committed case change: stored notifications plus live socket events.
// Nothing here may throw into the request; every entry point goes through notifySafely.
const notificationService = require('../notifications/notification.service');
const { emitToUser, emitToRole } = require('../../utils/socket');
const { t } = require('../../utils/i18n/ar');

const { NOTIF_TYPES, notifySafely } = notificationService;

function caseRef(caseId) {
  return `#${String(caseId || '').slice(0, 8).toUpperCase()}`;
}

/**
 * Broadcasts "case:updated" to everyone who can see the case so open screens refresh.
 * @param {{ caseId, status, patientId, providerIds, event, caseServiceId?, serviceStatus? }} payload
 */
function emitCaseUpdated({ caseId, status, patientId, providerIds = [], event, caseServiceId, serviceStatus }) {
  const message = {
    case_id: caseId,
    status,
    event,
    case_service_id: caseServiceId || null,
    service_status: serviceStatus || null,
    at: new Date().toISOString(),
  };
  emitToRole('ADMIN', 'case:updated', message);
  if (patientId) emitToUser(patientId, 'case:updated', message);
  [...new Set(providerIds.filter(Boolean))].forEach((providerId) => emitToUser(providerId, 'case:updated', message));
}

function caseCreated({ caseId, patientId, sourceLabel, itemNames }) {
  return notifySafely('case_created', async () => {
    emitToRole('ADMIN', 'case:created', { case_id: caseId, at: new Date().toISOString() });
    await notificationService.notifyAdmins({
      type: NOTIF_TYPES.CASE_CREATED,
      title: t('notifications.case.created_admin_title'),
      body: t('notifications.case.created_admin_body', { source: sourceLabel, items: itemNames.join('، ') }),
      data: { case_id: caseId },
    });
    if (patientId) {
      await notificationService.createNotification({
        userId: patientId,
        userRole: 'PATIENT',
        type: NOTIF_TYPES.CASE_CREATED,
        title: t('notifications.case.created_patient_title'),
        body: t('notifications.case.created_patient_body'),
        data: { case_id: caseId },
      });
    }
  });
}

function providersAssigned({ caseId, patientId, patientName, assignments }) {
  return notifySafely('case_assigned', async () => {
    const notifications = [];
    for (const assignment of assignments) {
      emitToUser(assignment.providerId, 'case:assigned', {
        case_id: caseId,
        case_service_id: assignment.caseServiceId,
      });
      notifications.push({
        userId: assignment.providerId,
        userRole: 'PROVIDER',
        type: NOTIF_TYPES.CASE_ASSIGNED,
        title: t('notifications.case.assigned_provider_title'),
        body: t('notifications.case.assigned_provider_body', {
          item: assignment.itemName,
          patient: patientName ? ` (${patientName})` : '',
        }),
        data: { case_id: caseId, case_service_id: assignment.caseServiceId },
      });
      if (patientId) {
        notifications.push({
          userId: patientId,
          userRole: 'PATIENT',
          type: NOTIF_TYPES.CASE_UPDATED,
          title: t('notifications.case.assigned_patient_title'),
          body: t('notifications.case.assigned_patient_body', {
            provider: assignment.providerName || t('labels.provider'),
            item: assignment.itemName,
          }),
          data: { case_id: caseId, case_service_id: assignment.caseServiceId },
        });
      }
    }
    await notificationService.createMany(notifications);
  });
}

/** Provider accepted / rejected / started / completed a line item. */
function serviceProgressed({ action, caseId, caseStatus, patientId, providerName, itemName, caseServiceId, reason }) {
  return notifySafely(`service_${action}`, async () => {
    const data = { case_id: caseId, case_service_id: caseServiceId };
    const provider = providerName || t('labels.provider');

    if (action === 'accepted') {
      await notificationService.notifyAdmins({
        type: NOTIF_TYPES.CASE_UPDATED,
        title: t('notifications.case.accepted_admin_title'),
        body: t('notifications.case.accepted_admin_body', { provider, item: itemName }),
        data,
      });
    }
    if (action === 'rejected') {
      await notificationService.notifyAdmins({
        type: NOTIF_TYPES.CASE_UPDATED,
        title: t('notifications.case.rejected_admin_title'),
        body: t('notifications.case.rejected_admin_body', { provider, item: itemName, reason: reason || '-' }),
        data,
      });
    }
    if (action === 'started' && patientId) {
      await notificationService.createNotification({
        userId: patientId,
        userRole: 'PATIENT',
        type: NOTIF_TYPES.CASE_UPDATED,
        title: t('notifications.case.started_patient_title'),
        body: t('notifications.case.started_patient_body', { provider, item: itemName }),
        data,
      });
    }
    if (action === 'completed') {
      if (patientId) {
        await notificationService.createNotification({
          userId: patientId,
          userRole: 'PATIENT',
          type: NOTIF_TYPES.CASE_UPDATED,
          title: t('notifications.case.completed_patient_title'),
          body: t('notifications.case.completed_patient_body', { item: itemName }),
          data,
        });
      }
      await notificationService.notifyAdmins({
        type: caseStatus === 'COMPLETED' ? NOTIF_TYPES.CASE_COMPLETED : NOTIF_TYPES.CASE_UPDATED,
        title: caseStatus === 'COMPLETED'
          ? t('notifications.case.case_completed_admin_title')
          : t('notifications.case.completed_admin_title'),
        body: caseStatus === 'COMPLETED'
          ? t('notifications.case.case_completed_admin_body', { caseRef: caseRef(caseId) })
          : t('notifications.case.completed_admin_body', { provider, item: itemName }),
        data,
      });
    }
  });
}

function serviceCancelled({ caseId, providerId, itemName, caseServiceId }) {
  if (!providerId) return Promise.resolve();
  return notifySafely('service_cancelled', () => notificationService.createNotification({
    userId: providerId,
    userRole: 'PROVIDER',
    type: NOTIF_TYPES.CASE_CANCELLED,
    title: t('notifications.case.service_cancelled_provider_title'),
    body: t('notifications.case.service_cancelled_provider_body', { item: itemName }),
    data: { case_id: caseId, case_service_id: caseServiceId },
  }));
}

function caseCancelled({ caseId, cancelledByRole, patientId, providerIds, reason }) {
  return notifySafely('case_cancelled', async () => {
    const data = { case_id: caseId };
    const notifications = [...new Set(providerIds.filter(Boolean))].map((providerId) => ({
      userId: providerId,
      userRole: 'PROVIDER',
      type: NOTIF_TYPES.CASE_CANCELLED,
      title: t('notifications.case.cancelled_patient_title'),
      body: t('notifications.case.cancelled_patient_body', { reason: reason || '' }),
      data,
    }));
    if (patientId && cancelledByRole !== 'PATIENT') {
      notifications.push({
        userId: patientId,
        userRole: 'PATIENT',
        type: NOTIF_TYPES.CASE_CANCELLED,
        title: t('notifications.case.cancelled_patient_title'),
        body: t('notifications.case.cancelled_patient_body', { reason: reason || '' }),
        data,
      });
    }
    await notificationService.createMany(notifications);
    if (cancelledByRole !== 'ADMIN') {
      await notificationService.notifyAdmins({
        type: NOTIF_TYPES.CASE_CANCELLED,
        title: t('notifications.case.cancelled_admin_title'),
        body: t('notifications.case.cancelled_admin_body', { caseRef: caseRef(caseId), reason: reason || '' }),
        data,
      });
    }
  });
}

function appointmentScheduled({ caseId, patientId, providerId, itemName, scheduledAt, caseServiceId }) {
  return notifySafely('appointment_scheduled', () => {
    const date = new Date(scheduledAt).toLocaleString('ar-JO', { timeZone: 'Asia/Amman' });
    const base = {
      type: NOTIF_TYPES.APPOINTMENT_SCHEDULED,
      title: t('notifications.case.appointment_title'),
      body: t('notifications.case.appointment_body', { item: itemName, date }),
      data: { case_id: caseId, case_service_id: caseServiceId },
    };
    return notificationService.createMany([
      patientId ? { ...base, userId: patientId, userRole: 'PATIENT' } : null,
      providerId ? { ...base, userId: providerId, userRole: 'PROVIDER' } : null,
    ].filter(Boolean));
  });
}

function caseClosed({ caseId, patientId }) {
  if (!patientId) return Promise.resolve();
  return notifySafely('case_closed', () => notificationService.createNotification({
    userId: patientId,
    userRole: 'PATIENT',
    type: NOTIF_TYPES.CASE_CLOSED,
    title: t('notifications.case.closed_patient_title'),
    body: t('notifications.case.closed_patient_body'),
    data: { case_id: caseId },
  }));
}

function serviceRated({ caseId, providerId, providerName, rating }) {
  return notifySafely('service_rated', async () => {
    const base = {
      type: NOTIF_TYPES.SERVICE_RATED,
      title: t('notifications.case.rated_admin_title'),
      body: t('notifications.case.rated_admin_body', { provider: providerName || t('labels.provider'), rating }),
      data: { case_id: caseId },
    };
    await notificationService.notifyAdmins(base);
    await notificationService.createNotification({ ...base, userId: providerId, userRole: 'PROVIDER' });
  });
}

function reportPublished({ caseId, patientId }) {
  if (!patientId) return Promise.resolve();
  return notifySafely('report_published', () => notificationService.createNotification({
    userId: patientId,
    userRole: 'PATIENT',
    type: NOTIF_TYPES.REPORT_PUBLISHED,
    title: t('notifications.case.report_published_title'),
    body: t('notifications.case.report_published_body'),
    data: { case_id: caseId },
  }));
}

/** Payments, adjustments or finalization changed the invoice: every open screen refetches it. */
function invoiceChanged({ caseRow, event }) {
  emitCaseUpdated({
    caseId: caseRow.id,
    status: caseRow.status,
    patientId: caseRow.patient_id,
    providerIds: [caseRow.lead_provider_id],
    event,
  });
}

module.exports = {
  emitCaseUpdated,
  invoiceChanged,
  caseCreated,
  providersAssigned,
  serviceProgressed,
  serviceCancelled,
  caseCancelled,
  appointmentScheduled,
  caseClosed,
  serviceRated,
  reportPublished,
};
