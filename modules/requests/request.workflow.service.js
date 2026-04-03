const { AppError } = require('../../middlewares/errorHandler'); // AUDIT-FIX: P3-WF-SRP - workflow validation still uses the shared application error type.
const chatService = require('../chat/chat.service'); // AUDIT-FIX: P3-WF-COMPAT - preserve the existing dependency shape for untouched callers.
const WorkflowRepository = require('../../repositories/WorkflowRepository'); // AUDIT-FIX: P3-WF-DIP - workflow data access now goes through the repository layer.
const {
  getProviderSnapshotById,
  syncRequestProviderSnapshots,
} = require('../../utils/requestSnapshots');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace repeated workflow list bounds and metadata code
let workflowRepo = null; // AUDIT-FIX: P3-STEP8-DIP - workflow service composition is now configured externally instead of requiring config/db here.

const ROOM_TYPES = {
  CARE_TEAM: 'CARE_TEAM',
  PATIENT_CARE: 'PATIENT_CARE',
  DOCTOR_ADMIN: 'DOCTOR_ADMIN',
  PROVIDER_PATIENT: 'PROVIDER_PATIENT',
};

const TASK_STATUSES = {
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

const WORKFLOW_STAGES = WorkflowRepository.WORKFLOW_STAGES; // AUDIT-FIX: P3-WF-SRP - use the repository as the single source of truth for workflow stage names.
const WORKFLOW_ORDER = WorkflowRepository.WORKFLOW_ORDER; // AUDIT-FIX: P3-WF-SRP - use the repository as the single source of truth for workflow ordering.

const LEGACY_CHAT_MEDIA_TYPES = {
  IMAGE: 'image',
  FILE: 'file',
};

function getWorkflowRepo() { // AUDIT-FIX: P3-STEP8-DIP - singleton workflow-repository resolution is centralized for explicit composition.
  if (!workflowRepo) { // AUDIT-FIX: P3-STEP8-DIP - fail fast when routes have not wired the workflow service yet.
    throw new Error('Workflow service has not been configured. Configure it at the composition root first.'); // AUDIT-FIX: P3-STEP8-DIP - make missing composition explicit instead of silently requiring config/db here.
  } // AUDIT-FIX: P3-STEP8-DIP - prevent null repository usage inside workflow helpers.
  return workflowRepo; // AUDIT-FIX: P3-STEP8-DIP - reuse the configured repository singleton for all workflow methods.
} // AUDIT-FIX: P3-STEP8-DIP - workflow repository lookup now lives in one place.

function getWorkflowDb() { // AUDIT-FIX: P3-STEP8-DIP - workflow helper fallbacks now reuse the injected repository executor instead of pool.
  return getWorkflowRepo()._db; // AUDIT-FIX: P3-STEP8-DIP - preserve default DB execution for helpers that still accept optional clients.
} // AUDIT-FIX: P3-STEP8-DIP - injected DB fallback is centralized for legacy helper signatures.

function configureWorkflowService(repository) { // AUDIT-FIX: P3-STEP8-DIP - request routes now inject the concrete workflow repository explicitly.
  workflowRepo = repository; // AUDIT-FIX: P3-STEP8-DIP - persist the externally composed workflow repository singleton.
  return module.exports; // AUDIT-FIX: P3-STEP8-DIP - allow callers to keep using the existing workflow service object after configuration.
} // AUDIT-FIX: P3-STEP8-DIP - workflow service no longer owns its own pool-backed construction.

function normalizeWorkflowStage(value) {
  return String(value || '').trim().toUpperCase();
}

function getNextWorkflowStage(currentStage) {
  return workflowRepo.getNextWorkflowStage(currentStage); // AUDIT-FIX: P3-WF-SRP - stage sequencing now resolves through the repository helper.
}

async function getRequestCore(requestId, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  return workflowRepo.getRequestCore(requestId, db); // AUDIT-FIX: P3-WF-DIP - request-core reads now go through the repository.
}

async function providerHasRequestAccess(requestId, providerId, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  return workflowRepo.providerHasRequestAccess(requestId, providerId, db); // AUDIT-FIX: P3-WF-DIP - provider access checks now go through the repository.
}

async function assertRequestAccess(requestId, user, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  const request = await getRequestCore(requestId, db);
  if (!request) {
    throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
  }

  if (user.role === 'ADMIN') return request;

  if (user.role === 'PATIENT') {
    if (request.patient_id !== user.id) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
    return request;
  }

  if (user.role === 'PROVIDER') {
    const allowed = await providerHasRequestAccess(requestId, user.id, db);
    if (!allowed) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
    return request;
  }

  throw new AppError('Access denied', 403, 'FORBIDDEN');
}

async function addLifecycleEvent({
  requestId,
  actorId = null,
  actorRole = 'SYSTEM',
  actorName = 'System',
  eventType,
  description = null,
  metadata = {},
  workflowStageSnapshot = null,
}, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  await workflowRepo.logLifecycleEvent({ // AUDIT-FIX: P3-WF-DIP - lifecycle event writes now go through the repository.
    requestId, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
    actorId, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
    actorRole, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
    actorName, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
    eventType, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
    description, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
    metadata, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
    workflowStageSnapshot, // AUDIT-FIX: P3-WF-DIP - preserve the existing event payload field.
  }, db); // AUDIT-FIX: P3-WF-DIP - optional transaction clients still flow into lifecycle writes.
}

async function ensureChatRoom(requestId, roomType, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  const nameByType = {
    CARE_TEAM: 'Care Team',
    PATIENT_CARE: 'Patient & Care Team',
    DOCTOR_ADMIN: 'Doctor & Admin',
    PROVIDER_PATIENT: 'Provider & Patient',
  };
  return workflowRepo.upsertRequestChatRoom(requestId, roomType, nameByType[roomType] || roomType, db); // AUDIT-FIX: P3-WF-DIP - request chat room upserts now go through the repository.
}

async function ensureChatParticipant(roomId, participantId, participantRole, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  await workflowRepo.addRequestChatParticipant(roomId, participantId, participantRole, db); // AUDIT-FIX: P3-WF-DIP - request chat participant writes now go through the repository.
}

function isProviderPatientRoomAvailable(request) {
  if (!request?.patient_id) return false;

  const normalizedStatus = String(request.status || '').trim().toUpperCase();
  return Boolean(
    request.in_progress_at
      || ['IN_PROGRESS', 'COMPLETED', 'CLOSED'].includes(normalizedStatus)
  );
}

async function ensureProviderPatientRoomParticipants(request, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  if (!request?.id || !request?.patient_id) return null;

  const room = await ensureChatRoom(request.id, ROOM_TYPES.PROVIDER_PATIENT, db);
  await ensureChatParticipant(room.id, request.patient_id, 'PATIENT', db);

  const providerIds = await workflowRepo.listActiveTaskProviderIds(request.id, db); // AUDIT-FIX: P3-WF-DIP - active task-provider reads now go through the repository.
  for (const providerId of providerIds) {
    await ensureChatParticipant(room.id, providerId, 'PROVIDER', db); // AUDIT-FIX: P3-WF-DIP - participant creation reuses the repository-backed helper.
  }

  return room;
}

async function ensureAccessibleRequestChatRoom(request, roomType, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  if (roomType === ROOM_TYPES.PROVIDER_PATIENT) {
    if (!isProviderPatientRoomAvailable(request)) {
      throw new AppError('Provider-patient chat is not available yet', 409, 'CHAT_ROOM_NOT_AVAILABLE');
    }

    return ensureProviderPatientRoomParticipants(request, db);
  }

  return ensureChatRoom(request.id, roomType, db);
}

async function listWorkflowTasks(requestId, user) {
  await assertRequestAccess(requestId, user);
  return workflowRepo.findTasksByRequest(requestId); // AUDIT-FIX: P3-WF-DIP - task listing now goes through the repository.
}

async function assignWorkflowTask({
  requestId,
  providerId,
  taskType,
  role = 'ASSISTANT',
  notes = null,
  scheduledAt = null,
  actor,
}) {
  return workflowRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-WF-DIP - task assignment transactions now use the repository transaction wrapper.
    const request = await getRequestCore(requestId, client);
    if (!request) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }
    const normalizedTaskType = request.service_type === 'PACKAGE'
      ? 'MEDICAL'
      : String(taskType || '').trim().toUpperCase();
    const normalizedRole = request.service_type === 'PACKAGE'
      ? 'LEAD_DOCTOR'
      : String(role || 'ASSISTANT').trim().toUpperCase();

    const provider = await workflowRepo.findProviderById(providerId, client); // AUDIT-FIX: P3-WF-DIP - provider identity lookup now goes through the repository.
    if (!provider) {
      throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
    }

    if (normalizedRole === 'LEAD_DOCTOR' && provider.type !== 'DOCTOR') {
      throw new AppError('Lead provider must be a doctor', 400, 'INVALID_LEAD_PROVIDER');
    }

    const existingUnassignedTask = await workflowRepo.findUnassignedTaskByRequestAndType( // AUDIT-FIX: P3-WF-DIP - unassigned-task lookup now goes through the repository.
      requestId,
      normalizedTaskType,
      client
    );
    const task = existingUnassignedTask
      ? await workflowRepo.assignExistingTask( // AUDIT-FIX: P3-WF-DIP - placeholder-task assignment now goes through the repository.
        existingUnassignedTask.id,
        { providerId, role: normalizedRole, notes },
        client
      )
      : await workflowRepo.createTask( // AUDIT-FIX: P3-WF-DIP - task creation/upsert now goes through the repository.
        {
          request_id: requestId,
          provider_id: providerId,
          role: normalizedRole,
          status: 'ASSIGNED',
          task_type: normalizedTaskType,
          notes,
        },
        client
      );
    let autoAssignedTasks = [];

    if (request.service_type === 'PACKAGE' && normalizedRole === 'LEAD_DOCTOR' && provider.type === 'DOCTOR') {
      autoAssignedTasks = await workflowRepo.autoAssignPackageTasks(requestId, providerId, task.id, client); // AUDIT-FIX: P3-WF-DIP - package auto-assignment now goes through the repository.
    }

    await workflowRepo.updateRequestAssignment( // AUDIT-FIX: P3-WF-DIP - request assignment side effects now go through the repository.
      requestId,
      {
        providerId,
        serviceType: request.service_type,
        scheduledAt,
        isLeadDoctor: normalizedRole === 'LEAD_DOCTOR',
      },
      client
    );

    await syncRequestProviderSnapshots(client, requestId);

    const careRoom = await ensureChatRoom(requestId, ROOM_TYPES.CARE_TEAM, client);
    await ensureChatParticipant(careRoom.id, providerId, 'PROVIDER', client);
    await ensureChatParticipant(careRoom.id, actor.id, actor.role, client);

    if (request.patient_id && normalizedRole === 'LEAD_DOCTOR') {
      const patientCareRoom = await ensureChatRoom(requestId, ROOM_TYPES.PATIENT_CARE, client);
      await ensureChatParticipant(patientCareRoom.id, request.patient_id, 'PATIENT', client);
      await ensureChatParticipant(patientCareRoom.id, providerId, 'PROVIDER', client);
      await ensureChatParticipant(patientCareRoom.id, actor.id, actor.role, client);

      const doctorAdminRoom = await ensureChatRoom(requestId, ROOM_TYPES.DOCTOR_ADMIN, client);
      await ensureChatParticipant(doctorAdminRoom.id, providerId, 'PROVIDER', client);
      await ensureChatParticipant(doctorAdminRoom.id, actor.id, actor.role, client);
    }

    const updatedRequest = await getRequestCore(requestId, client);
    if (updatedRequest?.patient_id && isProviderPatientRoomAvailable(updatedRequest)) {
      await ensureProviderPatientRoomParticipants(updatedRequest, client);
    }

    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: 'TASK_ASSIGNED',
      description: `Task ${normalizedTaskType} assigned to provider`,
      metadata: {
        task_id: task.id,
        provider_id: providerId,
        provider_type: provider.type,
        role: normalizedRole,
        scheduled_at: scheduledAt,
        auto_assigned_task_ids: autoAssignedTasks.map((row) => row.id),
      },
      workflowStageSnapshot: updatedRequest.workflow_stage,
    }, client);
    return task;
  }); // AUDIT-FIX: P3-WF-DIP - repository transaction wrapper now handles commit/rollback/release.
}

