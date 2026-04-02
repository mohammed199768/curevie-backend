const BaseRepository = require('./BaseRepository'); // AUDIT-FIX: P3-WF-DIP - workflow data access extends the shared repository base.
const { AppError } = require('../middlewares/errorHandler'); // AUDIT-FIX: P3-WF-SRP - transition validation raises the same application errors as the service layer.

const WORKFLOW_STAGES = { // AUDIT-FIX: P3-WF-SRP - centralize request workflow stage names in one repository-owned constant.
  TRIAGE: 'TRIAGE', // AUDIT-FIX: P3-WF-SRP - preserve the existing workflow stage value.
  IN_PROGRESS: 'IN_PROGRESS', // AUDIT-FIX: P3-WF-SRP - preserve the existing workflow stage value.
  WAITING_SUB_REPORTS: 'WAITING_SUB_REPORTS', // AUDIT-FIX: P3-WF-SRP - preserve the existing workflow stage value.
  DOCTOR_REVIEW: 'DOCTOR_REVIEW', // AUDIT-FIX: P3-WF-SRP - preserve the existing workflow stage value.
  COMPLETED: 'COMPLETED', // AUDIT-FIX: P3-WF-SRP - preserve the existing workflow stage value.
  PUBLISHED: 'PUBLISHED', // AUDIT-FIX: P3-WF-SRP - preserve the existing workflow stage value.
  CANCELLED: 'CANCELLED', // AUDIT-FIX: P3-WF-SRP - preserve the schema-defined workflow stage value.
}; // AUDIT-FIX: P3-WF-SRP - the workflow stage map is reused by validation helpers.

const WORKFLOW_ORDER = [ // AUDIT-FIX: P3-WF-SRP - keep the current stage sequence in one place.
  WORKFLOW_STAGES.TRIAGE, // AUDIT-FIX: P3-WF-SRP - first stage remains triage.
  WORKFLOW_STAGES.IN_PROGRESS, // AUDIT-FIX: P3-WF-SRP - second stage remains in progress.
  WORKFLOW_STAGES.WAITING_SUB_REPORTS, // AUDIT-FIX: P3-WF-SRP - third stage remains waiting on sub reports.
  WORKFLOW_STAGES.DOCTOR_REVIEW, // AUDIT-FIX: P3-WF-SRP - fourth stage remains doctor review.
  WORKFLOW_STAGES.COMPLETED, // AUDIT-FIX: P3-WF-SRP - fifth stage remains completed.
  WORKFLOW_STAGES.PUBLISHED, // AUDIT-FIX: P3-WF-SRP - terminal published stage remains last.
]; // AUDIT-FIX: P3-WF-SRP - callers can derive next-stage behavior from this canonical order.

const VALID_TRANSITIONS = { // AUDIT-FIX: P3-WF-SRP - state-machine validation now lives in one repository source of truth.
  [WORKFLOW_STAGES.TRIAGE]: [WORKFLOW_STAGES.IN_PROGRESS], // AUDIT-FIX: P3-WF-SRP - match the current controller/service gate from triage.
  [WORKFLOW_STAGES.IN_PROGRESS]: [WORKFLOW_STAGES.WAITING_SUB_REPORTS], // AUDIT-FIX: P3-WF-SRP - match the current linear progression.
  [WORKFLOW_STAGES.WAITING_SUB_REPORTS]: [WORKFLOW_STAGES.DOCTOR_REVIEW], // AUDIT-FIX: P3-WF-SRP - match the current linear progression.
  [WORKFLOW_STAGES.DOCTOR_REVIEW]: [WORKFLOW_STAGES.COMPLETED], // AUDIT-FIX: P3-WF-SRP - match the current linear progression.
  [WORKFLOW_STAGES.COMPLETED]: [WORKFLOW_STAGES.PUBLISHED], // AUDIT-FIX: P3-WF-SRP - preserve the schema-supported final publishing step.
  [WORKFLOW_STAGES.PUBLISHED]: [], // AUDIT-FIX: P3-WF-SRP - published remains terminal.
  [WORKFLOW_STAGES.CANCELLED]: [], // AUDIT-FIX: P3-WF-SRP - cancelled remains terminal.
}; // AUDIT-FIX: P3-WF-SRP - transition validation no longer depends on inline service constants.

