const { AppError } = require('../../middlewares/errorHandler'); // AUDIT-FIX: P3-STEP7C-SRP - lifecycle orchestration raises application errors instead of building HTTP responses.
const { logger, audit } = require('../../utils/logger'); // AUDIT-FIX: P3-STEP7D-SRP - notification/audit side effects move out of the controller with the extracted orchestration.
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace repeated lifecycle pagination code

const VALID_REQUEST_STATUSES = ['PENDING', 'ACCEPTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED']; // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the existing request-status validation set.

class RequestLifecycleService { // AUDIT-FIX: P3-STEP7C-SRP - request orchestration logic now has a dedicated home outside the controller.
  constructor({ // AUDIT-FIX: P3-STEP7C-DIP - all lifecycle dependencies are injected instead of required internally.
    requestRepo,
    workflowRepo,
    requestService,
    workflowService,
    notificationService,
    invoiceService,
    paymentService,
    snapshotUtil,
    storageUtil,
  }) {
    this.requests = requestRepo; // AUDIT-FIX: P3-STEP7C-DIP - request reads and writes flow through the injected repository.
    this.workflow = workflowRepo; // AUDIT-FIX: P3-STEP7C-DIP - workflow access checks flow through the injected repository.
    this.requestService = requestService; // AUDIT-FIX: P3-STEP7D-DIP - extracted controller orchestration can reuse the existing request service contract.
    this.workflowService = workflowService; // AUDIT-FIX: P3-STEP7D-DIP - extracted controller orchestration can reuse the existing workflow service contract.
    this.notifications = notificationService; // AUDIT-FIX: P3-STEP7C-DIP - notification orchestration is injectable for later extractions.
    this.invoices = invoiceService; // AUDIT-FIX: P3-STEP7C-DIP - invoice orchestration is injectable for later extractions.
    this.payments = paymentService; // AUDIT-FIX: P3-STEP7D-DIP - payment orchestration is injectable for completion-with-payment flows.
    this.snapshots = snapshotUtil; // AUDIT-FIX: P3-STEP7C-DIP - snapshot orchestration is injectable for later extractions.
    this.storage = storageUtil; // AUDIT-FIX: P3-STEP7C-DIP - storage orchestration is injectable for later extractions.
  }

  async createRequest(payload, actor, ip) { // AUDIT-FIX: P3-STEP7D-SRP - request-creation orchestration moves out of the controller.
    const {
      request_type,
      patient_id,
      guest_name,
      guest_phone,
      guest_address,
      service_type,
      service_id,
      lab_test_id,
      lab_panel_id,
      lab_package_id,
      package_id,
      notes,
      requested_at,
      coupon_code,
      points_to_use,
    } = payload; // AUDIT-FIX: P3-STEP7D-SRP - lifecycle service now owns request-creation input parsing.

    if (!request_type || !service_type) { // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the existing required-field validation.
      throw new AppError('request_type and service_type are required', 400, 'MISSING_REQUIRED_FIELDS'); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the current error contract.
    }

    if (request_type === 'GUEST' && (!guest_name || !guest_phone || !guest_address)) { // AUDIT-FIX: P3-STEP7D-COMPAT - preserve guest-field validation semantics.
      throw new AppError('Guest requires: guest_name, guest_phone, guest_address', 400, 'GUEST_FIELDS_REQUIRED'); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the current error contract.
    }

    const result = await this.requestService.createRequest({
      request_type,
      patient_id,
      guest_name,
      guest_phone,
      guest_address,
      service_type,
      service_id,
      lab_test_id,
      lab_panel_id,
      lab_package_id,
      package_id,
      notes,
      requested_at,
      coupon_code,
      points_to_use,
    }); // AUDIT-FIX: P3-STEP7D-DIP - extracted request-creation orchestration reuses the existing request service.

    audit('REQUEST_CREATED', {
      userId: actor?.id || null,
      role: actor?.role || 'GUEST',
      targetId: result.request.id,
      targetType: 'request',
      ip,
      details: { service_type: result.request.service_type, request_type: result.request.request_type },
    }); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve request-created audit logging.

    await this.notifications.notifyRequestCreated({
      requestId: result.request.id,
      requestType: request_type,
      guestName: guest_name,
      patientId: patient_id,
      serviceType: result.request.service_type,
    }).catch((err) => {
      logger.error('Failed to send request created notification', {
        requestId: result.request.id,
        error: err.message,
      });
    }); // AUDIT-FIX: P3-STEP7D-SRP - request-created notifications now live outside the controller.

    return result; // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the existing create-request response payload.
  }

