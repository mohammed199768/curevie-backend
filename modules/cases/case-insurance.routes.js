/**
 * Insurance lab orders (mounted under /api/v1/cases).
 *
 *   POST  /insurance                    patient: insurance card + visit details, no tests chosen
 *   GET   /insurance/requests           admin: all requests with amounts and receivables
 *   GET   /:id/insurance/card           the insurance card (admin, the lab on the order, the patient)
 *   PUT   /:id/insurance/quote          lab: covered tests, patient amount, amount owed to Curevie
 *   POST  /:id/insurance/approve        patient accepts the amount (work can start)
 *   POST  /:id/insurance/decline        patient refuses: the order is cancelled
 *   PATCH /:id/insurance/receivable     admin: what the lab owes Curevie was received / waived
 *
 * Money: the patient pays Curevie their amount + the home-visit fee (CliQ, as any order). That money
 * is the lab's share (PENDING earning) and reaches the lab only through an admin payout. What the lab
 * owes Curevie after the insurer pays it is tracked as a receivable on the request.
 */
const express = require('express');
const { authenticate, adminOnly, providerOnly, patientOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const { AppError } = require('../../middlewares/errorHandler');
const asyncHandler = require('../../utils/asyncHandler');
const { uploadCaseFile } = require('../../utils/upload');
const { savePrivateFile, readStoredFile, deleteStoredFile, mimeTypeForKey, sendFile } = require('../../utils/storage');
const { paginationMeta } = require('../../utils/pagination');
const { audit, logger } = require('../../utils/logger');
const { t } = require('../../utils/i18n/ar');
const notificationService = require('../notifications/notification.service');
const caseService = require('./case.service');
const verification = require('../verification/verification.service');
const events = require('./case.events');
const schemas = require('./case.schemas');
const { CASE_STATUS, SERVICE_STATUS, SYSTEM_SERVICES } = require('./case.constants');

const router = express.Router();
const { caseRepo, insuranceRepo } = caseService;
const { NOTIF_TYPES, notifySafely } = notificationService;

const caseRef = (caseRow) => `#${caseRow.reference_number}`;

/** The "lab tests (insurance)" line of an order (priced by the lab). */
function insuranceLine(services) {
  return services.find((line) => line.service_system_key === SYSTEM_SERVICES.LAB_INSURANCE_TESTS
    && line.status !== SERVICE_STATUS.CANCELLED);
}

router.post(
  '/insurance',
  authenticate,
  patientOnly,
  apiLimiter,
  ...uploadCaseFile,
  validate(schemas.insuranceRequestFieldsSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('A photo of the insurance card is required', 400, 'NO_FILE');
    const cardKey = await savePrivateFile(req.file.buffer, { folder: 'insurance-cards', mimeType: req.file.mimetype });

    let created;
    try {
      created = await caseService.withTransaction(async (client) => {
        const { rows: areaRows } = await client.query('SELECT id, is_active FROM areas WHERE id = $1', [req.body.area_id]);
        if (!areaRows[0] || !areaRows[0].is_active) throw new AppError('Selected area is not served', 400, 'INVALID_AREA');

        const { rows } = await client.query(
          'SELECT id, full_name, phone, address, deleted_at FROM patients WHERE id = $1',
          [req.user.id]
        );
        const patient = rows[0];
        if (!patient || patient.deleted_at) throw new AppError('Patient account not found', 403, 'FORBIDDEN');
        await verification.assertPatientCanOrder(client, patient.id);
        const address = (req.body.address || '').trim() || patient.address || null;
        if (!address) throw new AppError('A visit address is required', 400, 'ADDRESS_REQUIRED');

        const caseRow = await caseRepo.insertCase({
          patient_id: patient.id,
          area_id: req.body.area_id,
          address,
          scheduled_for: req.body.scheduled_for || null,
          notes: req.body.notes || null,
          recipient_gender: req.body.recipient_gender,
          recipient_age_group: req.body.recipient_age_group,
          is_insurance: true,
        }, client);

        // Placeholder line the lab prices later; it also triggers the home-visit fee and lab routing.
        const testsService = await caseService.findSystemService(client, SYSTEM_SERVICES.LAB_INSURANCE_TESTS);
        await caseRepo.insertCaseService({
          case_id: caseRow.id,
          item_type: 'SERVICE',
          service_id: testsService.id,
          item_name: testsService.name,
          original_price: 0,
          bundle_price: 0,
        }, client);
        await insuranceRepo.insert({
          caseId: caseRow.id,
          cardFileKey: cardKey,
          cardFileName: String(req.file.originalname || '').slice(0, 255),
          cardMime: req.file.mimetype,
        }, client);

        const partnerAssignments = await caseService.applyPartnerRules(client, { id: caseRow.id, patient_id: patient.id });
        const status = await caseService.syncCaseStatus(client, { id: caseRow.id, status: CASE_STATUS.PENDING }, req.user);
        await caseRepo.insertInvoice(caseRow.id, client);
        await caseService.recomputeInvoice(client, caseRow.id, status);
        await caseRepo.addLifecycleEvent({
          case_id: caseRow.id,
          actor_id: patient.id,
          actor_role: 'PATIENT',
          event_type: 'CASE_CREATED',
          notes: 'insurance lab request',
        }, client);

        return { caseRow, patient, itemName: testsService.name, partnerAssignments };
      });
    } catch (err) {
      await deleteStoredFile(cardKey).catch(() => {});
      throw err;
    }

    const { caseRow, patient, itemName, partnerAssignments } = created;
    events.caseCreated({
      caseId: caseRow.id, referenceNumber: caseRow.reference_number, patientId: patient.id, sourceLabel: patient.full_name, itemNames: [itemName],
    });
    caseService.notifyPartnerAssignments(caseRow.id, patient.id, patient.full_name, partnerAssignments);
    caseService.sendTrackingMessage({ caseId: caseRow.id, referenceNumber: caseRow.reference_number, phone: patient.phone });
    notifySafely('insurance_requested', async () => {
      await notificationService.notifyAdmins({
        type: NOTIF_TYPES.CASE_UPDATED,
        title: t('notifications.insurance.requested_admin_title'),
        body: t('notifications.insurance.requested_admin_body', { caseRef: caseRef(caseRow) }),
        data: { case_id: caseRow.id },
      });
      for (const assignment of partnerAssignments) {
        await notificationService.createNotification({
          userId: assignment.providerId,
          userRole: 'PROVIDER',
          type: NOTIF_TYPES.CASE_UPDATED,
          title: t('notifications.insurance.requested_provider_title'),
          body: t('notifications.insurance.requested_provider_body', { caseRef: caseRef(caseRow) }),
          data: { case_id: caseRow.id, case_service_id: assignment.caseServiceId },
        });
      }
    });

    return res.status(201).json({ data: await caseService.getCaseDetail(caseRow.id, req.user) });
  })
);

