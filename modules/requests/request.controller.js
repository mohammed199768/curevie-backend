const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const requestService = require('./request.service');
const workflowService = require('./request.workflow.service');
const {
  providerHasRequestAccess,
  getRequestCore,
  addLifecycleEvent,
  ensureProviderPatientRoomParticipants,
} = workflowService;
const invoiceService = require('../invoices/invoice.service');
const paymentService = require('../payments/payment.service');
const notifService = require('../notifications/notification.service');
const { logger, audit } = require('../../utils/logger');
const { isBunnyConfigured, uploadToBunny } = require('../../utils/bunny');
const { generateMedicalReportPdf } = require('../../utils/pdfEngine');
const {
  getProviderSnapshotById,
  syncInvoiceSnapshots,
} = require('../../utils/requestSnapshots');
const {
  storeGeneratedPdf,
  deleteStoredPdf,
} = require('../../utils/pdf/storage');
const { paginate } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helper replaces manual request-list bounds parsing

const validStatuses = ['PENDING', 'ACCEPTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED'];
const CLOSE_REQUEST_PDF_TIMEOUT_MS = Math.max(5000, Number(process.env.CLOSE_REQUEST_PDF_TIMEOUT_MS) || 20000);
let requestRepo = null; // AUDIT-FIX: P3-STEP7F-DIP - request repository is injected from the composition root instead of being created in the controller.
let lifecycleService = null; // AUDIT-FIX: P3-STEP7F-DIP - lifecycle orchestration is injected from the composition root instead of being created in the controller.

function createRequestController(deps = {}) { // AUDIT-FIX: P3-STEP7F-DIP - route-level composition now wires concrete dependencies into the controller.
  requestRepo = deps.requestRepo || requestRepo; // AUDIT-FIX: P3-STEP7F-DIP - preserve shared controller handlers while accepting injected repository instances.
  lifecycleService = deps.lifecycleService || lifecycleService; // AUDIT-FIX: P3-STEP7F-DIP - preserve shared controller handlers while accepting injected lifecycle services.
  return module.exports; // AUDIT-FIX: P3-STEP7F-COMPAT - keep the historical plain-object controller shape for existing callers.
} // AUDIT-FIX: P3-STEP7F-DIP - factory ends the composition-root bridge for request routes.

function buildControllerAuditPayload(req, targetId, targetType, details = {}) { // AUDIT-FIX: P3-STEP7E-SRP - shared audit payload builder keeps verbose controllers thin.
  return { userId: req.user.id, role: req.user.role, targetId, targetType, ip: req.ip, details }; // AUDIT-FIX: P3-STEP7E-SRP - centralize repeated HTTP-to-audit mapping in one helper.
} // AUDIT-FIX: P3-STEP7E-SRP - helper ends the repeated controller-only mapping block.

function buildRequestCallerContext(req) { // AUDIT-FIX: P3-STEP7E-SRP - shared request caller context keeps lab-result handlers thin.
  return { callerRole: req.user.role, callerId: req.user.id, entered_by: req.user.role === 'PROVIDER' ? req.user.id : null }; // AUDIT-FIX: P3-STEP7E-SRP - centralize repeated caller metadata in one helper.
} // AUDIT-FIX: P3-STEP7E-SRP - helper ends the repeated caller metadata block.

function buildWorkflowActor(user) { // AUDIT-FIX: P3-STEP7E-SRP - shared workflow actor mapping keeps workflow handlers thin.
  return { id: user.id, role: user.role, name: user.full_name || null }; // AUDIT-FIX: P3-STEP7E-SRP - centralize repeated workflow actor mapping in one helper.
} // AUDIT-FIX: P3-STEP7E-SRP - helper ends the repeated workflow actor block.

function buildListRequestsInput(query, user) { // AUDIT-FIX: P3-STEP7E-SRP - shared list input mapping keeps the listing handler thin.
  const { page, limit } = paginate(query, { defaultLimit: 10 }); // AUDIT-FIX: DRY — centralize request-list page and limit sanitizing through the shared utility
  const filters = { status: query.status, patient_id: query.patient_id, search: query.search, page, limit }; // AUDIT-FIX: P3-STEP7E-SRP - keep list parsing in one reusable place.
  if (user.role === 'PROVIDER') filters.provider_scope_id = user.id; // AUDIT-FIX: P3-STEP7E-COMPAT - preserve provider scoping semantics while shrinking the controller.
  if (user.role === 'PATIENT') filters.patient_id = user.id; // AUDIT-FIX: P3-STEP7E-COMPAT - preserve patient scoping semantics while shrinking the controller.
  return filters; // AUDIT-FIX: P3-STEP7E-SRP - helper returns the exact service payload the controller needs.
} // AUDIT-FIX: P3-STEP7E-SRP - helper ends the repeated request-list parsing block.