class WorkflowRepository extends BaseRepository { // AUDIT-FIX: P3-WF-DIP - workflow queries move behind an injected repository boundary.
  constructor(db) { // AUDIT-FIX: P3-WF-DIP - repository construction accepts the shared pool or a compatible executor.
    super(db, 'request_workflow_tasks'); // AUDIT-FIX: P3-WF-DIP - default table for this repository is request_workflow_tasks.
    this._db = db; // AUDIT-FIX: P3-WF-DIP - keep a direct executor reference for optional client support.
  } // AUDIT-FIX: P3-WF-DIP - constructor keeps transaction-aware executor access explicit.

  async _exec(sqlOrFn, params = [], client = null) { // AUDIT-FIX: P3-WF-DIP - all workflow queries run through a transaction-aware executor.
    const executor = client || this._db; // AUDIT-FIX: P3-WF-DIP - use the provided transaction client when present.
    if (typeof sqlOrFn === 'function') { // AUDIT-FIX: P3-WF-SRP - support callback-style multi-step repository work.
      return sqlOrFn(executor); // AUDIT-FIX: P3-WF-SRP - allow complex repository work without exposing the pool.
    } // AUDIT-FIX: P3-WF-SRP - generic executor branching stays internal.
    const result = await executor.query(sqlOrFn, params); // AUDIT-FIX: P3-WF-DIP - normalize query execution in one method.
    return result.rows; // AUDIT-FIX: P3-WF-DIP - repository callers consume rows consistently.
  } // AUDIT-FIX: P3-WF-DIP - generic execution wrapper replaces direct service access to pool/client.

  async _execOne(sql, params = [], client = null) { // AUDIT-FIX: P3-WF-DIP - common single-row helper keeps repository reads concise.
    const rows = await this._exec(sql, params, client); // AUDIT-FIX: P3-WF-DIP - reuse the shared executor wrapper for one-row reads.
    return rows[0] || null; // AUDIT-FIX: P3-WF-SRP - normalize missing rows to null.
  } // AUDIT-FIX: P3-WF-DIP - single-row access is centralized.

  getNextWorkflowStage(currentStage) { // AUDIT-FIX: P3-WF-SRP - next-stage resolution moves out of workflow.service.
    const index = WORKFLOW_ORDER.indexOf(String(currentStage || '').trim().toUpperCase()); // AUDIT-FIX: P3-WF-SRP - normalize before resolving order.
    if (index < 0 || index === WORKFLOW_ORDER.length - 1) { // AUDIT-FIX: P3-WF-SRP - invalid and terminal stages have no next stage.
      return null; // AUDIT-FIX: P3-WF-SRP - preserve current null-on-terminal behavior.
    } // AUDIT-FIX: P3-WF-SRP - stage progression stays linear.
    return WORKFLOW_ORDER[index + 1]; // AUDIT-FIX: P3-WF-SRP - return the next workflow stage in sequence.
  } // AUDIT-FIX: P3-WF-SRP - stage sequencing lives beside transition validation.