async function acceptWorkflowTask({ requestId, taskId, providerId, notes = null, actor }) {
  return workflowRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-WF-DIP - task acceptance transactions now use the repository transaction wrapper.
    const task = await workflowRepo.findTaskById(taskId, client, { requestId, forUpdate: true, includeRequest: true }); // AUDIT-FIX: P3-WF-DIP - locked task reads now go through the repository.
    if (!task) {
      throw new AppError('Task not found', 404, 'TASK_NOT_FOUND');
    }
    if (task.provider_id !== providerId) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
    if (task.status === TASK_STATUSES.CANCELLED || task.status === TASK_STATUSES.COMPLETED) {
      throw new AppError('Task cannot be accepted in current status', 409, 'TASK_STATE_INVALID');
    }

    const shouldAcceptAllPackageTasks = task.service_type === 'PACKAGE' && task.lead_provider_id === providerId;
    const updatedTaskRows = shouldAcceptAllPackageTasks
      ? await workflowRepo.acceptTasksForPackageProvider(requestId, providerId, notes, client) // AUDIT-FIX: P3-WF-DIP - package acceptance now goes through the repository.
      : await workflowRepo.acceptTask(taskId, requestId, notes, client); // AUDIT-FIX: P3-WF-DIP - single-task acceptance now goes through the repository.

    await workflowRepo._exec( // AUDIT-FIX: P3-WF-DIP - request stage/status updates now execute through the repository executor.
      `
      UPDATE service_requests
      SET workflow_stage = CASE
            WHEN workflow_stage = 'TRIAGE' THEN 'IN_PROGRESS'
            ELSE workflow_stage
          END,
          status = CASE
            WHEN status = 'PENDING'
            THEN 'ASSIGNED'
            ELSE status
          END,
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [requestId],
      client
    );

    const updatedRequest = await getRequestCore(requestId, client);
    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: 'TASK_ACCEPTED',
      description: 'Provider accepted assigned task',
      metadata: {
        task_id: taskId,
        accepted_task_ids: updatedTaskRows.map((row) => row.id),
      },
      workflowStageSnapshot: updatedRequest.workflow_stage,
    }, client);
    return updatedTaskRows.find((row) => row.id === taskId) || updatedTaskRows[0];
  }); // AUDIT-FIX: P3-WF-DIP - repository transaction wrapper now handles commit/rollback/release.
}

async function unacceptWorkflowTask({ requestId, taskId, providerId, notes = null, actor }) {
  return workflowRepo.withTransaction(async (client) => {
    const task = await workflowRepo.findTaskById(taskId, client, { requestId, forUpdate: true, includeRequest: true });
    if (!task) {
      throw new AppError('Task not found', 404, 'TASK_NOT_FOUND');
    }
    if (task.provider_id !== providerId) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
    if (task.status === TASK_STATUSES.CANCELLED || task.status === TASK_STATUSES.SUBMITTED || task.status === TASK_STATUSES.COMPLETED) {
      throw new AppError('Task cannot be returned in current status', 409, 'TASK_STATE_INVALID');
    }

    const request = await workflowRepo.getRequestCore(requestId, client, { forUpdate: true });
    if (!request) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }

    const artifactCounts = await workflowRepo.countProviderActiveArtifacts(requestId, providerId, client);
    const totalArtifacts = Number(artifactCounts?.report_count || 0)
      + Number(artifactCounts?.lab_result_count || 0)
      + Number(artifactCounts?.order_count || 0)
      + Number(artifactCounts?.payment_count || 0);

    if (totalArtifacts > 0) {
      throw new AppError(
        'Provider work already exists on this request. Remove the recorded work before returning it to admin.',
        409,
        'TASK_UNACCEPT_BLOCKED'
      );
    }

    const releasedTaskRows = await workflowRepo.releaseProviderTasks(requestId, providerId, client);
    if (!releasedTaskRows.length) {
      throw new AppError('Task cannot be returned in current status', 409, 'TASK_STATE_INVALID');
    }

    const remainingTasks = await workflowRepo.findTasksByRequest(requestId, client);
    const remainingAssignedTasks = remainingTasks.filter((row) => row.status !== TASK_STATUSES.CANCELLED && row.provider_id);
    const remainingLeadTask = remainingAssignedTasks.find((row) => row.role === 'LEAD_DOCTOR') || null;
    const nextLeadProviderId = remainingLeadTask?.provider_id || null;
    const nextAssignedProviderId = nextLeadProviderId || remainingAssignedTasks[0]?.provider_id || null;
    const hasRemainingAssignments = remainingAssignedTasks.length > 0;

    await workflowRepo._execOne(
      `
      UPDATE service_requests
      SET assigned_provider_id = $2,
          lead_provider_id = $3,
          status = $4::request_status,
          workflow_stage = $5,
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        requestId,
        nextAssignedProviderId,
        nextLeadProviderId,
        hasRemainingAssignments ? (request.status === 'PENDING' ? 'ASSIGNED' : request.status) : 'PENDING',
        hasRemainingAssignments
          ? (normalizeWorkflowStage(request.workflow_stage || WORKFLOW_STAGES.TRIAGE) === WORKFLOW_STAGES.TRIAGE
            ? WORKFLOW_STAGES.IN_PROGRESS
            : request.workflow_stage)
          : WORKFLOW_STAGES.TRIAGE,
      ],
      client
    );

    await syncRequestProviderSnapshots(client, requestId);

    const updatedRequest = await getRequestCore(requestId, client);
    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: 'TASK_UNACCEPTED',
      description: 'Provider returned assigned task to admin',
      metadata: {
        task_id: taskId,
        returned_task_ids: releasedTaskRows.map((row) => row.id),
        notes: notes || null,
      },
      workflowStageSnapshot: updatedRequest.workflow_stage,
    }, client);

    return releasedTaskRows.find((row) => row.id === taskId) || releasedTaskRows[0];
  });
}