router.get(
  '/insurance/requests',
  authenticate,
  adminOnly,
  readLimiter,
  validate(schemas.insuranceListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const { data, totals } = await insuranceRepo.list(
      { status: req.query.status, receivableStatus: req.query.receivable_status, providerId: req.query.provider_id },
      { limit, offset: (page - 1) * limit }
    );
    return res.json({
      data,
      summary: {
        receivable_pending: Number(totals.receivable_pending),
        receivable_received: Number(totals.receivable_received),
      },
      pagination: paginationMeta(totals.total, page, limit),
    });
  })
);

router.get(
  '/:id/insurance/card',
  authenticate,
  readLimiter,
  validate(schemas.caseIdParams, 'params'),
  asyncHandler(async (req, res) => {
    // Admin, the patient who sent it, or a provider with a line on the order.
    await caseService.loadAccessibleCase(req.params.id, req.user);
    const request = await insuranceRepo.findByCase(req.params.id);
    if (!request) throw new AppError('Insurance request not found', 404, 'NOT_FOUND');
    let buffer;
    try {
      buffer = await readStoredFile(request.card_file_key);
    } catch (err) {
      logger.warn('INSURANCE_CARD_READ_FAILED', { caseId: req.params.id, message: err.message });
      throw new AppError('File is not available', 404, 'FILE_NOT_FOUND');
    }
    return sendFile(res, buffer, {
      fileName: request.card_file_name || 'insurance-card',
      mimeType: request.card_mime || mimeTypeForKey(request.card_file_key),
      inline: req.query.inline === 'true',
    });
  })
);

router.put(
  '/:id/insurance/quote',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  validate(schemas.insuranceQuoteSchema),
  asyncHandler(async (req, res) => {
    const result = await caseService.withTransaction(async (client) => {
      const caseRow = await caseRepo.lockCase(req.params.id, client);
      if (!caseRow || !caseRow.is_insurance) throw new AppError('Insurance request not found', 404, 'NOT_FOUND');
      if ([CASE_STATUS.CLOSED, CASE_STATUS.CANCELLED].includes(caseRow.status)) {
        throw new AppError(`The case is ${caseRow.status}`, 409, 'INVALID_CASE_STATUS');
      }
      const request = await insuranceRepo.lockByCase(req.params.id, client);
      if (!request || !['SUBMITTED', 'QUOTED'].includes(request.status)) {
        throw new AppError('This insurance request can no longer be priced', 409, 'INSURANCE_NOT_EDITABLE');
      }
      const line = insuranceLine(await caseRepo.findServicesByCase(req.params.id, client));
      if (!line || line.provider_id !== req.user.id) throw new AppError('Insurance request not found', 404, 'NOT_FOUND');

      await caseRepo.updateLinePrice(line.id, req.body.patient_amount, client);
      const saved = await insuranceRepo.saveQuote(req.params.id, {
        testsDescription: req.body.tests_description,
        patientAmount: req.body.patient_amount,
        labOwesAmount: req.body.lab_owes_amount,
        notes: req.body.notes,
        providerId: req.user.id,
      }, client);
      await caseRepo.addLifecycleEvent({
        case_id: req.params.id,
        case_service_id: line.id,
        actor_id: req.user.id,
        actor_role: 'PROVIDER',
        event_type: 'INSURANCE_QUOTED',
        notes: `patient ${req.body.patient_amount} / lab owes ${req.body.lab_owes_amount}`,
      }, client);
      await caseService.recomputeInvoice(client, req.params.id, caseRow.status, { forbidOverpaid: true });
      return { caseRow, saved };
    });

    const view = await caseService.getCaseDetail(req.params.id, req.user);
    const { caseRow } = result;
    if (caseRow.patient_id) {
      const patientView = await caseService.getCaseDetail(req.params.id, { id: caseRow.patient_id, role: 'PATIENT' });
      notifySafely('insurance_quoted', () => notificationService.createNotification({
        userId: caseRow.patient_id,
        userRole: 'PATIENT',
        type: NOTIF_TYPES.CASE_UPDATED,
        title: t('notifications.insurance.quoted_patient_title'),
        body: t('notifications.insurance.quoted_patient_body', { amount: patientView.insurance?.amount_to_pay ?? '' }),
        data: { case_id: req.params.id },
      }));
    }
    events.emitCaseUpdated({
      caseId: req.params.id, status: caseRow.status, patientId: caseRow.patient_id, providerIds: [req.user.id], event: 'INSURANCE_QUOTED',
    });
    return res.json({ data: view });
  })
);