  async updateRequestStatus(requestId, payload, actor, ip) { // AUDIT-FIX: P3-STEP7D-SRP - status-change orchestration moves out of the controller.
    const newStatus = payload.status === 'ACCEPTED' ? 'ASSIGNED' : payload.status; // AUDIT-FIX: P3-STEP7D-COMPAT - preserve ACCEPTED-to-ASSIGNED normalization.
    if (!VALID_REQUEST_STATUSES.includes(newStatus)) { // AUDIT-FIX: P3-STEP7D-COMPAT - preserve request-status validation semantics.
      throw new AppError(`status must be one of: ${VALID_REQUEST_STATUSES.join(', ')}`, 400, 'INVALID_STATUS'); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the current error contract.
    }

    const updated = await this.requestService.updateRequestStatus({
      id: requestId,
      status: newStatus,
      admin_notes: payload.admin_notes,
      scheduled_at: payload.scheduled_at,
      callerRole: actor.role,
      callerId: actor.id,
    }); // AUDIT-FIX: P3-STEP7D-DIP - extracted status-change orchestration reuses the existing request service.

    if (!updated) { // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the existing missing-request semantics.
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND'); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the current error contract.
    }

    audit('REQUEST_STATUS_CHANGED', {
      userId: actor.id,
      role: actor.role,
      targetId: requestId,
      targetType: 'request',
      ip,
      details: { status: newStatus },
    }); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve request-status audit logging.

    await this.notifications.notifyRequestStatusChanged({
      requestId,
      status: newStatus,
      patientId: updated.patient_id,
      providerId: updated.assigned_provider_id,
      adminNotes: payload.admin_notes,
    }).catch((err) => {
      logger.error('Failed to send status change notification', {
        requestId,
        status: newStatus,
        error: err.message,
      });
    }); // AUDIT-FIX: P3-STEP7D-SRP - status-change notifications now live outside the controller.

    return updated; // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the existing update-status response payload.
  }