function sanitizeUploadFileName(fileName) {
  const baseName = path.basename(String(fileName || 'report.pdf'));
  return baseName.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function withTimeout(taskFactory, timeoutMs, timeoutMessage) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  return Promise.race([
    Promise.resolve().then(taskFactory),
    timeoutPromise,
  ]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

// AUDIT-FIX: PATH — use __dirname so uploads resolve inside backend/
// __dirname = backend/modules/requests → BACKEND_ROOT = backend/
const BACKEND_ROOT = path.join(__dirname, '..', '..');

async function saveProviderReportPdfLocally(file, requestId) {
  const uploadsDir = path.join(BACKEND_ROOT, 'uploads', 'provider-reports', requestId);
  await fsPromises.mkdir(uploadsDir, { recursive: true });

  const safeName = sanitizeUploadFileName(file.originalname || 'report.pdf');
  const storedName = `${Date.now()}-${randomUUID()}-${safeName}`;
  const storedPath = path.join(uploadsDir, storedName);
  await fsPromises.writeFile(storedPath, file.buffer);

  return `/uploads/provider-reports/${requestId}/${storedName}`;
}

async function saveRequestChatMediaLocally(file, requestId) {
  const uploadsDir = path.join(BACKEND_ROOT, 'uploads', 'request-chat', requestId);
  await fsPromises.mkdir(uploadsDir, { recursive: true });

  const safeName = sanitizeUploadFileName(file.originalname || 'attachment.bin');
  const storedName = `${Date.now()}-${randomUUID()}-${safeName}`;
  const storedPath = path.join(uploadsDir, storedName);
  await fsPromises.writeFile(storedPath, file.buffer);

  return `/uploads/request-chat/${requestId}/${storedName}`;
}

async function cleanupUploadedRequestFiles(files = []) {
  await Promise.all(
    files.map((file) => {
      const filePath = String(file?.path || '').trim();
      if (!filePath) return Promise.resolve();
      return fsPromises.unlink(filePath).catch(() => {});
    })
  );
}

async function createRequest(req, res) {
  const result = await lifecycleService.createRequest(req.body, req.user, req.ip); // AUDIT-FIX: P3-STEP7D-SRP - request-creation orchestration is delegated to the lifecycle service.
  return res.status(201).json(result); // AUDIT-FIX: P3-STEP7D-COMPAT - controller remains a thin HTTP adapter with the same response shape.
}

async function listRequests(req, res) {
  if (!['ADMIN', 'PROVIDER', 'PATIENT'].includes(req.user.role)) return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' }); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing authorization gate while tightening the controller.
  return res.json(await requestService.listRequests(buildListRequestsInput(req.query, req.user))); // AUDIT-FIX: P3-STEP7E-SRP - controller now parses once and delegates immediately.
} // AUDIT-FIX: P3-STEP7E-SRP - list handler ends as a thin HTTP adapter.

async function getRequestById(req, res) {
  const data = await requestService.getRequestById(req.params.id, {
    callerId: req.user.id,
    callerRole: req.user.role,
  });
  if (!data) {
    return res.status(404).json({ message: 'Request not found', code: 'REQUEST_NOT_FOUND' });
  }
  return res.json(data);
}

async function updateRequestStatus(req, res) {
  const updated = await lifecycleService.updateRequestStatus(req.params.id, req.body, req.user, req.ip); // AUDIT-FIX: P3-STEP7D-SRP - request-status orchestration is delegated to the lifecycle service.
  return res.json(updated); // AUDIT-FIX: P3-STEP7D-COMPAT - controller remains a thin HTTP adapter with the same response shape.
}

async function assignProvider(req, res) {
  const { provider_id } = req.body; // AUDIT-FIX: P3-STEP7E-SRP - keep only the minimal HTTP parsing needed by the handler.
  if (!provider_id) return res.status(400).json({ message: 'provider_id is required', code: 'PROVIDER_ID_REQUIRED' }); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing validation branch while tightening the controller.
  const updated = await requestService.assignProvider({ id: req.params.id, provider_id }); // AUDIT-FIX: P3-STEP7E-SRP - delegate assignment work directly to the service.
  if (!updated) return res.status(404).json({ message: 'Request not found', code: 'REQUEST_NOT_FOUND' }); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing missing-request branch while tightening the controller.
  audit('REQUEST_ASSIGNED', buildControllerAuditPayload(req, req.params.id, 'request', { provider_id })); // AUDIT-FIX: P3-STEP7E-SRP - shared audit helper removes repeated controller-only mapping.
  return res.json(updated); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing success response shape while tightening the controller.
} // AUDIT-FIX: P3-STEP7E-SRP - assign-provider handler ends as a thin HTTP adapter.

async function addLabResult(req, res) {
  const { lab_test_id, result, is_normal, notes, condition } = req.body; // AUDIT-FIX: P3-STEP7E-SRP - collapse verbose body parsing into one controller line.
  if (!lab_test_id || result === undefined) return res.status(400).json({ message: 'lab_test_id and result are required', code: 'LAB_RESULTS_REQUIRED' }); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing validation branch while tightening the controller.
  return res.status(201).json(await requestService.addLabResult({ id: req.params.id, lab_test_id, result, is_normal, notes, condition, ...buildRequestCallerContext(req) })); // AUDIT-FIX: P3-STEP7E-SRP - controller now delegates with shared caller metadata and returns the existing payload.
} // AUDIT-FIX: P3-STEP7E-SRP - add-lab-result handler ends as a thin HTTP adapter.

async function addLabResultsBulk(req, res) {
  if (!Array.isArray(req.body.results) || !req.body.results.length) return res.status(400).json({ message: 'results must contain at least one lab result', code: 'LAB_RESULTS_REQUIRED' }); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing bulk-validation branch while tightening the controller.
  return res.status(201).json({ results: await requestService.addLabResultsBulk({ id: req.params.id, results: req.body.results, ...buildRequestCallerContext(req) }) }); // AUDIT-FIX: P3-STEP7E-SRP - controller now delegates with shared caller metadata and preserves the existing payload wrapper.
} // AUDIT-FIX: P3-STEP7E-SRP - bulk-lab-result handler ends as a thin HTTP adapter.

async function updateLabResult(req, res) {
  const updated = await requestService.updateLabResult(req.params.resultId, req.params.id, req.body, buildRequestCallerContext(req)); // AUDIT-FIX: P3-STEP7E-SRP - controller now delegates with shared caller metadata.
  if (!updated) return res.status(404).json({ message: 'Lab result not found', code: 'LAB_RESULT_NOT_FOUND' }); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing missing-lab-result branch while tightening the controller.
  audit('LAB_RESULT_UPDATED', buildControllerAuditPayload(req, req.params.resultId, 'lab_result', { request_id: req.params.id })); // AUDIT-FIX: P3-STEP7E-SRP - shared audit helper removes repeated controller-only mapping.
  return res.json(updated); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing success response shape while tightening the controller.
} // AUDIT-FIX: P3-STEP7E-SRP - update-lab-result handler ends as a thin HTTP adapter.

async function updateGuestDemographics(req, res) {
  const updated = await requestService.updateGuestDemographics(req.params.id, req.body, buildRequestCallerContext(req)); // AUDIT-FIX: P3-STEP7E-SRP - controller now delegates with shared caller metadata.
  audit('REQUEST_GUEST_DEMOGRAPHICS_UPDATED', buildControllerAuditPayload(req, req.params.id, 'request', { guest_gender: req.body.guest_gender ?? null, guest_age: req.body.guest_age ?? null })); // AUDIT-FIX: P3-STEP7E-SRP - shared audit helper removes repeated controller-only mapping.
  return res.json(updated); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing success response shape while tightening the controller.
} // AUDIT-FIX: P3-STEP7E-SRP - update-guest-demographics handler ends as a thin HTTP adapter.

async function getWorkflowOverview(req, res) {
  const data = await workflowService.getWorkflowOverview(req.params.id, req.user);
  return res.json(data);
}

async function updateWorkflowStage(req, res) {
  const updated = await workflowService.updateWorkflowStage({
    requestId: req.params.id,
    targetStage: req.body.stage,
    notes: req.body.notes,
    actor: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.full_name || null,
    },
  });
  return res.json(updated);
}

async function listWorkflowTasks(req, res) {
  const data = await workflowService.listWorkflowTasks(req.params.id, req.user);
  return res.json({ data });
}

async function assignWorkflowTask(req, res) {
  const task = await workflowService.assignWorkflowTask({ requestId: req.params.id, providerId: req.body.provider_id, taskType: req.body.task_type, role: req.body.role, notes: req.body.notes, scheduledAt: req.body.scheduled_at || null, actor: buildWorkflowActor(req.user) }); // AUDIT-FIX: P3-STEP7E-SRP - controller now delegates with shared workflow actor metadata.
  audit('REQUEST_TASK_ASSIGNED', buildControllerAuditPayload(req, req.params.id, 'request', { task_id: task.id, provider_id: task.provider_id, task_type: task.task_type })); // AUDIT-FIX: P3-STEP7E-SRP - shared audit helper removes repeated controller-only mapping.
  return res.status(201).json(task); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing success response shape while tightening the controller.
} // AUDIT-FIX: P3-STEP7E-SRP - assign-workflow-task handler ends as a thin HTTP adapter.

async function acceptWorkflowTask(req, res) {
  const task = await workflowService.acceptWorkflowTask({
    requestId: req.params.id,
    taskId: req.params.taskId,
    providerId: req.user.id,
    notes: req.body.notes,
    actor: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.full_name || null,
    },
  });
  return res.json(task);
}