async function submitWorkflowTask({
  requestId,
  taskId,
  providerId,
  status = 'SUBMITTED',
  notes = null,
  actor,
}) {
  const normalizedStatus = String(status || 'SUBMITTED').trim().toUpperCase();
  if (!['SUBMITTED', 'COMPLETED'].includes(normalizedStatus)) {
    throw new AppError('status must be SUBMITTED or COMPLETED', 400, 'INVALID_TASK_STATUS');
  }

  return workflowRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-WF-DIP - task submission transactions now use the repository transaction wrapper.
    const task = await workflowRepo.findTaskById(taskId, client, { requestId, forUpdate: true }); // AUDIT-FIX: P3-WF-DIP - locked task reads now go through the repository.
    if (!task) {
      throw new AppError('Task not found', 404, 'TASK_NOT_FOUND');
    }
    if (task.provider_id !== providerId) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
    if (task.status === TASK_STATUSES.CANCELLED) {
      throw new AppError('Cancelled task cannot be submitted', 409, 'TASK_STATE_INVALID');
    }

    const updatedTask = await workflowRepo.markTaskSubmitted(taskId, requestId, normalizedStatus, notes, client); // AUDIT-FIX: P3-WF-DIP - task submission updates now go through the repository.
    const pendingCount = await workflowRepo.countPendingTasks(requestId, client); // AUDIT-FIX: P3-WF-DIP - pending-task counting now goes through the repository.
    const nextStage = pendingCount > 0 ? 'WAITING_SUB_REPORTS' : 'DOCTOR_REVIEW';

    await workflowRepo._exec( // AUDIT-FIX: P3-WF-DIP - request workflow stage updates now execute through the repository executor.
      `
      UPDATE service_requests
      SET workflow_stage = $2,
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [requestId, nextStage],
      client
    );

    const updatedRequest = await getRequestCore(requestId, client);
    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: 'TASK_SUBMITTED',
      description: `Task submitted with status ${normalizedStatus}`,
      metadata: { task_id: taskId, task_status: normalizedStatus },
      workflowStageSnapshot: updatedRequest.workflow_stage,
    }, client);
    return updatedTask; // AUDIT-FIX: P3-WF-COMPAT - preserve the original return value shape for submitted tasks.
  }); // AUDIT-FIX: P3-WF-DIP - repository transaction wrapper now handles commit/rollback/release.
}

function toLegacyMediaType(messageType) {
  return LEGACY_CHAT_MEDIA_TYPES[messageType] || null;
}

async function syncRequestChatToGeneralConversations({
  request,
  roomId,
  roomType,
  sender,
  message,
  db = getWorkflowDb(), // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
}) {
  // Request-scoped rooms stay isolated from the general chat inbox.
  return;
}

async function listAdditionalOrders(requestId, user) {
  await assertRequestAccess(requestId, user);
  return workflowRepo._exec( // AUDIT-FIX: P3-WF-DIP - additional-order listing now executes through the repository executor.
    `
    SELECT
      rao.*,
      sp.full_name AS ordered_by_name
    FROM request_additional_orders rao
    JOIN service_providers sp ON sp.id = rao.ordered_by
    WHERE rao.request_id = $1
    ORDER BY rao.created_at DESC
    `,
    [requestId]
  ); // AUDIT-FIX: P3-WF-DIP - return rows directly from the repository executor.
}

async function createAdditionalOrder({ requestId, actor, payload }) {
  return workflowRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-WF-DIP - additional-order transactions now use the repository transaction wrapper.
    const request = await getRequestCore(requestId, client);
    if (!request) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }

    let orderedByProviderId = actor.id;

    if (actor.role === 'PROVIDER') {
      const provider = await workflowRepo.findProviderById(actor.id, client); // AUDIT-FIX: P3-WF-DIP - provider lookups now go through the repository.
      if (!provider) {
        throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
      }
      if (provider.type !== 'DOCTOR') {
        throw new AppError('Only doctors can place additional orders', 403, 'FORBIDDEN');
      }
      if (request.lead_provider_id && request.lead_provider_id !== actor.id) {
        throw new AppError('Only lead doctor can place additional orders', 403, 'FORBIDDEN');
      }
      if (!request.lead_provider_id && request.assigned_provider_id && request.assigned_provider_id !== actor.id) {
        throw new AppError('Only assigned doctor can place additional orders', 403, 'FORBIDDEN');
      }
    } else if (actor.role !== 'ADMIN') {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    } else {
      orderedByProviderId = payload.ordered_by_provider_id
        || request.lead_provider_id
        || request.assigned_provider_id
        || null;

      if (!orderedByProviderId) {
        throw new AppError(
          'Admin must provide ordered_by_provider_id when no lead/assigned provider exists',
          400,
          'ORDERED_BY_PROVIDER_REQUIRED'
        );
      }

      if (!await workflowRepo.findProviderById(orderedByProviderId, client)) { // AUDIT-FIX: P3-WF-DIP - admin-selected provider validation now goes through the repository.
        throw new AppError('ordered_by_provider_id is invalid', 400, 'INVALID_PROVIDER');
      }
    }

    const normalizedOrderType = String(payload.order_type || '').trim().toUpperCase();
    const orderResult = await client.query(
      `
      INSERT INTO request_additional_orders (
        request_id, ordered_by, order_type, service_id, lab_test_id,
        description, priority, status, additional_cost, notes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9)
      RETURNING *
      `,
      [
        requestId,
        orderedByProviderId,
        normalizedOrderType,
        payload.service_id || null,
        payload.lab_test_id || null,
        payload.description,
        payload.priority || 'NORMAL',
        payload.additional_cost || 0,
        payload.notes || null,
      ]
    );

    const order = orderResult.rows[0];
    let invoice = null;

    if (Number(order.additional_cost) > 0) {
      const invoiceResult = await client.query(
        `
        SELECT id, payment_status, total_paid, final_amount, remaining_amount
        FROM invoices
        WHERE request_id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [requestId]
      );
      invoice = invoiceResult.rows[0];
      if (!invoice) {
        throw new AppError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
      }
      if (invoice.payment_status === 'PAID') {
        throw new AppError('Cannot add billed order to a fully paid invoice', 409, 'INVOICE_ALREADY_PAID');
      }

      const updatedInvoiceResult = await client.query(
        `
        UPDATE invoices
        SET additional_orders_total = COALESCE(additional_orders_total, 0) + $2,
            final_amount = final_amount + $2,
            remaining_amount = COALESCE(remaining_amount, final_amount - COALESCE(total_paid, 0)) + $2,
            payment_status = 'PENDING',
            payment_status_detail = CASE
              WHEN COALESCE(total_paid, 0) > 0 THEN 'PARTIAL'
              ELSE 'UNPAID'
            END,
            updated_at = NOW()
        WHERE request_id = $1
        RETURNING *
        `,
        [requestId, order.additional_cost]
      );

      invoice = updatedInvoiceResult.rows[0];
    }

    await client.query(
      `
      UPDATE service_requests
      SET workflow_stage = 'WAITING_SUB_REPORTS',
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [requestId]
    );

    const updatedRequest = await getRequestCore(requestId, client);
    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: 'ORDER_ADDED',
      description: `Additional ${normalizedOrderType} order created`,
      metadata: {
        order_id: order.id,
        additional_cost: order.additional_cost,
      },
      workflowStageSnapshot: updatedRequest.workflow_stage,
    }, client);
    return { order, invoice };
  }); // AUDIT-FIX: P3-WF-DIP - repository transaction wrapper now handles commit/rollback/release.
}

async function ensureProviderCanReport(requestId, providerId, reportType, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  const request = await getRequestCore(requestId, db);
  if (!request) throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');

  const hasAccess = await providerHasRequestAccess(requestId, providerId, db);
  if (!hasAccess) throw new AppError('Access denied', 403, 'FORBIDDEN');

  if (reportType === 'FINAL_REPORT') {
    if (request.lead_provider_id && request.lead_provider_id !== providerId) {
      throw new AppError('Only lead doctor can submit final report', 403, 'FORBIDDEN');
    }
  }

  return request;
}

function buildProviderReportPayload(payload, requestServiceType, providerType) {
  const normalizedProviderType = String(providerType || '').trim().toUpperCase();
  const isFinalReport = String(payload.report_type || '').trim().toUpperCase() === 'FINAL_REPORT'; // FIX: BUG-2/BUG-3 — final reports must preserve package section fields regardless of provider specialty.
  const commonFields = {
    serviceType: requestServiceType || null,
    symptomsSummary: payload.symptoms_summary || null,
    proceduresPerformed: payload.procedures_done || payload.procedures_performed || null,
    allergiesNoted: payload.allergies_noted || payload.patient_allergies || null,
    findings: payload.findings || null,
    diagnosis: payload.diagnosis || null,
    recommendations: payload.recommendations || null,
    treatmentPlan: payload.treatment_plan || null,
    notes: payload.notes || null,
    labNotes: null,
    imagingNotes: null,
    imageUrl: null,
    pdfReportUrl: payload.pdf_report_url || null,
    proceduresDone: payload.procedures_done || null,
    patientAllergies: payload.patient_allergies || null,
    nurseNotes: payload.nurse_notes || null,
  };

  if (normalizedProviderType === 'LAB_TECH' || isFinalReport) {
    commonFields.labNotes = payload.lab_notes || null;
  }

  if (normalizedProviderType === 'RADIOLOGY_TECH' || isFinalReport) {
    commonFields.imagingNotes = payload.imaging_notes || null;
    commonFields.imageUrl = payload.image_url || null;
  }

  if (normalizedProviderType === 'NURSE') {
    commonFields.proceduresPerformed = payload.procedures_done || payload.procedures_performed || null;
    commonFields.allergiesNoted = payload.patient_allergies || payload.allergies_noted || null;
    commonFields.proceduresDone = payload.procedures_done || null;
    commonFields.patientAllergies = payload.patient_allergies || null;
    commonFields.nurseNotes = payload.nurse_notes || null;
  }

  return commonFields;
}

async function syncTaskSubmissionFromReport({
  client,
  requestId,
  taskId,
  providerId,
  actorRole,
}) {
  if (!taskId) {
    return null;
  }

  const taskResult = await client.query(
    `
    SELECT *
    FROM request_workflow_tasks
    WHERE id = $1 AND request_id = $2
    LIMIT 1
    FOR UPDATE
    `,
    [taskId, requestId]
  );
  const task = taskResult.rows[0];
  if (!task) {
    throw new AppError('Task not found', 404, 'TASK_NOT_FOUND');
  }
  if (actorRole !== 'ADMIN' && task.provider_id !== providerId) {
    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }
  if (task.status === TASK_STATUSES.CANCELLED) {
    throw new AppError('Cancelled task cannot be submitted', 409, 'TASK_STATE_INVALID');
  }

  if (!['SUBMITTED', 'COMPLETED'].includes(task.status)) {
    await client.query(
      `
      UPDATE request_workflow_tasks
      SET status = 'SUBMITTED',
          submitted_at = COALESCE(submitted_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
      `,
      [taskId]
    );
  }

  const pendingCountResult = await client.query(
    `
    SELECT COUNT(*)::int AS pending_count
    FROM request_workflow_tasks
    WHERE request_id = $1
      AND status NOT IN ('SUBMITTED', 'COMPLETED', 'CANCELLED')
    `,
    [requestId]
  );

  const pendingCount = pendingCountResult.rows[0]?.pending_count || 0;
  return pendingCount > 0 ? WORKFLOW_STAGES.WAITING_SUB_REPORTS : WORKFLOW_STAGES.DOCTOR_REVIEW;
}

async function completeUnassignedPackageTask({
  client,
  requestId,
  taskType,
}) {
  const updateResult = await client.query(
    `
    UPDATE request_workflow_tasks
    SET status = 'COMPLETED',
        submitted_at = COALESCE(submitted_at, NOW()),
        completed_at = COALESCE(completed_at, NOW()),
        updated_at = NOW()
    WHERE request_id = $1
      AND task_type = $2
      AND provider_id IS NULL
      AND status NOT IN ('COMPLETED', 'CANCELLED')
    RETURNING id
    `,
    [requestId, taskType]
  );

  return updateResult.rows;
}

async function completeOwnedPackageTasks({
  client,
  requestId,
  providerId,
}) {
  const updateResult = await client.query(
    `
    UPDATE request_workflow_tasks
    SET status = 'COMPLETED',
        submitted_at = COALESCE(submitted_at, NOW()),
        completed_at = COALESCE(completed_at, NOW()),
        updated_at = NOW()
    WHERE request_id = $1
      AND provider_id = $2
      AND status NOT IN ('COMPLETED', 'CANCELLED')
    RETURNING id
    `,
    [requestId, providerId]
  );

  return updateResult.rows;
}

async function upsertProviderReport({ requestId, actor, payload }) {
  const reportType = String(payload.report_type || '').trim().toUpperCase();
  if (!['SUB_REPORT', 'FINAL_REPORT'].includes(reportType)) {
    throw new AppError('Invalid report_type', 400, 'INVALID_REPORT_TYPE');
  }

  let providerId = actor.id;
  if (actor.role === 'ADMIN' && payload.provider_id) {
    providerId = payload.provider_id;
  }
  if (actor.role !== 'ADMIN' && actor.role !== 'PROVIDER') {
    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }

  return workflowRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-WF-DIP - provider-report upserts now use the repository transaction wrapper.
    const request = await ensureProviderCanReport(requestId, providerId, reportType, client);
    const provider = await workflowRepo.findProviderById(providerId, client); // AUDIT-FIX: P3-WF-DIP - provider lookups now go through the repository.
    if (!provider) {
      throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
    }
    const providerSnapshot = await getProviderSnapshotById(client, providerId);

    const reportPayload = buildProviderReportPayload(payload, request.service_type, provider.type);

    const latestResult = await client.query(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
        AND provider_id = $2
        AND report_type = $3
      ORDER BY version DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, providerId, reportType]
    );
    const latest = latestResult.rows[0] || null;

    const desiredStatus = payload.status ? String(payload.status).trim().toUpperCase() : null;
    if (desiredStatus && !['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'].includes(desiredStatus)) {
      throw new AppError('Invalid report status', 400, 'INVALID_REPORT_STATUS');
    }

    let row;
    if (latest && latest.status !== 'APPROVED') {
      const updateResult = await client.query(
        `
        UPDATE request_provider_reports
        SET status = COALESCE($1, status),
            service_type = COALESCE($2, service_type),
            symptoms_summary = COALESCE($3, symptoms_summary),
            procedures_performed = COALESCE($4, procedures_performed),
            allergies_noted = COALESCE($5, allergies_noted),
            findings = COALESCE($6, findings),
            diagnosis = COALESCE($7, diagnosis),
            recommendations = COALESCE($8, recommendations),
            treatment_plan = COALESCE($9, treatment_plan),
            notes = COALESCE($10, notes),
            lab_notes = COALESCE($11, lab_notes),
            imaging_notes = COALESCE($12, imaging_notes),
            image_url = COALESCE($13, image_url),
            pdf_report_url = COALESCE($14, pdf_report_url),
            procedures_done = COALESCE($15, procedures_done),
            patient_allergies = COALESCE($16, patient_allergies),
            nurse_notes = COALESCE($17, nurse_notes),
            provider_name_snapshot = COALESCE(provider_name_snapshot, $18),
            provider_phone_snapshot = COALESCE(provider_phone_snapshot, $19),
            provider_type_snapshot = COALESCE(provider_type_snapshot, $20),
            updated_at = NOW()
        WHERE id = $21
        RETURNING *
        `,
        [
          desiredStatus,
          reportPayload.serviceType,
          reportPayload.symptomsSummary,
          reportPayload.proceduresPerformed,
          reportPayload.allergiesNoted,
          reportPayload.findings,
          reportPayload.diagnosis,
          reportPayload.recommendations,
          reportPayload.treatmentPlan,
          reportPayload.notes,
          reportPayload.labNotes,
          reportPayload.imagingNotes,
          reportPayload.imageUrl,
          reportPayload.pdfReportUrl,
          reportPayload.proceduresDone,
          reportPayload.patientAllergies,
          reportPayload.nurseNotes,
          providerSnapshot.full_name || provider.full_name || null,
          providerSnapshot.phone || provider.phone || null,
          providerSnapshot.type || provider.type || null,
          latest.id,
        ]
      );
      row = updateResult.rows[0];
    } else {
      const version = latest ? latest.version + 1 : 1;
      const insertResult = await client.query(
        `
        INSERT INTO request_provider_reports (
          request_id, provider_id, task_id, report_type, status,
          symptoms_summary, procedures_performed, allergies_noted,
          findings, diagnosis, recommendations, treatment_plan, notes,
          service_type, lab_notes, imaging_notes, image_url, pdf_report_url,
          procedures_done, patient_allergies, nurse_notes, version,
          provider_name_snapshot, provider_phone_snapshot, provider_type_snapshot
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        RETURNING *
        `,
        [
          requestId,
          providerId,
          payload.task_id || null,
          reportType,
          desiredStatus || 'DRAFT',
          reportPayload.symptomsSummary,
          reportPayload.proceduresPerformed,
          reportPayload.allergiesNoted,
          reportPayload.findings,
          reportPayload.diagnosis,
          reportPayload.recommendations,
          reportPayload.treatmentPlan,
          reportPayload.notes,
          reportPayload.serviceType,
          reportPayload.labNotes,
          reportPayload.imagingNotes,
          reportPayload.imageUrl,
          reportPayload.pdfReportUrl,
          reportPayload.proceduresDone,
          reportPayload.patientAllergies,
          reportPayload.nurseNotes,
          version,
          providerSnapshot.full_name || provider.full_name || null,
          providerSnapshot.phone || provider.phone || null,
          providerSnapshot.type || provider.type || null,
        ]
      );
      row = insertResult.rows[0];
    }

    let nextWorkflowStage = null;
    let autoCompletedOwnedTasks = [];
    let autoCompletedImagingTasks = [];
    if (
      reportType === 'FINAL_REPORT'
      && row.status === 'SUBMITTED'
      && request.service_type === 'PACKAGE'
      && request.lead_provider_id === providerId
    ) {
      autoCompletedOwnedTasks = await completeOwnedPackageTasks({
        client,
        requestId,
        providerId,
      });
    }

    if (
      reportType === 'FINAL_REPORT'
      && row.status === 'SUBMITTED'
      && request.service_type === 'PACKAGE'
      && (reportPayload.imageUrl || reportPayload.pdfReportUrl)
    ) {
      autoCompletedImagingTasks = await completeUnassignedPackageTask({
        client,
        requestId,
        taskType: 'RADIOLOGY',
      });
    }

    if (row.status === 'SUBMITTED' && row.task_id) {
      nextWorkflowStage = await syncTaskSubmissionFromReport({
        client,
        requestId,
        taskId: row.task_id,
        providerId,
        actorRole: actor.role,
      });
    } else if (row.status === 'SUBMITTED' && reportType === 'FINAL_REPORT') {
      nextWorkflowStage = WORKFLOW_STAGES.DOCTOR_REVIEW;
    } else if (row.status === 'SUBMITTED') {
      nextWorkflowStage = WORKFLOW_STAGES.WAITING_SUB_REPORTS;
    }

    await client.query(
      `
      UPDATE service_requests
      SET workflow_stage = COALESCE($2, workflow_stage),
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [requestId, nextWorkflowStage]
    );

    const updatedRequest = await getRequestCore(requestId, client);
    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: reportType === 'FINAL_REPORT' ? 'FINAL_REPORT_UPSERTED' : 'SUB_REPORT_UPSERTED',
      description: `${reportType} saved as ${row.status}`,
      metadata: {
        provider_id: providerId,
        report_id: row.id,
        version: row.version,
        auto_completed_task_ids: [...autoCompletedOwnedTasks, ...autoCompletedImagingTasks].map((task) => task.id),
      },
      workflowStageSnapshot: updatedRequest.workflow_stage,
    }, client);
    return row;
  }); // AUDIT-FIX: P3-WF-DIP - repository transaction wrapper now handles commit/rollback/release.
}