  async completeWithPayment(requestId, actor, payload, ip) { // AUDIT-FIX: P3-STEP7D-SRP - completion-with-payment orchestration moves out of the controller.
    const request = await this.requestService.getRequestById(requestId, { callerId: actor.id, callerRole: actor.role }); // AUDIT-FIX: P3-STEP7D-DIP - extracted completion flow reuses the existing request service.
    if (!request) { // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the existing missing-request semantics.
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND'); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the current error contract.
    }

    if (request.status !== 'IN_PROGRESS') { // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the completion precondition for payment collection.
      throw new AppError('Request must be IN_PROGRESS to complete', 400, 'INVALID_STATUS_TRANSITION'); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the current error contract.
    }

    const amount = parseFloat(payload.collected_amount); // AUDIT-FIX: P3-STEP7D-SRP - lifecycle service now owns payment amount normalization.
    const updated = await this.requestService.updateRequestStatus({
      id: requestId,
      status: 'COMPLETED',
      callerRole: actor.role,
      callerId: actor.id,
      collectedAmount: amount,
      collectedMethod: payload.collected_method,
      collectedNotes: payload.collected_notes || null,
      allowProviderCompletionTransition: true,
    }); // AUDIT-FIX: P3-STEP7D-DIP - extracted completion flow reuses the existing request service.

    const invoice = await this.requestService.getInvoiceForRequest(requestId); // AUDIT-FIX: P3-STEP7D-DIP - invoice lookup now happens inside the lifecycle layer.
    if (invoice) { // AUDIT-FIX: P3-STEP7D-COMPAT - preserve conditional payment capture semantics.
      await this.payments.addPayment(invoice.id, {
        amount,
        payment_method: payload.collected_method === 'TRANSFER' ? 'OTHER' : 'CASH',
        paid_to_provider: true,
        provider_id: actor.id,
        provider_amount: amount,
        notes: payload.collected_notes || `Provider collected ${payload.collected_method}`,
      }, actor); // AUDIT-FIX: P3-STEP7D-DIP - provider-collected payment recording is now orchestrated from the lifecycle layer.
    }

    await this.workflowService.addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      eventType: 'STATUS_CHANGED',
      description: 'Provider completed the service and recorded payment',
      metadata: {
        from: 'IN_PROGRESS',
        to: 'COMPLETED',
        collected_amount: amount,
        collected_method: payload.collected_method,
      },
    }); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve lifecycle logging for completion-with-payment.

    audit('REQUEST_COMPLETED_WITH_PAYMENT', {
      userId: actor.id,
      role: actor.role,
      targetId: requestId,
      targetType: 'request',
      ip,
      details: { collected_amount: payload.collected_amount, collected_method: payload.collected_method },
    }); // AUDIT-FIX: P3-STEP7D-COMPAT - preserve completion-with-payment audit logging.

    await this.notifications.notifyRequestStatusChanged({
      requestId,
      status: 'COMPLETED',
      patientId: updated.patient_id,
      providerId: updated.assigned_provider_id,
    }).catch((err) => {
      logger.error('Failed to send completion notification', { requestId, error: err.message });
    }); // AUDIT-FIX: P3-STEP7D-SRP - completion notifications now live outside the controller.

    return { message: 'Request completed with payment recorded', status: 'COMPLETED' }; // AUDIT-FIX: P3-STEP7D-COMPAT - preserve the existing completion-with-payment response payload.
  }

  async getReportStatus(requestId, actor) { // AUDIT-FIX: P3-STEP7C-SRP - report-status orchestration moves out of the controller.
    const request = await this.requests.findById(requestId); // AUDIT-FIX: P3-STEP7C-DIP - request visibility checks now start from the repository.
    if (!request) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing missing-request semantics.
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    if (actor.role === 'PROVIDER') { // AUDIT-FIX: P3-STEP7C-SRP - provider authorization stays in the lifecycle layer.
      const allowed = await this.workflow.providerHasRequestAccess(requestId, actor.id); // AUDIT-FIX: P3-STEP7C-DIP - provider access checks go through the injected workflow repository.
      if (!allowed) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing provider access denial semantics.
        throw new AppError('Access denied', 403, 'FORBIDDEN'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
      }
    }

    if (actor.role === 'PATIENT' && request.patient_id !== actor.id) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve patient ownership checks for report visibility.
      throw new AppError('Access denied', 403, 'FORBIDDEN'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    const report = await this.requests.getReportStatus(requestId); // AUDIT-FIX: P3-STEP7C-DIP - report-status reads now go through the injected request repository.
    if (!report) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing null-when-missing report behavior.
      return null; // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the controller's current response payload for missing reports.
    }

    if (actor.role === 'PATIENT') { // AUDIT-FIX: P3-STEP7C-SRP - patient-specific response shaping now lives outside the controller.
      return {
        status: report.status,
        published_at: report.published_at,
        version: report.version,
        ...(request.status === 'CLOSED' && report.status === 'PUBLISHED'
          ? { pdf_url: report.pdf_url ?? null }
          : {}),
      }; // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing patient-safe report-status payload.
    }

    return report; // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing staff report-status payload.
  }

  async rateRequest(requestId, actor, payload) { // AUDIT-FIX: P3-STEP7C-SRP - request-rating orchestration moves out of the controller.
    if (actor.role !== 'PATIENT') { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current patient-only guard.
      throw new AppError('Patient access required', 403, 'FORBIDDEN'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    const request = await this.requests.getRequestForRating(requestId); // AUDIT-FIX: P3-STEP7C-DIP - rating precondition reads now go through the injected request repository.
    if (!request) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing missing-request semantics.
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    if (request.patient_id !== actor.id) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve patient ownership checks for rating.
      throw new AppError('Access denied', 403, 'FORBIDDEN'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    if (request.status !== 'COMPLETED') { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the completion precondition for rating.
      throw new AppError('Request must be completed before rating', 400, 'REQUEST_NOT_COMPLETED'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    const existing = await this.requests.getRequestRating(requestId); // AUDIT-FIX: P3-STEP7C-DIP - rating duplication checks now go through the injected request repository.
    if (existing) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the single-rating rule.
      throw new AppError('Request already rated', 409, 'REQUEST_ALREADY_RATED'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    return this.requests.createRequestRating({ // AUDIT-FIX: P3-STEP7C-DIP - request-rating inserts now go through the injected request repository.
      requestId,
      patientId: actor.id,
      rating: payload.rating,
      comment: payload.comment,
    });
  }

  async getProviderRatings(providerId, query = {}) { // AUDIT-FIX: P3-STEP7C-SRP - provider-rating orchestration moves out of the controller.
    const { page: safePage, limit: safeLimit, offset } = paginate(query, { defaultLimit: 10 }); // AUDIT-FIX: DRY — shared helper now normalizes provider-rating pagination

    const provider = await this.requests.getProviderById(providerId); // AUDIT-FIX: P3-STEP7C-DIP - provider reads now go through the injected request repository.
    if (!provider) { // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing missing-provider semantics.
      throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND'); // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the current error contract.
    }

    const [summary, total, data] = await Promise.all([ // AUDIT-FIX: P3-STEP7C-PERF - preserve concurrent provider-rating reads while moving orchestration out of the controller.
      this.requests.getProviderRatingsSummary(providerId),
      this.requests.getProviderRatingsCount(providerId),
      this.requests.getProviderRatings(providerId, safeLimit, offset),
    ]); // AUDIT-FIX: P3-STEP7C-DIP - all provider-rating reads now go through the injected request repository.

    return {
      provider,
      summary,
      data,
      pagination: paginationMeta(total, safePage, safeLimit), // AUDIT-FIX: DRY — standardized list response shape for provider ratings
    }; // AUDIT-FIX: P3-STEP7C-COMPAT - preserve the existing provider-rating response shape.
  }
}

module.exports = RequestLifecycleService; // AUDIT-FIX: P3-STEP7C-DIP - export the lifecycle service class for composition-root wiring.
module.exports.RequestLifecycleService = RequestLifecycleService; // AUDIT-FIX: P3-STEP7C-COMPAT - preserve a named class export for explicit imports.