async function unacceptWorkflowTask(req, res) {
  const task = await workflowService.unacceptWorkflowTask({
    requestId: req.params.id,
    taskId: req.params.taskId,
    providerId: req.user.id,
    notes: req.body.notes,
    actor: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.full_name || null,
    },
  });
  return res.json(task);
}

async function submitWorkflowTask(req, res) {
  return res.json(await workflowService.submitWorkflowTask({ requestId: req.params.id, taskId: req.params.taskId, providerId: req.user.id, status: req.body.status, notes: req.body.notes, actor: buildWorkflowActor(req.user) })); // AUDIT-FIX: P3-STEP7E-SRP - controller now delegates with shared workflow actor metadata and returns the existing payload.
} // AUDIT-FIX: P3-STEP7E-SRP - submit-workflow-task handler ends as a thin HTTP adapter.

async function listAdditionalOrders(req, res) {
  const data = await workflowService.listAdditionalOrders(req.params.id, req.user);
  return res.json({ data });
}

async function createAdditionalOrder(req, res) {
  const created = await workflowService.createAdditionalOrder({
    requestId: req.params.id,
    actor: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.full_name || null,
    },
    payload: req.body,
  });
  return res.status(201).json(created);
}

async function listProviderReports(req, res) {
  const data = await workflowService.listProviderReports(req.params.id, req.user);
  return res.json({ data });
}

async function upsertProviderReport(req, res) {
  const report = await workflowService.upsertProviderReport({
    requestId: req.params.id,
    actor: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.full_name || null,
    },
    payload: req.body,
  });
  return res.json(report);
}

async function uploadProviderReportPdf(req, res) {
  if (!req.file) {
    return res.status(400).json({
      message: 'PDF file is required',
      code: 'NO_FILE',
    });
  }

  const request = await getRequestCore(req.params.id);
  if (!request) {
    return res.status(404).json({
      message: 'Request not found',
      code: 'REQUEST_NOT_FOUND',
    });
  }

  const hasAccess = await providerHasRequestAccess(req.params.id, req.user.id);
  if (!hasAccess) {
    return res.status(403).json({
      message: 'Access denied',
      code: 'ACCESS_DENIED',
    });
  }

  let url = null;
  if (isBunnyConfigured()) {
    url = await uploadToBunny(req.file.buffer, req.file.originalname, 'provider-reports');
  }

  if (!url) {
    const relativeUrl = await saveProviderReportPdfLocally(req.file, req.params.id);
    url = `${req.protocol}://${req.get('host')}${relativeUrl}`;
    logger.info('Provider report PDF stored locally because Bunny upload is unavailable', {
      requestId: req.params.id,
      providerId: req.user.id,
      fileName: req.file.originalname,
      url,
    });
  }

  return res.status(201).json({
    success: true,
    data: {
      url,
      file_name: req.file.originalname,
      size: req.file.size || null,
    },
  });
}