async function listProviderReports(requestId, user) {
  await assertRequestAccess(requestId, user);

  let where = 'WHERE rpr.request_id = $1';
  const params = [requestId];
  if (user.role === 'PATIENT') {
    where += " AND rpr.report_type = 'FINAL_REPORT' AND rpr.status = 'APPROVED'";
  }

  return workflowRepo._exec( // AUDIT-FIX: P3-WF-DIP - provider report listing now executes through the repository executor.
    `
    SELECT
      rpr.*,
      COALESCE(rpr.provider_name_snapshot, sp.full_name) AS provider_name,
      COALESCE(rpr.provider_phone_snapshot, sp.phone) AS provider_phone,
      COALESCE(rpr.provider_type_snapshot, sp.type::text) AS provider_type
    FROM request_provider_reports rpr
    LEFT JOIN service_providers sp ON sp.id = rpr.provider_id
    ${where}
    ORDER BY rpr.report_type DESC, rpr.version DESC, rpr.updated_at DESC
    `,
    params
  ); // AUDIT-FIX: P3-WF-DIP - return rows directly from the repository executor.
}

async function confirmFinalReport({ requestId, providerId, notes = null, actor }) {
  return workflowRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-WF-DIP - final-report confirmation now uses the repository transaction wrapper.
    const request = await getRequestCore(requestId, client);
    if (!request) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }
    if (request.lead_provider_id && request.lead_provider_id !== providerId) {
      throw new AppError('Only lead doctor can confirm final report', 403, 'FORBIDDEN');
    }

    const latestResult = await client.query(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
        AND provider_id = $2
        AND report_type = 'FINAL_REPORT'
      ORDER BY version DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, providerId]
    );
    const latest = latestResult.rows[0];
    if (!latest) {
      throw new AppError('Final report not found', 404, 'FINAL_REPORT_NOT_FOUND');
    }

    const reportResult = await client.query(
      `
      UPDATE request_provider_reports
      SET status = 'APPROVED',
          reviewed_by = $2,
          reviewed_at = NOW(),
          notes = COALESCE($3, notes),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [latest.id, providerId, notes]
    );
    const report = reportResult.rows[0];

    await client.query(
      `
      UPDATE service_requests
      SET final_report_confirmed_by = $2,
          final_report_confirmed_at = NOW(),
          workflow_stage = 'COMPLETED',
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [requestId, providerId]
    );

    const updatedRequest = await getRequestCore(requestId, client);
    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: 'FINAL_REPORT_CONFIRMED',
      description: 'Lead doctor confirmed final report',
      metadata: {
        report_id: report.id,
        version: report.version,
      },
      workflowStageSnapshot: updatedRequest.workflow_stage,
    }, client);
    return report;
  }); // AUDIT-FIX: P3-WF-DIP - repository transaction wrapper now handles commit/rollback/release.
}