  validateTransition(currentStatus, targetStatus) { // AUDIT-FIX: P3-WF-SRP - all stage validation now routes through one repository method.
    const from = String(currentStatus || '').trim().toUpperCase(); // AUDIT-FIX: P3-WF-SRP - normalize the current workflow stage before validation.
    const to = String(targetStatus || '').trim().toUpperCase(); // AUDIT-FIX: P3-WF-SRP - normalize the target workflow stage before validation.
    const allowed = VALID_TRANSITIONS[from] || []; // AUDIT-FIX: P3-WF-SRP - look up allowed transitions from the single source of truth.
    if (!allowed.includes(to)) { // AUDIT-FIX: P3-WF-SRP - reject invalid state transitions consistently.
      throw new AppError(`Invalid transition: ${from} -> ${to}`, 400, 'INVALID_STATUS_TRANSITION'); // AUDIT-FIX: P3-WF-SRP - preserve API-level validation semantics.
    } // AUDIT-FIX: P3-WF-SRP - invalid stage progressions fail fast here.
    return true; // AUDIT-FIX: P3-WF-SRP - allow callers to branch on explicit success when needed.
  } // AUDIT-FIX: P3-WF-SRP - transition logic is no longer duplicated in services/controllers.

  async getRequestCore(requestId, client = null, { forUpdate = false } = {}) { // AUDIT-FIX: P3-WF-DIP - core request reads move behind the repository.
    return this._execOne(
      `
      SELECT id, patient_id, status, service_type, assigned_provider_id, lead_provider_id, workflow_stage,
             final_report_confirmed_at, in_progress_at
      FROM service_requests
      WHERE id = $1
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - callers no longer issue raw request-core queries directly.
  } // AUDIT-FIX: P3-WF-SRP - one method owns the shared request-core projection.

  async findProviderById(providerId, client = null) { // AUDIT-FIX: P3-WF-DIP - provider lookups used by workflow operations live in the repository.
    return this._execOne(
      'SELECT id, full_name, phone, type FROM service_providers WHERE id = $1 LIMIT 1',
      [providerId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - normalize provider reads across workflow operations.
  } // AUDIT-FIX: P3-WF-SRP - provider identity lookup is centralized.

  async providerHasRequestAccess(requestId, providerId, client = null) { // AUDIT-FIX: P3-WF-DIP - request access checks no longer use raw service SQL.
    const row = await this._execOne(
      `
      SELECT 1
      FROM service_requests sr
      WHERE sr.id = $1
        AND (
          sr.assigned_provider_id = $2
          OR sr.lead_provider_id = $2
          OR EXISTS (
            SELECT 1
            FROM request_workflow_tasks rwt
            WHERE rwt.request_id = sr.id
              AND rwt.provider_id = $2
              AND rwt.status <> 'CANCELLED'
          )
        )
      LIMIT 1
      `,
      [requestId, providerId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - provider access checks are repository-owned.
    return Boolean(row); // AUDIT-FIX: P3-WF-SRP - expose a simple boolean access result.
  } // AUDIT-FIX: P3-WF-SRP - authorization helpers can reuse this query everywhere.

  async createTask(data, client = null) { // AUDIT-FIX: P3-WF-DIP - task creation is abstracted behind the repository.
    return this._execOne(
      `
      INSERT INTO request_workflow_tasks (
        request_id, provider_id, role, status, task_type, notes, task_label
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (request_id, provider_id, task_type)
      DO UPDATE SET
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        notes = COALESCE(EXCLUDED.notes, request_workflow_tasks.notes),
        task_label = COALESCE(EXCLUDED.task_label, request_workflow_tasks.task_label),
        updated_at = NOW()
      RETURNING *
      `,
      [
        data.request_id,
        data.provider_id || null,
        data.role || 'ASSISTANT',
        data.status || 'ASSIGNED',
        data.task_type,
        data.notes || null,
        data.task_label || null,
      ],
      client
    ); // AUDIT-FIX: P3-WF-DIP - upsert behavior now lives in one method.
  } // AUDIT-FIX: P3-WF-SRP - callers only provide task data, not SQL.

  async updateTask(id, data, client = null) { // AUDIT-FIX: P3-WF-DIP - task updates are repository-managed.
    return this.update(
      id,
      data,
      ['provider_id', 'role', 'status', 'task_type', 'notes', 'assigned_at', 'accepted_at', 'submitted_at', 'completed_at', 'task_label'],
      client
    ); // AUDIT-FIX: P3-WF-SRP - dynamic task updates stay centralized.
  } // AUDIT-FIX: P3-WF-SRP - generic task update support reduces service-side SQL branches.

  async findTasksByRequest(requestId, client = null) { // AUDIT-FIX: P3-WF-DIP - task listing query moves behind the repository.
    return this._exec(
      `
      SELECT
        rwt.*,
        sp.full_name AS provider_name,
        sp.type AS provider_type
      FROM request_workflow_tasks rwt
      LEFT JOIN service_providers sp ON sp.id = rwt.provider_id
      WHERE rwt.request_id = $1
      ORDER BY rwt.created_at ASC
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - the service no longer owns the task join.
  } // AUDIT-FIX: P3-WF-SRP - workflow task listing is centralized.

  async findTaskById(id, client = null, { requestId = null, forUpdate = false, includeRequest = false } = {}) { // AUDIT-FIX: P3-WF-DIP - support the task lookup shapes used by workflow operations.
    const whereSql = requestId ? 'WHERE rwt.id = $1 AND rwt.request_id = $2' : 'WHERE rwt.id = $1'; // AUDIT-FIX: P3-WF-SRP - optional request scoping stays in one place.
    const params = requestId ? [id, requestId] : [id]; // AUDIT-FIX: P3-WF-SRP - optional request binding stays consistent.
    const joinSql = includeRequest ? 'JOIN service_requests sr ON sr.id = rwt.request_id' : ''; // AUDIT-FIX: P3-WF-SRP - enrich task reads only when the caller needs request fields.
    const selectSql = includeRequest ? ', sr.workflow_stage, sr.service_type, sr.lead_provider_id' : ''; // AUDIT-FIX: P3-WF-SRP - include request metadata for accept/report flows.
    return this._execOne(
      `
      SELECT rwt.*${selectSql}
      FROM request_workflow_tasks rwt
      ${joinSql}
      ${whereSql}
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}
      `,
      params,
      client
    ); // AUDIT-FIX: P3-WF-DIP - shared task lookup variants are repository-owned.
  } // AUDIT-FIX: P3-WF-SRP - one method now serves simple, scoped, and locking task reads.

  async findUnassignedTaskByRequestAndType(requestId, taskType, client = null) { // AUDIT-FIX: P3-WF-DIP - assignment flow can lock the reusable unassigned task row here.
    return this._execOne(
      `
      SELECT *
      FROM request_workflow_tasks
      WHERE request_id = $1
        AND task_type = $2
        AND provider_id IS NULL
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, taskType],
      client
    ); // AUDIT-FIX: P3-WF-DIP - the service no longer embeds this locking query.
  } // AUDIT-FIX: P3-WF-SRP - unassigned-task lookup is centralized.

  async assignExistingTask(taskId, { providerId, role, notes }, client = null) { // AUDIT-FIX: P3-WF-DIP - reuse the same update for pre-created placeholder tasks.
    return this._execOne(
      `
      UPDATE request_workflow_tasks
      SET provider_id = $2,
          role = $3,
          status = 'ASSIGNED',
          assigned_at = NOW(),
          notes = COALESCE($4, notes),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [taskId, providerId, role, notes || null],
      client
    ); // AUDIT-FIX: P3-WF-DIP - assignment update logic moves out of the service.
  } // AUDIT-FIX: P3-WF-SRP - task reassignment uses one repository method.

  async autoAssignPackageTasks(requestId, providerId, excludedTaskId, client = null) { // AUDIT-FIX: P3-WF-DIP - package auto-assignment query is repository-owned.
    return this._exec(
      `
      UPDATE request_workflow_tasks
      SET provider_id = $2,
          role = 'ASSISTANT',
          status = 'ASSIGNED',
          assigned_at = COALESCE(assigned_at, NOW()),
          updated_at = NOW()
      WHERE request_id = $1
        AND id <> $3
        AND provider_id IS NULL
        AND status <> 'CANCELLED'
      RETURNING id, task_type
      `,
      [requestId, providerId, excludedTaskId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - the package auto-assignment branch no longer embeds SQL.
  } // AUDIT-FIX: P3-WF-SRP - auto-assigned task capture is centralized.

  async updateRequestAssignment(requestId, { providerId, serviceType, scheduledAt, isLeadDoctor }, client = null) { // AUDIT-FIX: P3-WF-DIP - assignment-related request updates are centralized.
    if (isLeadDoctor) { // AUDIT-FIX: P3-WF-SRP - lead-doctor assignment keeps the existing lead-provider semantics.
      return this._execOne(
        `
        UPDATE service_requests
        SET lead_provider_id = $2,
            assigned_provider_id = CASE
              WHEN $3 = 'PACKAGE' THEN $2
              ELSE COALESCE(assigned_provider_id, $2)
            END,
            workflow_stage = CASE
              WHEN workflow_stage = 'TRIAGE' THEN 'IN_PROGRESS'
              ELSE workflow_stage
            END,
            workflow_updated_at = NOW(),
            status = CASE WHEN status = 'PENDING' THEN 'ASSIGNED' ELSE status END,
            scheduled_at = COALESCE($4, scheduled_at),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [requestId, providerId, serviceType, scheduledAt || null],
        client
      ); // AUDIT-FIX: P3-WF-DIP - lead-provider request update moves to the repository.
    } // AUDIT-FIX: P3-WF-SRP - non-lead assignment uses the alternate request update branch below.
    return this._execOne(
      `
      UPDATE service_requests
      SET assigned_provider_id = COALESCE(assigned_provider_id, $2),
          workflow_stage = CASE
            WHEN workflow_stage = 'TRIAGE' THEN 'IN_PROGRESS'
            ELSE workflow_stage
          END,
          workflow_updated_at = NOW(),
          status = CASE WHEN status = 'PENDING' THEN 'ASSIGNED' ELSE status END,
          scheduled_at = COALESCE($3, scheduled_at),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [requestId, providerId, scheduledAt || null],
      client
    ); // AUDIT-FIX: P3-WF-DIP - non-lead assignment request update moves to the repository.
  } // AUDIT-FIX: P3-WF-SRP - request assignment side effects are centralized.

  async acceptTasksForPackageProvider(requestId, providerId, notes = null, client = null) { // AUDIT-FIX: P3-WF-DIP - package-wide accept flow moves behind the repository.
    return this._exec(
      `
      UPDATE request_workflow_tasks
      SET status = CASE
            WHEN status = 'ASSIGNED' THEN 'ACCEPTED'
            ELSE status
          END,
          accepted_at = COALESCE(accepted_at, NOW()),
          notes = COALESCE($3, notes),
          updated_at = NOW()
      WHERE request_id = $1
        AND provider_id = $2
        AND status NOT IN ('SUBMITTED', 'COMPLETED', 'CANCELLED')
      RETURNING *
      `,
      [requestId, providerId, notes || null],
      client
    ); // AUDIT-FIX: P3-WF-DIP - package accept uses one reusable query.
  } // AUDIT-FIX: P3-WF-SRP - package accept semantics are centralized.

  async acceptTask(taskId, requestId, notes = null, client = null) { // AUDIT-FIX: P3-WF-DIP - single-task accept flow moves to the repository.
    return this._exec(
      `
      UPDATE request_workflow_tasks
      SET status = 'ACCEPTED',
          accepted_at = COALESCE(accepted_at, NOW()),
          notes = COALESCE($3, notes),
          updated_at = NOW()
      WHERE id = $1 AND request_id = $2
      RETURNING *
      `,
      [taskId, requestId, notes || null],
      client
    ); // AUDIT-FIX: P3-WF-DIP - single accept query becomes reusable.
  } // AUDIT-FIX: P3-WF-SRP - single-task accept update is centralized.

  async countProviderActiveArtifacts(requestId, providerId, client = null) {
    return this._execOne(
      `
      SELECT
        COALESCE((
          SELECT COUNT(*)::int
          FROM request_provider_reports
          WHERE request_id = $1
            AND provider_id = $2
        ), 0) AS report_count,
        COALESCE((
          SELECT COUNT(*)::int
          FROM lab_test_results
          WHERE request_id = $1
            AND entered_by = $2
        ), 0) AS lab_result_count,
        COALESCE((
          SELECT COUNT(*)::int
          FROM request_additional_orders
          WHERE request_id = $1
            AND ordered_by = $2
        ), 0) AS order_count,
        COALESCE((
          SELECT COUNT(*)::int
          FROM payment_records
          WHERE request_id = $1
            AND recorded_by = $2
        ), 0) AS payment_count
      `,
      [requestId, providerId],
      client
    );
  }

  async releaseProviderTasks(requestId, providerId, client = null) {
    return this._exec(
      `
      UPDATE request_workflow_tasks
      SET provider_id = NULL,
          status = 'ASSIGNED',
          assigned_at = NULL,
          accepted_at = NULL,
          submitted_at = NULL,
          completed_at = NULL,
          updated_at = NOW()
      WHERE request_id = $1
        AND provider_id = $2
        AND status NOT IN ('SUBMITTED', 'COMPLETED', 'CANCELLED')
      RETURNING *
      `,
      [requestId, providerId],
      client
    );
  }

  async markTaskSubmitted(taskId, requestId, status, notes = null, client = null) { // AUDIT-FIX: P3-WF-DIP - task submission update is repository-owned.
    return this._execOne(
      `
      UPDATE request_workflow_tasks
      SET status = $3,
          submitted_at = CASE
            WHEN $5 = 'SUBMITTED' OR $5 = 'COMPLETED' THEN COALESCE(submitted_at, NOW())
            ELSE submitted_at
          END,
          completed_at = CASE
            WHEN $5 = 'COMPLETED' THEN COALESCE(completed_at, NOW())
            ELSE completed_at
          END,
          notes = COALESCE($4, notes),
          updated_at = NOW()
      WHERE id = $1 AND request_id = $2
      RETURNING *
      `,
      [taskId, requestId, status, notes || null, status],
      client
    ); // AUDIT-FIX: P3-WF-DIP - submission logic leaves the service layer.
  } // AUDIT-FIX: P3-WF-SRP - task submit/completion update is centralized.

  async markTaskSubmittedIfNeeded(taskId, requestId, client = null) { // AUDIT-FIX: P3-WF-DIP - report submission can reuse a conditional task state update.
    await this._exec(
      `
      UPDATE request_workflow_tasks
      SET status = 'SUBMITTED',
          submitted_at = COALESCE(submitted_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
        AND request_id = $2
        AND status NOT IN ('SUBMITTED', 'COMPLETED', 'CANCELLED')
      `,
      [taskId, requestId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - conditional submit update is standardized here.
  } // AUDIT-FIX: P3-WF-SRP - report-driven task submission uses one repository method.

  async countPendingTasks(requestId, client = null) { // AUDIT-FIX: P3-WF-DIP - pending-task counting moves behind the repository.
    const row = await this._execOne(
      `
      SELECT COUNT(*)::int AS pending_count
      FROM request_workflow_tasks
      WHERE request_id = $1
        AND status NOT IN ('SUBMITTED', 'COMPLETED', 'CANCELLED')
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - service callers no longer embed this count query.
    return row?.pending_count || 0; // AUDIT-FIX: P3-WF-SRP - expose a numeric pending-task count.
  } // AUDIT-FIX: P3-WF-SRP - pending-task checks are centralized.

  async countAssignedActiveTasks(requestId, client = null) { // AUDIT-FIX: P3-WF-DIP - stage-guard task counts move to the repository.
    const row = await this._execOne(
      `
      SELECT COUNT(*)::int AS total
      FROM request_workflow_tasks
      WHERE request_id = $1
        AND status <> 'CANCELLED'
        AND provider_id IS NOT NULL
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - updateWorkflowStage no longer issues this query directly.
    return row?.total || 0; // AUDIT-FIX: P3-WF-SRP - expose the numeric count only.
  } // AUDIT-FIX: P3-WF-SRP - active-task counting is centralized.

  async logLifecycleEvent(eventData, client = null) { // AUDIT-FIX: P3-WF-DIP - lifecycle event inserts are centralized in the repository.
    await this._exec(
      `
      INSERT INTO request_lifecycle_events (
        request_id,
        actor_id,
        actor_role,
        actor_name,
        event_type,
        description,
        metadata,
        workflow_stage_snapshot
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      `,
      [
        eventData.requestId,
        eventData.actorId || null,
        eventData.actorRole || 'SYSTEM',
        eventData.actorName || 'System',
        eventData.eventType,
        eventData.description || null,
        JSON.stringify(eventData.metadata || {}),
        eventData.workflowStageSnapshot || null,
      ],
      client
    ); // AUDIT-FIX: P3-WF-DIP - services now call one repository method for lifecycle logging.
  } // AUDIT-FIX: P3-WF-SRP - lifecycle event persistence is centralized.

  async upsertRequestChatRoom(requestId, roomType, name, client = null) { // AUDIT-FIX: P3-WF-DIP - request chat room upserts move behind the repository.
    return this._execOne(
      `
      INSERT INTO request_chat_rooms (request_id, room_type, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (request_id, room_type)
      DO UPDATE SET name = COALESCE(request_chat_rooms.name, EXCLUDED.name)
      RETURNING *
      `,
      [requestId, roomType, name],
      client
    ); // AUDIT-FIX: P3-WF-DIP - room creation/upsert is now reusable.
  } // AUDIT-FIX: P3-WF-SRP - chat room persistence is centralized.

  async addRequestChatParticipant(roomId, participantId, participantRole, client = null) { // AUDIT-FIX: P3-WF-DIP - request chat participant writes move to the repository.
    await this._exec(
      `
      INSERT INTO request_chat_participants (room_id, participant_id, participant_role)
      VALUES ($1, $2, $3)
      ON CONFLICT (room_id, participant_id, participant_role) DO NOTHING
      `,
      [roomId, participantId, participantRole],
      client
    ); // AUDIT-FIX: P3-WF-DIP - participant upsert is standardized here.
  } // AUDIT-FIX: P3-WF-SRP - chat participant writes are centralized.

  async listActiveTaskProviderIds(requestId, client = null) { // AUDIT-FIX: P3-WF-DIP - request chat room setup no longer queries providers inline.
    const rows = await this._exec(
      `
      SELECT DISTINCT provider_id
      FROM request_workflow_tasks
      WHERE request_id = $1
        AND status <> 'CANCELLED'
        AND provider_id IS NOT NULL
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-WF-DIP - active task-provider lookup is repository-owned.
    return rows.map((row) => row.provider_id); // AUDIT-FIX: P3-WF-SRP - expose only provider ids to callers.
  } // AUDIT-FIX: P3-WF-SRP - provider-id extraction is centralized.
} // AUDIT-FIX: P3-WF-DIP - workflow repository now owns workflow/task/event/chat persistence.

WorkflowRepository.WORKFLOW_STAGES = WORKFLOW_STAGES; // AUDIT-FIX: P3-WF-COMPAT - preserve access to workflow stage constants from the repository type.
WorkflowRepository.WORKFLOW_ORDER = WORKFLOW_ORDER; // AUDIT-FIX: P3-WF-COMPAT - preserve access to the ordered workflow stage list.

module.exports = WorkflowRepository; // AUDIT-FIX: P3-WF-DIP - export the repository for composition-root injection.