/** Patient decision on the lab's amount. */
async function decide(req, res, decision) {
  const caseRow = await caseRepo.findCaseById(req.params.id);
  if (!caseRow || caseRow.patient_id !== req.user.id || !caseRow.is_insurance) {
    throw new AppError('Insurance request not found', 404, 'NOT_FOUND');
  }
  const request = await insuranceRepo.findByCase(req.params.id);
  const allowed = decision === 'APPROVED' ? ['QUOTED'] : ['SUBMITTED', 'QUOTED'];
  if (!request || !allowed.includes(request.status)) {
    throw new AppError(`Cannot ${decision === 'APPROVED' ? 'approve' : 'decline'} this request now`, 409, 'INSURANCE_NOT_EDITABLE');
  }

  if (decision === 'DECLINED') {
    // Cancels the order (and notifies the lab and admins); fails if work already started.
    await caseService.cancelCase(req.params.id, req.user, req.body?.reason || 'Insurance amount declined');
    await insuranceRepo.setStatus(req.params.id, 'DECLINED');
    return res.json({ data: await caseService.getCaseDetail(req.params.id, req.user) });
  }

  await caseService.withTransaction(async (client) => {
    const locked = await insuranceRepo.lockByCase(req.params.id, client);
    if (locked.status !== 'QUOTED') throw new AppError('Cannot approve this request now', 409, 'INSURANCE_NOT_EDITABLE');
    await insuranceRepo.setStatus(req.params.id, 'APPROVED', client);
    await caseRepo.addLifecycleEvent({
      case_id: req.params.id,
      actor_id: req.user.id,
      actor_role: 'PATIENT',
      event_type: 'INSURANCE_APPROVED',
      notes: request.patient_amount != null ? `patient amount ${request.patient_amount}` : null,
    }, client);
  });

  const services = await caseRepo.findServicesByCase(req.params.id);
  const labId = insuranceLine(services)?.provider_id || null;
  notifySafely('insurance_approved', async () => {
    const message = {
      type: NOTIF_TYPES.CASE_UPDATED,
      title: t('notifications.insurance.approved_title'),
      body: t('notifications.insurance.approved_body', { caseRef: caseRef(caseRow) }),
      data: { case_id: req.params.id },
    };
    await notificationService.notifyAdmins(message);
    if (labId) await notificationService.createNotification({ ...message, userId: labId, userRole: 'PROVIDER' });
  });
  events.emitCaseUpdated({
    caseId: req.params.id, status: caseRow.status, patientId: caseRow.patient_id, providerIds: [labId], event: 'INSURANCE_APPROVED',
  });
  return res.json({ data: await caseService.getCaseDetail(req.params.id, req.user) });
}

router.post(
  '/:id/insurance/approve',
  authenticate,
  patientOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  asyncHandler((req, res) => decide(req, res, 'APPROVED'))
);

router.post(
  '/:id/insurance/decline',
  authenticate,
  patientOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  validate(schemas.reasonSchema),
  asyncHandler((req, res) => decide(req, res, 'DECLINED'))
);

router.patch(
  '/:id/insurance/receivable',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  validate(schemas.insuranceReceivableSchema),
  asyncHandler(async (req, res) => {
    const request = await insuranceRepo.findByCase(req.params.id);
    if (!request) throw new AppError('Insurance request not found', 404, 'NOT_FOUND');
    const saved = await insuranceRepo.setReceivable(req.params.id, {
      status: req.body.status,
      notes: req.body.notes,
      adminId: req.user.id,
    });
    audit('INSURANCE_RECEIVABLE_UPDATED', {
      userId: req.user.id, role: req.user.role, targetId: req.params.id, targetType: 'case', ip: req.ip,
      details: { status: req.body.status, amount: request.lab_owes_amount },
    });
    return res.json({ data: saved });
  })
);

module.exports = router;