async function listLifecycleEvents(requestId, user, { page = 1, limit = 20 }) {
  await assertRequestAccess(requestId, user);

  const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — shared helper now normalizes lifecycle-event pagination

  const [countRow, dataRows] = await Promise.all([
    workflowRepo._execOne( // AUDIT-FIX: P3-WF-DIP - lifecycle-event count now runs through the repository executor.
      `
      SELECT COUNT(*)::int AS total
      FROM request_lifecycle_events
      WHERE request_id = $1
      `,
      [requestId]
    ),
    workflowRepo._exec( // AUDIT-FIX: P3-WF-DIP - lifecycle-event list now runs through the repository executor.
      `
      SELECT *
      FROM request_lifecycle_events
      WHERE request_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [requestId, safeLimit, offset]
    ),
  ]);

  return {
    data: dataRows,
    pagination: paginationMeta(countRow?.total || 0, safePage, safeLimit), // AUDIT-FIX: DRY — standardized list response shape for lifecycle-event listings
  };
}

async function getWorkflowOverview(requestId, user) {
  const request = await assertRequestAccess(requestId, user);
  const [tasks, orders, reports] = await Promise.all([
    listWorkflowTasks(requestId, user),
    listAdditionalOrders(requestId, user),
    listProviderReports(requestId, user),
  ]);

  return {
    request,
    tasks,
    orders,
    reports,
    summary: {
      total_tasks: tasks.length,
      submitted_tasks: tasks.filter((task) => ['SUBMITTED', 'COMPLETED'].includes(task.status)).length,
      total_orders: orders.length,
      pending_orders: orders.filter((order) => order.status === 'PENDING').length,
      reports_count: reports.length,
      final_report_confirmed: Boolean(request.final_report_confirmed_at),
    },
  };
}

async function updateWorkflowStage({
  requestId,
  targetStage = null,
  notes = null,
  actor,
}) {
  const normalizedTargetStage = targetStage ? normalizeWorkflowStage(targetStage) : null;
  if (normalizedTargetStage && !WORKFLOW_ORDER.includes(normalizedTargetStage)) {
    throw new AppError('Invalid workflow stage', 400, 'INVALID_WORKFLOW_STAGE');
  }

  return workflowRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-WF-DIP - workflow-stage updates now use the repository transaction wrapper.
    const request = await workflowRepo.getRequestCore(requestId, client, { forUpdate: true }); // AUDIT-FIX: P3-WF-DIP - locked request reads now go through the repository.
    if (!request) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }

    const currentStage = normalizeWorkflowStage(request.workflow_stage || WORKFLOW_STAGES.TRIAGE);
    const nextStage = getNextWorkflowStage(currentStage);
    if (!nextStage) {
      throw new AppError('Request is already at the final stage', 409, 'WORKFLOW_STAGE_FINAL');
    }

    const desiredStage = normalizedTargetStage || nextStage;
    workflowRepo.validateTransition(currentStage, desiredStage); // AUDIT-FIX: P3-WF-SRP - stage transitions are now validated by the repository state machine.

    if (currentStage === WORKFLOW_STAGES.TRIAGE && desiredStage === WORKFLOW_STAGES.IN_PROGRESS) {
      const taskCount = await workflowRepo.countAssignedActiveTasks(requestId, client); // AUDIT-FIX: P3-WF-DIP - active-task counts now go through the repository.
      if (taskCount < 1) {
        throw new AppError('Assign at least one team member first', 409, 'WORKFLOW_STAGE_CONDITION_FAILED');
      }
    }

    if (currentStage === WORKFLOW_STAGES.WAITING_SUB_REPORTS && desiredStage === WORKFLOW_STAGES.DOCTOR_REVIEW) {
      const pendingCount = await workflowRepo.countPendingTasks(requestId, client); // AUDIT-FIX: P3-WF-DIP - pending-task counts now go through the repository.
      if (pendingCount > 0) {
        throw new AppError('All tasks must be submitted first', 409, 'WORKFLOW_STAGE_CONDITION_FAILED');
      }
    }

    if (currentStage === WORKFLOW_STAGES.DOCTOR_REVIEW && desiredStage === WORKFLOW_STAGES.COMPLETED) {
      if (!request.final_report_confirmed_at) {
        throw new AppError('Final report must be confirmed first', 409, 'WORKFLOW_STAGE_CONDITION_FAILED');
      }
    }

    const statusAssignment = desiredStage === WORKFLOW_STAGES.COMPLETED ? 'COMPLETED' : null;
    const updatedRequestResult = await client.query(
      `
      UPDATE service_requests
      SET workflow_stage = $2,
          workflow_updated_at = NOW(),
          status = COALESCE($3::request_status, status),
          completed_at = CASE
            WHEN $2 = 'COMPLETED' THEN COALESCE(completed_at, NOW())
            ELSE completed_at
          END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [requestId, desiredStage, statusAssignment]
    );

    const updatedRequest = updatedRequestResult.rows[0];
    await addLifecycleEvent({
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name || null,
      eventType: 'WORKFLOW_STAGE_CHANGED',
      description: `Workflow stage changed from ${currentStage} to ${desiredStage}`,
      metadata: {
        from_stage: currentStage,
        to_stage: desiredStage,
        notes: notes || null,
      },
      workflowStageSnapshot: desiredStage,
    }, client);
    return updatedRequest;
  }); // AUDIT-FIX: P3-WF-DIP - repository transaction wrapper now handles commit/rollback/release.
}