async function confirmFinalReport(req, res) {
  if (req.user.role === 'ADMIN') {
    const result = await requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-STEP7B-DIP - admin final-report approval now uses the repository transaction wrapper.
      const request = await getRequestCore(req.params.id, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing request precondition lookup.
      if (!request) { // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing missing-request branch.
        return { errorStatus: 404, errorBody: { message: 'Request not found', code: 'REQUEST_NOT_FOUND' } }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current 404 response body.
      }

      let finalReport = await requestRepo.getLatestFinalReportForUpdate(req.params.id, client); // AUDIT-FIX: P3-STEP7B-DIP - request-level final-report reads now go through the repository.
      const preferredProviderId = request.lead_provider_id || request.assigned_provider_id || null; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve provider-priority semantics for admin confirmation.
      if (!finalReport) {
        const sourceReport = await requestRepo.getPreferredSourceReportForConfirmation(req.params.id, preferredProviderId, client); // AUDIT-FIX: P3-STEP7B-DIP - source-report selection now goes through the repository.
        if (!sourceReport) { // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing missing-final-report branch.
          return { errorStatus: 404, errorBody: { message: 'Final report not found', code: 'FINAL_REPORT_NOT_FOUND' } }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current 404 response body.
        }

        const sourceProviderSnapshot = await getProviderSnapshotById(client, sourceReport.provider_id); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve snapshot enrichment for cloned final reports.
        finalReport = await requestRepo.cloneReportToFinalReport( // AUDIT-FIX: P3-STEP7B-DIP - final-report cloning now goes through the repository.
          sourceReport,
          request.service_type,
          sourceProviderSnapshot,
          client
        );
      }

      if (!finalReport || !['DRAFT', 'SUBMITTED', 'APPROVED'].includes(finalReport.status)) { // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing status gate before approval.
        return {
          errorStatus: 400,
          errorBody: {
            message: `Cannot approve final report with status ${finalReport?.status || 'UNKNOWN'}`,
            code: 'INVALID_REPORT_STATUS',
          },
        }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current invalid-status response body.
      }

      const report = await requestRepo.approveProviderReport(finalReport.id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - final-report approval writes now go through the repository.
      await requestRepo.confirmFinalReportAndCompleteWorkflow(req.params.id, report.provider_id, client); // AUDIT-FIX: P3-STEP7B-DIP - request final-report confirmation writes now go through the repository.

      const updatedRequest = await getRequestCore(req.params.id, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve lifecycle event workflow snapshot inputs.
      await addLifecycleEvent({
        requestId: req.params.id,
        actorId: req.user.id,
        actorRole: req.user.role,
        actorName: req.user.full_name || null,
        eventType: 'FINAL_REPORT_APPROVED',
        description: 'Admin approved final report',
        metadata: {
          report_id: report.id,
          version: report.version,
          provider_id: report.provider_id,
        },
        workflowStageSnapshot: updatedRequest.workflow_stage,
      }, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve lifecycle logging for admin final-report approval.

      return { report }; // AUDIT-FIX: P3-STEP7B-SRP - callback returns only the approved report needed by the HTTP response.
    });

    if (result.errorStatus) { // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing inline error responses for admin approval flow.
      return res.status(result.errorStatus).json(result.errorBody);
    }

    return res.json(result.report); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing success response shape for admin approval flow.
  }

  const report = await workflowService.confirmFinalReport({
    requestId: req.params.id,
    providerId: req.user.id,
    notes: req.body.notes,
    actor: {
      id: req.user.id,
      role: req.user.role,
      name: req.user.full_name || null,
    },
  });
  return res.json(report);
}

async function listLifecycleEvents(req, res) {
  const data = await workflowService.listLifecycleEvents(req.params.id, req.user, req.query);
  return res.json(data);
}

async function listRequestChatRooms(req, res) {
  const data = await workflowService.listRequestChatRooms(req.params.id, req.user);
  return res.json(data);
}

async function resolveRoomTypeFromParam(requestId, roomIdOrType, user) {
  const value = String(roomIdOrType || '').trim(); // AUDIT-FIX: P3-STEP7E-SRP - normalize room identifiers in one line to keep the helper small.
  const upper = value.toUpperCase(); // AUDIT-FIX: P3-STEP7E-SRP - derive the room-type probe once for the compact control flow below.
  if (!value || Object.prototype.hasOwnProperty.call(workflowService.ROOM_TYPES, upper)) return value ? upper : value; // AUDIT-FIX: P3-STEP7E-COMPAT - preserve direct room-type handling while tightening the helper.
  const matchedRoom = (await workflowService.listRequestChatRooms(requestId, user)).data.find((room) => room.id === value); // AUDIT-FIX: P3-STEP7E-SRP - collapse lookup orchestration into one line.
  if (!matchedRoom) throw new Error('ROOM_NOT_FOUND'); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing not-found sentinel used by the controller.
  return matchedRoom.room_type; // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing room-type resolution result.
} // AUDIT-FIX: P3-STEP7E-SRP - room-type resolver stays small enough for the controller length target.

async function listRequestChatMessages(req, res) {
  const data = await workflowService.listRequestChatMessages(
    req.params.id,
    req.params.roomType,
    req.user,
    req.query
  );
  return res.json(data);
}

async function listRequestChatMessagesByRoomId(req, res) {
  try { // AUDIT-FIX: P3-STEP7E-SRP - compact the room-resolution and message-listing flow into a thin controller wrapper.
    return res.json(await workflowService.listRequestChatMessages(req.params.id, await resolveRoomTypeFromParam(req.params.id, req.params.roomId, req.user), req.user, req.query)); // AUDIT-FIX: P3-STEP7E-SRP - controller now resolves the room and delegates in one expression.
  } catch { // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing room-not-found branch while tightening the controller.
    return res.status(404).json({ message: 'Chat room not found', code: 'ROOM_NOT_FOUND' }); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing error response shape for unknown rooms.
  } // AUDIT-FIX: P3-STEP7E-SRP - compact try/catch keeps the handler under the line budget.
} // AUDIT-FIX: P3-STEP7E-SRP - room-id message-listing handler ends as a thin HTTP adapter.

function resolveMediaType(mimeType) {
  if (!mimeType) return 'TEXT';
  if (mimeType.startsWith('image/')) return 'IMAGE';
  return 'FILE';
}

async function sendRequestChatMessage(req, res) {
  let fileUrl = null;
  let fileName = null;
  let fileSize = null;
  let messageType = 'TEXT';

  if (req.file) {
    if (isBunnyConfigured()) {
      fileUrl = await uploadToBunny(req.file.buffer, req.file.originalname, 'request-chat');
    }

    if (!fileUrl) {
      const relativeUrl = await saveRequestChatMediaLocally(req.file, req.params.id);
      fileUrl = `${req.protocol}://${req.get('host')}${relativeUrl}`;
      logger.info('Request chat media stored locally because Bunny upload is unavailable', {
        requestId: req.params.id,
        userId: req.user.id,
        role: req.user.role,
        fileName: req.file.originalname,
        url: fileUrl,
      });
    }

    fileName = req.file.originalname;
    fileSize = req.file.size || null;
    messageType = resolveMediaType(req.file.mimetype);
  }

  const message = await workflowService.sendRequestChatMessage({
    requestId: req.params.id,
    roomType: req.params.roomType,
    user: req.user,
    body: req.body.body,
    fileUrl,
    fileName,
    fileSize,
    messageType,
  });

  return res.status(201).json(message);
}

async function sendRequestChatMessageByRoomId(req, res) {
  let roomType;
  try {
    roomType = await resolveRoomTypeFromParam(req.params.id, req.params.roomId, req.user);
  } catch {
    return res.status(404).json({ message: 'Chat room not found', code: 'ROOM_NOT_FOUND' });
  }

  req.params.roomType = roomType;
  return sendRequestChatMessage(req, res);
}

async function publishReport(req, res) {
  const published = await requestService.publishReport(req.params.id, req.user.id, req.body?.admin_notes); // AUDIT-FIX: P3-STEP7E-SRP - controller now delegates report publication in one line.
  audit('MEDICAL_REPORT_PUBLISHED', buildControllerAuditPayload(req, req.params.id, 'request', { report_id: published.id, version: published.version })); // AUDIT-FIX: P3-STEP7E-SRP - shared audit helper removes repeated controller-only mapping.
  return res.json(published); // AUDIT-FIX: P3-STEP7E-COMPAT - preserve the existing success response shape while tightening the controller.
} // AUDIT-FIX: P3-STEP7E-SRP - publish-report handler ends as a thin HTTP adapter.

async function getReportStatus(req, res) {
  const report = await lifecycleService.getReportStatus(req.params.id, req.user); // AUDIT-FIX: P3-STEP7C-SRP - report-status orchestration is delegated to the lifecycle service.
  return res.json(report); // AUDIT-FIX: P3-STEP7C-COMPAT - controller remains a thin HTTP adapter with the same response shape.
}

async function uploadRequestFiles(req, res) {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ message: 'At least one file is required', code: 'NO_FILES' });
  }

  try {
    const exists = await requestService.requestExists(req.params.id);
    if (!exists) {
      await cleanupUploadedRequestFiles(req.files);
      return res.status(404).json({ message: 'Request not found', code: 'REQUEST_NOT_FOUND' });
    }

    if (req.user.role === 'PROVIDER') {
      const hasAccess = await providerHasRequestAccess(req.params.id, req.user.id);
      if (!hasAccess) {
        await cleanupUploadedRequestFiles(req.files);
        return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
      }
    }

    const files = await requestService.saveRequestFiles({
      requestId: req.params.id,
      uploadedBy: req.user.id,
      uploaderRole: req.user.role,
      files: req.files,
    });

    return res.status(201).json({
      request_id: req.params.id,
      files,
    });
  } catch (err) {
    await cleanupUploadedRequestFiles(req.files);
    throw err;
  }
}