async function listRequestChatRooms(requestId, user) {
  const request = await assertRequestAccess(requestId, user);

  if (user.role === 'PROVIDER') {
    const allowed = await providerHasRequestAccess(requestId, user.id);
    if (!allowed) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
  }

  const shouldExposeDoctorRooms = user.role === 'ADMIN'
    || (user.role === 'PROVIDER' && (!request.lead_provider_id || request.lead_provider_id === user.id));

  const allowedTypes = [ROOM_TYPES.CARE_TEAM];
  if (user.role === 'PATIENT') {
    const rooms = [await ensureChatRoom(requestId, ROOM_TYPES.PATIENT_CARE)];
    if (isProviderPatientRoomAvailable(request)) {
      rooms.push(await ensureProviderPatientRoomParticipants(request));
    }

    return {
      data: rooms,
    };
  }

  if (shouldExposeDoctorRooms) {
    allowedTypes.push(ROOM_TYPES.PATIENT_CARE, ROOM_TYPES.DOCTOR_ADMIN);
  }
  allowedTypes.push(ROOM_TYPES.PROVIDER_PATIENT);

  const rooms = [];
  for (const roomType of allowedTypes) {
    if (roomType === ROOM_TYPES.PROVIDER_PATIENT && !isProviderPatientRoomAvailable(request)) {
      continue;
    }

    const room = await ensureAccessibleRequestChatRoom(request, roomType);
    rooms.push(room);
  }

  return { data: rooms };
}

function canAccessRoom(request, user, roomType, providerHasAccess) {
  if (user.role === 'ADMIN') return true;

  if (user.role === 'PATIENT') {
    return request.patient_id === user.id
      && (roomType === ROOM_TYPES.PATIENT_CARE || roomType === ROOM_TYPES.PROVIDER_PATIENT);
  }

  if (user.role === 'PROVIDER') {
    if (!providerHasAccess) return false;
    if (roomType === ROOM_TYPES.CARE_TEAM) return true;
    if (roomType === ROOM_TYPES.PROVIDER_PATIENT) return true;
    if (roomType === ROOM_TYPES.PATIENT_CARE) {
      return !request.lead_provider_id || request.lead_provider_id === user.id;
    }
    if (roomType === ROOM_TYPES.DOCTOR_ADMIN) {
      return !request.lead_provider_id || request.lead_provider_id === user.id;
    }
  }

  return false;
}

async function assertChatRoomAccess(requestId, roomType, user, db = getWorkflowDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected workflow DB instead of config/db.
  const request = await getRequestCore(requestId, db);
  if (!request) throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');

  let providerAccess = false;
  if (user.role === 'PROVIDER') {
    providerAccess = await providerHasRequestAccess(requestId, user.id, db);
  }

  const allowed = canAccessRoom(request, user, roomType, providerAccess);
  if (!allowed) {
    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }

  return request;
}