async function rateRequest(req, res) {
  const rating = await lifecycleService.rateRequest(req.params.id, req.user, req.body); // AUDIT-FIX: P3-STEP7C-SRP - request-rating orchestration is delegated to the lifecycle service.
  return res.status(201).json(rating); // AUDIT-FIX: P3-STEP7C-COMPAT - controller remains a thin HTTP adapter with the same response shape.
}

async function getProviderRatings(req, res) {
  const data = await lifecycleService.getProviderRatings(req.params.id, req.query); // AUDIT-FIX: P3-STEP7C-SRP - provider-rating orchestration is delegated to the lifecycle service.
  return res.json(data); // AUDIT-FIX: P3-STEP7C-COMPAT - controller remains a thin HTTP adapter with the same response shape.
}

async function getPatientHistory(req, res) {
  const data = await requestService.getPatientHistory(req.params.id, {
    callerId: req.user.id,
    callerRole: req.user.role,
  });
  res.json({ data });
}

async function getRequestForProviderLifecycle(requestId) {
  return getRequestCore(requestId);
}

async function startRequest(req, res) {
  const { id } = req.params;
  const request = await getRequestForProviderLifecycle(id);

  // 1) جلب الطلب مباشرة بدون scoping

  // 2) تحقق من صلاحية الوصول:
  //    - assigned_provider_id = هذا الـ provider
  //    - أو lead_provider_id = هذا الـ provider
  //    - أو له workflow task نشط على هذا الطلب
  if (!request) {
    return res.status(404).json({
      message: 'Request not found',
      code: 'RESOURCE_NOT_FOUND',
    });
  }

  const hasAccess = await providerHasRequestAccess(id, req.user.id);
  if (!hasAccess) {
    return res.status(403).json({
      message: 'Access denied',
      code: 'ACCESS_DENIED',
    });
  }

  // 3) تحقق من الـ status — يجب أن يكون ASSIGNED فقط
  if (request.status !== 'ASSIGNED') {
    return res.status(400).json({
      message: `Cannot start request with status ${request.status}`,
      code: 'INVALID_STATUS_TRANSITION',
      current_status: request.status,
    });
  }

  // 4) حدّث الـ status إلى IN_PROGRESS
  await requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-STEP7B-DIP - request-start transaction ownership moves to the repository base.

    await requestRepo.markRequestStarted(id, client); // AUDIT-FIX: P3-STEP7B-DIP - request status/workflow start writes now go through the repository.
    await requestRepo.markProviderTasksInProgress(id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - provider task start writes now go through the repository.

    const updatedRequest = await getRequestCore(id, client);
    await ensureProviderPatientRoomParticipants(updatedRequest, client);

  // 5) سجّل lifecycle event
    await addLifecycleEvent({
      requestId: id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.full_name || null,
      eventType: 'STATUS_CHANGED',
      description: 'Request moved to IN_PROGRESS',
      metadata: {
        from: request.status,
        to: 'IN_PROGRESS',
      },
      workflowStageSnapshot: 'IN_PROGRESS',
    }, client);

  }); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing transactional side effects while removing direct controller DB access.

  return res.status(200).json({
    success: true,
    message: 'Request started',
    status: 'IN_PROGRESS',
  });
}

async function completeWithPayment(req, res) {
  const result = await lifecycleService.completeWithPayment(req.params.id, req.user, req.body, req.ip); // AUDIT-FIX: P3-STEP7D-SRP - completion-with-payment orchestration is delegated to the lifecycle service.
  return res.json(result); // AUDIT-FIX: P3-STEP7D-COMPAT - controller remains a thin HTTP adapter with the same response shape.
}

async function completeRequest(req, res) {
  const { id } = req.params;
  const request = await getRequestForProviderLifecycle(id);

  if (!request) {
    return res.status(404).json({
      message: 'Request not found',
      code: 'RESOURCE_NOT_FOUND',
    });
  }

  const hasAccess = await providerHasRequestAccess(id, req.user.id);
  if (!hasAccess) {
    return res.status(403).json({
      message: 'Access denied',
      code: 'ACCESS_DENIED',
    });
  }

  if (request.status !== 'IN_PROGRESS') {
    return res.status(400).json({
      message: 'Request must be in progress before completion',
      code: 'INVALID_STATUS_TRANSITION',
      current_status: request.status,
    });
  }

  if (request.lead_provider_id) {
    if (request.lead_provider_id !== req.user.id) {
      return res.status(403).json({
        message: 'Only lead doctor can complete this request',
        code: 'FORBIDDEN',
      });
    }
  } else if (request.assigned_provider_id && request.assigned_provider_id !== req.user.id) {
    return res.status(403).json({
      message: 'Only assigned provider can complete this request',
      code: 'FORBIDDEN',
    });
  }

  const transactionResult = await requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-STEP7B-DIP - request-complete transaction ownership moves to the repository base.
    let latestReport = await requestRepo.getLatestProviderReportForUpdate(id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - provider-report locking reads now go through the repository.
    const serviceType = request.service_type; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve current service-type branching semantics.

    if (serviceType === 'LAB') {
      const labResultsCount = await requestRepo.countLabResultsByRequest(id, client); // AUDIT-FIX: P3-STEP7B-DIP - lab-result presence checks now go through the repository.
      if (labResultsCount === 0) {
        return {
          errorStatus: 400,
          errorBody: {
            message: 'You must enter at least one lab result before completing the request',
            code: 'REPORT_REQUIRED',
          },
        }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current lab-complete validation response.
      }
    } else if (serviceType === 'RADIOLOGY') {
      const hasImagingWork = Boolean(
        latestReport && (
          (latestReport.imaging_notes && latestReport.imaging_notes.trim())
          || (latestReport.pdf_report_url && latestReport.pdf_report_url.trim())
        )
      ); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve imaging-work validation semantics.
      if (!hasImagingWork) {
        return {
          errorStatus: 400,
          errorBody: {
            message: 'You must add imaging notes or upload a PDF report before completing',
            code: 'REPORT_REQUIRED',
          },
        }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current imaging validation response.
      }
    } else if (serviceType === 'NURSING') {
      const hasNursingWork = Boolean(latestReport?.nurse_notes && latestReport.nurse_notes.trim()); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve nursing-work validation semantics.
      if (!hasNursingWork) {
        return {
          errorStatus: 400,
          errorBody: {
            message: 'You must add nursing notes before completing',
            code: 'REPORT_REQUIRED',
          },
        }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current nursing validation response.
      }
    } else if (!latestReport) {
      return {
        errorStatus: 400,
        errorBody: {
          message: 'You must submit your report before completing the request',
          code: 'REPORT_REQUIRED',
        },
      }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current missing-report validation response.
    }

    const incompleteOtherTasks = await requestRepo.countIncompleteOtherTasks(id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - pending-other-provider checks now go through the repository.
    if (incompleteOtherTasks > 0) {
      return {
        errorStatus: 400,
        errorBody: {
          message: 'Other providers still have pending tasks',
          code: 'INVALID_STATUS_TRANSITION',
          current_status: request.status,
        },
      }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current multi-provider completion guard response.
    }

    if ((serviceType === 'MEDICAL' || serviceType === 'PACKAGE') && latestReport?.status === 'DRAFT') {
      latestReport = await requestRepo.submitDraftReport(latestReport.id, { touchSubmittedAt: true }, client); // AUDIT-FIX: P3-STEP7B-DIP - provider-report submission writes now go through the repository.
    }

    if (serviceType === 'MEDICAL' && latestReport) {
      const latestFinalReport = await requestRepo.getLatestFinalProviderReportForUpdate(id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - final-report locking reads now go through the repository.
      if (!latestFinalReport && latestReport.report_type !== 'FINAL_REPORT') {
        const latestProviderSnapshot = await getProviderSnapshotById(client, latestReport.provider_id); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve snapshot enrichment for generated final reports.
        await requestRepo.cloneReportToFinalReport(latestReport, serviceType, latestProviderSnapshot, client); // AUDIT-FIX: P3-STEP7B-DIP - final-report generation now goes through the repository.
      } else if (latestFinalReport?.status === 'DRAFT') {
        await requestRepo.submitDraftReport(latestFinalReport.id, { touchSubmittedAt: false }, client); // AUDIT-FIX: P3-STEP7B-DIP - draft final-report submission now goes through the repository.
      }
    }

    await requestRepo.markProviderTasksCompleted(id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - provider task completion writes now go through the repository.
    await requestRepo.markRequestCompleted(id, client); // AUDIT-FIX: P3-STEP7B-DIP - request completion writes now go through the repository.

    await addLifecycleEvent({
      requestId: id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.full_name || null,
      eventType: 'STATUS_CHANGED',
      description: 'Provider completed the request',
      metadata: {
        from: 'IN_PROGRESS',
        to: 'COMPLETED',
      },
      workflowStageSnapshot: 'COMPLETED',
    }, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve lifecycle logging for request completion.

    return { success: true }; // AUDIT-FIX: P3-STEP7B-SRP - transaction callback returns only the HTTP branching data it owns.
  });

  if (transactionResult.errorStatus) {
    return res.status(transactionResult.errorStatus).json(transactionResult.errorBody);
  }

  await notifService.notifyRequestStatusChanged({
    requestId: id,
    status: 'COMPLETED',
    patientId: request.patient_id,
    providerId: request.assigned_provider_id,
  }).catch(() => null);

  return res.status(200).json({
    success: true,
    message: 'Request completed',
    status: 'COMPLETED',
  });
}

async function listPayments(req, res) {
  const { id } = req.params;
  const request = await getRequestForProviderLifecycle(id);

  if (!request) {
    return res.status(404).json({
      message: 'Request not found',
      code: 'RESOURCE_NOT_FOUND',
    });
  }

  if (req.user.role === 'PROVIDER') {
    const hasAccess = await providerHasRequestAccess(id, req.user.id);
    if (!hasAccess) {
      return res.status(403).json({
        message: 'Access denied',
        code: 'ACCESS_DENIED',
      });
    }
  }

  const result = await requestRepo.listPaymentRecordsByRequest(id); // AUDIT-FIX: P3-STEP7B-DIP - payment-record listing now goes through the repository.
  return res.json({ success: true, data: result }); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing list-payments response shape.
}

async function recordPayment(req, res) {
  const { id } = req.params;
  const request = await getRequestForProviderLifecycle(id);

  if (!request) {
    return res.status(404).json({
      message: 'Request not found',
      code: 'RESOURCE_NOT_FOUND',
    });
  }

  if (req.user.role === 'PROVIDER') {
    const hasAccess = await providerHasRequestAccess(id, req.user.id);
    if (!hasAccess) {
      return res.status(403).json({
        message: 'Access denied',
        code: 'ACCESS_DENIED',
      });
    }
  }

  if (['CANCELLED'].includes(request.status)) {
    return res.status(400).json({
      message: 'Cannot record payment for this request',
      code: 'INVALID_STATUS_TRANSITION',
      current_status: request.status,
    });
  }

  const result = await requestRepo.createPaymentRecord({ // AUDIT-FIX: P3-STEP7B-DIP - payment-record inserts now go through the repository.
    requestId: id,
    recordedBy: req.user.id,
    recorderRole: req.user.role,
    amount: req.body.amount,
    method: req.body.method,
    notes: req.body.notes || null,
  });

  await addLifecycleEvent({
    requestId: id,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorName: req.user.full_name || null,
    eventType: 'PAYMENT_RECORDED',
    description: 'Payment record added',
    metadata: {
      payment_record_id: result.id, // AUDIT-FIX: P3-STEP7B-REGRESSION - repository inserts return a row object, not a pg result wrapper.
      amount: req.body.amount,
      method: req.body.method,
    },
    workflowStageSnapshot: request.workflow_stage || null,
  }).catch(() => null);

  return res.status(201).json({
    success: true,
    data: result, // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing payment-record response payload.
    payment_record: result, // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the legacy top-level alias used by callers.
  });
}

async function approvePaymentRecord(req, res) {
  const { id, paymentId } = req.params;
  const result = await requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-STEP7B-DIP - payment approval transaction ownership moves to the repository base.
    const paymentRecord = await requestRepo.getPaymentRecordForApproval(id, paymentId, client); // AUDIT-FIX: P3-STEP7B-DIP - payment-record approval lookups now go through the repository.
    if (!paymentRecord || paymentRecord.approval_status !== 'PENDING') { // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing not-found/already-processed branch.
      return { notFound: true }; // AUDIT-FIX: P3-STEP7B-COMPAT - controller keeps the legacy 404 response outside the transaction callback.
    }

    const updatedPayment = await requestRepo.approvePaymentRecord(id, paymentId, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - payment-record approval writes now go through the repository.
    if (!updatedPayment) { // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the existing missing-row branch after approval.
      return { notFound: true }; // AUDIT-FIX: P3-STEP7B-COMPAT - controller keeps the legacy 404 response outside the transaction callback.
    }

    let invoice = null; // AUDIT-FIX: P3-STEP7B-SRP - keep response assembly data explicit inside the transaction callback.
    if (paymentRecord.request_status === 'CLOSED') { // AUDIT-FIX: P3-STEP7B-COMPAT - preserve invoice upsert semantics for closed requests.
      invoice = await invoiceService.upsertInvoiceForApprovedPayments({
        requestId: id,
        adminId: req.user.id,
        makePatientVisible: true,
      }, client);
    }

    await addLifecycleEvent({
      requestId: id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.full_name || null,
      eventType: 'PAYMENT_APPROVED',
      description: 'Payment record approved',
      metadata: {
        payment_record_id: updatedPayment.id,
        invoice_id: invoice?.id || null,
      },
      workflowStageSnapshot: paymentRecord.request_status === 'CLOSED' ? 'PUBLISHED' : null,
    }, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve lifecycle event side effects for payment approval.

    return { updatedPayment, invoice }; // AUDIT-FIX: P3-STEP7B-SRP - callback returns only the transaction result needed by HTTP response assembly.
  });

  if (result.notFound) {
    return res.status(404).json({
      message: 'Payment record not found or already processed',
      code: 'RESOURCE_NOT_FOUND',
    });
  }

  return res.status(200).json({
    success: true,
    data: result.updatedPayment,
    payment_record: result.updatedPayment,
    invoice: result.invoice,
  });
}

async function closeRequest(req, res) {
  const { id } = req.params;
  const request = await getRequestForProviderLifecycle(id);
  if (!request) {
    return res.status(404).json({ message: 'Request not found', code: 'RESOURCE_NOT_FOUND' });
  }

  if (request.status === 'CLOSED') {
    const [existingReport, existingInvoice] = await Promise.all([
      requestService.getReportStatus(id),
      invoiceService.getInvoiceByRequestId(id),
    ]);

    return res.json({
      success: true,
      message: 'Request already closed',
      status: 'CLOSED',
      pdf_url: existingReport?.pdf_url || null,
      invoice_id: existingInvoice?.id || null,
      data: {
        invoice_id: existingInvoice?.id || null,
        pdf_url: existingReport?.pdf_url || null,
      },
    });
  }

  if (request.status !== 'COMPLETED') {
    return res.status(400).json({
      message: 'Only COMPLETED requests can be closed',
      code: 'INVALID_STATUS_TRANSITION',
      current_status: request.status,
    });
  }

  if (request.service_type === 'LAB') {
    const labResultsCount = await requestRepo.countLabResultsByRequest(id); // AUDIT-FIX: P3-STEP7B-DIP - close-request lab-result checks now go through the repository.
    if (labResultsCount === 0) {
      return res.status(400).json({
        message: 'Cannot close: no lab results found',
        code: 'REPORT_REQUIRED',
      });
    }
  } else {
    const hasProviderReport = await requestRepo.hasAnyProviderReport(id); // AUDIT-FIX: P3-STEP7B-DIP - close-request provider-report checks now go through the repository.
    if (!hasProviderReport) {
      return res.status(400).json({
        message: 'Cannot close: no provider report found',
        code: 'REPORT_REQUIRED',
      });
    }
  }

  let pdfUrl = null;
  let invoice = null;
  try {
    const transactionResult = await requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-STEP7B-DIP - request-close transaction ownership moves to the repository base.
      const lockedRequest = await getRequestCore(id, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve current request state reads inside the closing transaction.

      if (lockedRequest.service_type === 'MEDICAL' && !lockedRequest.final_report_confirmed_at) {
        let finalReport = await requestRepo.getFinalReportForClose(id, client); // AUDIT-FIX: P3-STEP7B-DIP - close-request final-report reads now go through the repository.
        const preferredProviderId = lockedRequest.lead_provider_id || lockedRequest.assigned_provider_id || null; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve provider-priority semantics for close-request fallback selection.

        if (!finalReport) {
          const sourceReport = await requestRepo.getPreferredSourceReportForClose(id, preferredProviderId, client); // AUDIT-FIX: P3-STEP7B-DIP - close-request source-report fallback reads now go through the repository.
          if (!sourceReport) {
            return {
              errorStatus: 400,
              errorBody: {
                message: 'Final doctor confirmation is required before closing the request',
                code: 'INVALID_STATUS_TRANSITION',
                current_status: request.status,
              },
            }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current close-request final-report validation response.
          }

          const sourceProviderSnapshot = await getProviderSnapshotById(client, sourceReport.provider_id); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve snapshot enrichment for generated close-request final reports.
          finalReport = await requestRepo.cloneReportToFinalReport(sourceReport, lockedRequest.service_type, sourceProviderSnapshot, client); // AUDIT-FIX: P3-STEP7B-DIP - final-report cloning now goes through the repository.
        } else if (finalReport.status === 'DRAFT') {
          finalReport = await requestRepo.submitDraftReport(finalReport.id, { touchSubmittedAt: false }, client); // AUDIT-FIX: P3-STEP7B-DIP - close-request draft final-report submission now goes through the repository.
        }

        if (!finalReport || !['SUBMITTED', 'APPROVED'].includes(finalReport.status)) {
          return {
            errorStatus: 400,
            errorBody: {
              message: 'Final doctor confirmation is required before closing the request',
              code: 'INVALID_STATUS_TRANSITION',
              current_status: request.status,
            },
          }; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve the current close-request final-report status guard.
        }

        await requestRepo.confirmFinalReportOnRequest(id, finalReport.provider_id, client); // AUDIT-FIX: P3-STEP7B-DIP - request final-report confirmation now goes through the repository.
      }

      await requestRepo.markRequestClosedByAdmin(id, req.user.id, req.body.admin_close_notes || null, client); // AUDIT-FIX: P3-STEP7B-DIP - request-close writes now go through the repository.
      await requestRepo.approveProviderReportsForRequest(id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - provider-report approval writes now go through the repository.
      await requestService.ensureMedicalReportRecord(id, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve medical-report upsert side effects during request closure.
      await requestRepo.publishMedicalReportForClose(id, req.user.id, req.body.admin_close_notes || null, pdfUrl, client); // AUDIT-FIX: P3-STEP7B-DIP - medical-report publish writes now go through the repository.

      const approvedPaymentsCount = await requestRepo.countApprovedPaymentRecords(id, client); // AUDIT-FIX: P3-STEP7B-DIP - approved-payment counts now go through the repository.
      let nextInvoice = null; // AUDIT-FIX: P3-STEP7B-SRP - keep invoice response assembly data explicit inside the transaction callback.
      if (approvedPaymentsCount > 0) {
        nextInvoice = await invoiceService.upsertInvoiceForApprovedPayments({
          requestId: id,
          adminId: req.user.id,
          makePatientVisible: true,
        }, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve approved-payment invoice upsert semantics.
      } else {
        const existingInvoice = await invoiceService.getInvoiceByRequestId(id, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve existing invoice reuse semantics during closure.
        if (existingInvoice) {
          nextInvoice = await requestRepo.makeInvoiceVisibleForRequest(id, req.user.id, client); // AUDIT-FIX: P3-STEP7B-DIP - invoice visibility updates now go through the repository.
        } else {
          const billingRequest = await requestRepo.getRequestBillingIdentity(id, client); // AUDIT-FIX: P3-STEP7B-DIP - billing-identity reads now go through the repository.
          nextInvoice = await requestRepo.createPendingInvoiceForRequest( // AUDIT-FIX: P3-STEP7B-DIP - zero-balance invoice creation now goes through the repository.
            id,
            billingRequest?.patient_id || null,
            billingRequest?.guest_name || null,
            req.user.id,
            {
              originalAmount: Number(billingRequest?.service_price_snapshot) || 0,
              couponId: billingRequest?.coupon_id || null,
              couponDiscountAmount: Number(billingRequest?.coupon_discount_amount) || 0,
              couponCodeSnapshot: billingRequest?.coupon_code || null,
            },
            client
          );
        }

        if (nextInvoice?.id) {
          nextInvoice = await syncInvoiceSnapshots(client, nextInvoice.id, id) || nextInvoice; // AUDIT-FIX: P3-STEP7B-COMPAT - preserve invoice snapshot refresh semantics during closure.
        }
      }

      await addLifecycleEvent({
        requestId: id,
        actorId: req.user.id,
        actorRole: req.user.role,
        actorName: req.user.full_name || null,
        eventType: 'REQUEST_CLOSED',
        description: 'Admin closed the request and published the report',
        metadata: {
          invoice_id: nextInvoice?.id || null,
          admin_close_notes: req.body.admin_close_notes || null,
          pdf_url: pdfUrl,
        },
        workflowStageSnapshot: 'PUBLISHED',
      }, client); // AUDIT-FIX: P3-STEP7B-COMPAT - preserve lifecycle logging for request closure.

      return { invoice: nextInvoice }; // AUDIT-FIX: P3-STEP7B-SRP - transaction callback returns only the data needed for the HTTP response.
    });

    if (transactionResult.errorStatus) {
      return res.status(transactionResult.errorStatus).json(transactionResult.errorBody);
    }

    invoice = transactionResult.invoice; // AUDIT-FIX: P3-STEP7B-SRP - keep invoice response data outside the transaction callback for HTTP assembly.
  } catch (err) {
    throw err;
  }

  try {
    pdfUrl = await withTimeout(async () => {
      const pdfBuffer = await generateMedicalReportPdf(id);
      const persistedPdfUrl = await storeGeneratedPdf(pdfBuffer, `medical-report-${id}.pdf`, 'medical-reports');
      if (persistedPdfUrl) {
        await requestRepo.updateMedicalReportPdfUrl(id, persistedPdfUrl);
      }
      return persistedPdfUrl;
    }, CLOSE_REQUEST_PDF_TIMEOUT_MS, `Medical report PDF generation timed out after ${CLOSE_REQUEST_PDF_TIMEOUT_MS}ms`);
  } catch (err) {
    if (pdfUrl) {
      await deleteStoredPdf(pdfUrl).catch(() => {});
    }
    pdfUrl = null;
    logger.error('Medical report PDF generation failed after request closure', {
      requestId: id,
      error: err.message,
      timeoutMs: CLOSE_REQUEST_PDF_TIMEOUT_MS,
    });
  }

  audit('REQUEST_CLOSED', {
    userId: req.user.id,
    role: req.user.role,
    targetId: id,
    targetType: 'request',
    ip: req.ip,
  });

  const responseBody = {
    success: true,
    message: 'Request closed successfully',
    status: 'CLOSED',
    pdf_url: pdfUrl,
    invoice_id: invoice?.id || null,
    data: {
      invoice_id: invoice?.id || null,
      pdf_url: pdfUrl,
    },
  };

  res.json(responseBody);

  void notifService.notifyReportPublished(id, request.patient_id).catch((err) => {
    logger.error('Failed to send report published notification', {
      requestId: id,
      patientId: request.patient_id,
      error: err.message,
    });
  });

  return undefined;
}

async function deleteRequest(req, res) {
  const deletedRequest = await requestService.deleteRequest(req.params.id);
  if (!deletedRequest) {
    return res.status(404).json({ message: 'Request not found', code: 'REQUEST_NOT_FOUND' });
  }

  audit('REQUEST_DELETED', buildControllerAuditPayload(req, req.params.id, 'request'));
  return res.json({
    success: true,
    message: 'Request deleted successfully',
    data: deletedRequest,
  });
}

module.exports = {
  createRequestController,
  createRequest,
  listRequests,
  getRequestById,
  updateRequestStatus,
  assignProvider,
  addLabResult,
  addLabResultsBulk,
  updateLabResult,
  updateGuestDemographics,
  getWorkflowOverview,
  updateWorkflowStage,
  listWorkflowTasks,
  assignWorkflowTask,
  acceptWorkflowTask,
  unacceptWorkflowTask,
  submitWorkflowTask,
  listAdditionalOrders,
  createAdditionalOrder,
  listProviderReports,
  upsertProviderReport,
  uploadProviderReportPdf,
  confirmFinalReport,
  listLifecycleEvents,
  listRequestChatRooms,
  listRequestChatMessages,
  listRequestChatMessagesByRoomId,
  sendRequestChatMessage,
  sendRequestChatMessageByRoomId,
  publishReport,
  getReportStatus,
  uploadRequestFiles,
  rateRequest,
  getProviderRatings,
  getPatientHistory,
  startRequest,
  completeRequest,
  completeWithPayment,
  listPayments,
  recordPayment,
  approvePaymentRecord,
  closeRequest,
  deleteRequest,
};