async function listRequestChatMessages(requestId, roomType, user, { page = 1, limit = 30 }) {
  const normalizedRoomType = String(roomType || '').trim().toUpperCase();
  if (!Object.values(ROOM_TYPES).includes(normalizedRoomType)) {
    throw new AppError('Invalid room type', 400, 'INVALID_ROOM_TYPE');
  }

  const request = await assertChatRoomAccess(requestId, normalizedRoomType, user);
  const room = await ensureAccessibleRequestChatRoom(request, normalizedRoomType);
  if (!(user.role === 'ADMIN' && normalizedRoomType === ROOM_TYPES.PROVIDER_PATIENT)) {
    await ensureChatParticipant(room.id, user.id, user.role);
  }

  const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }, { defaultLimit: 30 }); // AUDIT-FIX: DRY — shared helper now normalizes request-chat pagination

  const [countRow, listRows] = await Promise.all([
    workflowRepo._execOne( // AUDIT-FIX: P3-WF-DIP - request chat message counts now run through the repository executor.
      `
      SELECT COUNT(*)::int AS total
      FROM request_chat_messages
      WHERE room_id = $1
      `,
      [room.id]
    ),
    workflowRepo._exec( // AUDIT-FIX: P3-WF-DIP - request chat message listing now runs through the repository executor.
      `
      SELECT *
      FROM request_chat_messages
      WHERE room_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [room.id, safeLimit, offset]
    ),
  ]);

  return {
    room,
    data: listRows.reverse(),
    pagination: paginationMeta(countRow?.total || 0, safePage, safeLimit), // AUDIT-FIX: DRY — standardized list response shape for request-chat listings
  };
}

async function sendRequestChatMessage({
  requestId,
  roomType,
  user,
  body = null,
  fileUrl = null,
  fileName = null,
  fileSize = null,
  messageType = 'TEXT',
}) {
  const normalizedRoomType = String(roomType || '').trim().toUpperCase();
  if (!Object.values(ROOM_TYPES).includes(normalizedRoomType)) {
    throw new AppError('Invalid room type', 400, 'INVALID_ROOM_TYPE');
  }
  if (normalizedRoomType === ROOM_TYPES.PROVIDER_PATIENT && user.role === 'ADMIN') {
    throw new AppError('Admin cannot send messages in provider-patient chat', 403, 'ADMIN_READ_ONLY');
  }

  const content = body ? String(body).trim() : '';
  if (!content && !fileUrl) {
    throw new AppError('Message body or file is required', 400, 'EMPTY_MESSAGE');
  }

  const request = await assertChatRoomAccess(requestId, normalizedRoomType, user);
  if (request.status === 'CLOSED') {
    throw new AppError('Chat is closed for this request', 403);
  }
  const room = await ensureAccessibleRequestChatRoom(request, normalizedRoomType);
  await ensureChatParticipant(room.id, user.id, user.role);

  const finalType = fileUrl ? (messageType || 'FILE') : 'TEXT';
  const message = await workflowRepo._execOne( // AUDIT-FIX: P3-WF-DIP - request chat message writes now go through the repository executor.
    `
    INSERT INTO request_chat_messages (
      room_id, sender_id, sender_role, sender_name, message_type,
      content, file_url, file_name, file_size
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
    `,
    [
      room.id,
      user.id,
      user.role,
      user.full_name || null,
      finalType,
      content || null,
      fileUrl,
      fileName,
      fileSize,
    ]
  ); // AUDIT-FIX: P3-WF-DIP - return the inserted message row directly from the repository executor.

  await syncRequestChatToGeneralConversations({
    request,
    roomId: room.id,
    roomType: normalizedRoomType,
    sender: {
      id: user.id,
      role: user.role,
    },
    message,
    db: getWorkflowDb(), // AUDIT-FIX: P3-STEP8-DIP - general-chat sync fallback now reuses the injected workflow DB instead of pool.
  });

  await addLifecycleEvent({
    requestId,
    actorId: user.id,
    actorRole: user.role,
    actorName: user.full_name || null,
    eventType: 'REQUEST_CHAT_MESSAGE_SENT',
    description: `Message sent in ${normalizedRoomType}`,
    metadata: {
      room_type: normalizedRoomType,
      message_id: message.id,
      has_file: Boolean(fileUrl),
    },
    workflowStageSnapshot: request?.workflow_stage || null,
  });

  return message;
}

function createWorkflowService() { // AUDIT-FIX: P3-WF-COMPAT - expose the workflow service through the same factory pattern as the other refactored modules.
  return { // AUDIT-FIX: P3-WF-COMPAT - preserve the existing exported API surface for current callers.
    ROOM_TYPES, // AUDIT-FIX: P3-WF-COMPAT - keep room-type constants on the default export.
    WORKFLOW_STAGES, // AUDIT-FIX: P3-WF-COMPAT - keep workflow-stage constants on the default export.
    WORKFLOW_ORDER, // AUDIT-FIX: P3-WF-COMPAT - keep workflow-order constants on the default export.
    getRequestCore, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    assertRequestAccess, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    providerHasRequestAccess, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    addLifecycleEvent, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    ensureProviderPatientRoomParticipants, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    listWorkflowTasks, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    assignWorkflowTask, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    acceptWorkflowTask, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    unacceptWorkflowTask, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    submitWorkflowTask, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    listAdditionalOrders, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    createAdditionalOrder, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    upsertProviderReport, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    listProviderReports, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    confirmFinalReport, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    listLifecycleEvents, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    getWorkflowOverview, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    updateWorkflowStage, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    listRequestChatRooms, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    listRequestChatMessages, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
    sendRequestChatMessage, // AUDIT-FIX: P3-WF-COMPAT - preserve the existing method export.
  }; // AUDIT-FIX: P3-WF-COMPAT - keep the default service shape unchanged for existing consumers.
} // AUDIT-FIX: P3-WF-COMPAT - workflow service factory now matches the repository-layer module pattern.

class WorkflowService { // AUDIT-FIX: P3-WF-COMPAT - expose a class constructor for callers that expect class-style composition.
  constructor() { // AUDIT-FIX: P3-WF-COMPAT - instantiate by copying the existing workflow service API onto `this`.
    Object.assign(this, createWorkflowService()); // AUDIT-FIX: P3-WF-COMPAT - preserve method names and behavior on constructed instances.
  } // AUDIT-FIX: P3-WF-COMPAT - constructor keeps the instance API aligned with the default export.
} // AUDIT-FIX: P3-WF-COMPAT - class wrapper preserves backward-compatible construction semantics.

module.exports = createWorkflowService(); // AUDIT-FIX: P3-STEP8-COMPAT - default export stays a ready-to-use singleton service object without requiring config/db here.
module.exports.createWorkflowService = createWorkflowService; // AUDIT-FIX: P3-WF-COMPAT - preserve factory export for explicit composition.
module.exports.configureWorkflowService = configureWorkflowService; // AUDIT-FIX: P3-STEP8-DIP - expose explicit singleton wiring for route-level composition roots.
module.exports.WorkflowService = WorkflowService; // AUDIT-FIX: P3-WF-COMPAT - preserve class export for class-oriented callers.
