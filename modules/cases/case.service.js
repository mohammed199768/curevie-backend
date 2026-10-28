const crypto = require('crypto');
const pool = require('../../config/db');
const { AppError } = require('../../middlewares/errorHandler');
const CaseRepository = require('../../repositories/CaseRepository');
const ChatRepository = require('../../repositories/ChatRepository');
const events = require('./case.events');
const { t } = require('../../utils/i18n/ar');
const { toPublicMediaUrl } = require('../../utils/storage');
const {
  ITEM_CATALOG,
  PROVIDER_TYPES_BY_KIND,
  CASE_STATUS,
  SERVICE_STATUS,
  FINAL_CASE_STATUSES,
} = require('./case.constants');

const caseRepo = new CaseRepository(pool);
const chatRepo = new ChatRepository(pool);

const MONEY_EPSILON = 0.0005;

function toMoney(value) {
  const n = Math.round(Number(value || 0) * 1000) / 1000;
  return Number.isFinite(n) ? n : 0;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function notFound() {
  return new AppError('Case not found', 404, 'NOT_FOUND');
}

function actorRole(user) {
  return user ? user.role : 'GUEST';
}

// =====================================================================
// Status machine
// =====================================================================

/** The case status follows from its line items; only CLOSED/CANCELLED are set explicitly. */
function deriveCaseStatus(currentStatus, services) {
  if (FINAL_CASE_STATUSES.includes(currentStatus)) return currentStatus;

  const active = services.filter((s) => s.status !== SERVICE_STATUS.CANCELLED);
  if (!active.length) return CASE_STATUS.CANCELLED;
  if (active.every((s) => s.status === SERVICE_STATUS.COMPLETED)) return CASE_STATUS.COMPLETED;
  if (active.some((s) => [SERVICE_STATUS.IN_PROGRESS, SERVICE_STATUS.COMPLETED].includes(s.status))) {
    return CASE_STATUS.IN_PROGRESS;
  }
  if (active.some((s) => [SERVICE_STATUS.ASSIGNED, SERVICE_STATUS.ACCEPTED].includes(s.status))) {
    return CASE_STATUS.ACCEPTED;
  }
  return CASE_STATUS.PENDING;
}

/** Recomputes and persists the case status. Must run inside a transaction holding the case lock. */
async function syncCaseStatus(client, caseRow, user) {
  const services = await caseRepo.getServiceStatuses(caseRow.id, client);
  const next = deriveCaseStatus(caseRow.status, services);
  if (next === caseRow.status) return next;

  if (next === CASE_STATUS.CANCELLED) {
    await caseRepo.markCaseCancelled(caseRow.id, {
      actorId: user?.id,
      actorRole: actorRole(user),
      reason: 'All services were cancelled',
    }, client);
  } else {
    await caseRepo.updateCaseStatus(caseRow.id, next, client);
  }

  await caseRepo.addLifecycleEvent({
    case_id: caseRow.id,
    actor_id: null,
    actor_role: 'SYSTEM',
    event_type: 'STATUS_CHANGED',
    notes: `${caseRow.status} -> ${next}`,
  }, client);

  return next;
}

/**
 * Recomputes the invoice from its line items, adjustments and approved payments.
 * This is the only place invoice totals are written.
 */
async function recomputeInvoice(client, caseId, caseStatus, { forbidOverpaid = false } = {}) {
  let invoice = await caseRepo.lockInvoice(caseId, client);
  if (!invoice) {
    await caseRepo.insertInvoice(caseId, client);
    invoice = await caseRepo.lockInvoice(caseId, client);
  }

  const totals = await caseRepo.getInvoiceTotals(caseId, invoice.id, client);
  const originalAmount = toMoney(totals.original_amount);
  const finalAmount = toMoney(Math.max(0, Number(totals.items_amount) + Number(totals.adjustments_amount)));
  const totalPaid = toMoney(totals.total_paid);

  if (forbidOverpaid && totalPaid - finalAmount > MONEY_EPSILON) {
    throw new AppError(
      'This change would make the invoice lower than what was already paid. Remove or refund payments first.',
      409,
      'REFUND_REQUIRED'
    );
  }

  const remainingAmount = toMoney(Math.max(0, finalAmount - totalPaid));
  let paymentStatus;
  if (caseStatus === CASE_STATUS.CANCELLED && totalPaid <= MONEY_EPSILON) paymentStatus = 'CANCELLED';
  else if (totalPaid <= MONEY_EPSILON) paymentStatus = finalAmount <= MONEY_EPSILON ? 'PAID' : 'PENDING';
  else paymentStatus = remainingAmount <= MONEY_EPSILON ? 'PAID' : 'PARTIAL';

  return caseRepo.writeInvoiceTotals(invoice.id, {
    original_amount: originalAmount,
    final_amount: finalAmount,
    total_paid: totalPaid,
    remaining_amount: remainingAmount,
    payment_status: paymentStatus,
  }, client);
}

// =====================================================================
// Access
// =====================================================================

/**
 * Loads a case the user may see. Non-owners get 404 so case ids cannot be probed.
 * @returns {Promise<object>} case detail row
 */
async function loadAccessibleCase(caseId, user, client = null) {
  const row = await caseRepo.findCaseById(caseId, client);
  if (!row) throw notFound();

  if (user.role === 'ADMIN') return row;
  if (user.role === 'PATIENT' && row.patient_id === user.id) return row;
  if (user.role === 'PROVIDER') {
    if (row.lead_provider_id === user.id) return row;
    if (await caseRepo.providerHasCaseAccess(caseId, user.id, client)) return row;
  }
  throw notFound();
}

// =====================================================================
// Presentation
// =====================================================================

function patientCanCancel(caseRow, services) {
  return [CASE_STATUS.PENDING, CASE_STATUS.ACCEPTED].includes(caseRow.status)
    && !services.some((s) => [SERVICE_STATUS.IN_PROGRESS, SERVICE_STATUS.COMPLETED].includes(s.status));
}

function serviceActions(service, caseRow, user) {
  const open = !FINAL_CASE_STATUSES.includes(caseRow.status);
  const mine = user.role === 'PROVIDER' && service.provider_id === user.id;
  const status = service.status;

  return {
    can_accept: open && mine && status === SERVICE_STATUS.ASSIGNED,
    can_reject: open && mine && [SERVICE_STATUS.ASSIGNED, SERVICE_STATUS.ACCEPTED].includes(status),
    can_start: open && mine && status === SERVICE_STATUS.ACCEPTED,
    can_complete: open && mine && status === SERVICE_STATUS.IN_PROGRESS,
    can_upload: open && mine && [SERVICE_STATUS.IN_PROGRESS, SERVICE_STATUS.COMPLETED].includes(status),
    can_assign: open && user.role === 'ADMIN'
      && [SERVICE_STATUS.PENDING, SERVICE_STATUS.ASSIGNED, SERVICE_STATUS.ACCEPTED].includes(status),
    can_cancel: open && user.role === 'ADMIN'
      && ![SERVICE_STATUS.COMPLETED, SERVICE_STATUS.CANCELLED].includes(status),
    can_rate: user.role === 'PATIENT' && status === SERVICE_STATUS.COMPLETED
      && Boolean(service.provider_id) && service.my_rating == null,
  };
}

function shapeCaseRow(row, user) {
  const shaped = { ...row };
  if (user.role === 'PATIENT') {
    delete shaped.patient_is_vip;
    delete shaped.cancelled_by;
  }
  return shaped;
}

function shapeInvoice(invoice, user, isLead) {
  if (!invoice) return null;
  // Patients always see what they will pay; the detailed invoice is released when the case closes.
  if (user.role === 'PATIENT' && !invoice.is_patient_visible) {
    return {
      is_patient_visible: false,
      original_amount: invoice.original_amount,
      final_amount: invoice.final_amount,
      payment_status: invoice.payment_status,
    };
  }
  if (user.role === 'PROVIDER' && !isLead) return null;
  return invoice;
}

function shapeFile(caseId, file) {
  return { ...file, download_path: `/cases/${caseId}/files/${file.id}` };
}

/** Full case view tailored to the viewer's role. */
async function buildCaseView(caseRow, user) {
  const [allServices, appointments, files, invoice] = await Promise.all([
    caseRepo.findServicesByCase(caseRow.id),
    caseRepo.findAppointmentsByCase(caseRow.id),
    caseRepo.findProviderFilesByCase(caseRow.id),
    caseRepo.findInvoiceByCase(caseRow.id),
  ]);

  const isLead = user.role === 'PROVIDER' && caseRow.lead_provider_id === user.id;
  let services = allServices;
  let visibleFiles = files;
  let visibleAppointments = appointments;

  if (user.role === 'PROVIDER' && !isLead) {
    const myServiceIds = new Set(allServices.filter((s) => s.provider_id === user.id).map((s) => s.id));
    services = allServices.filter((s) => myServiceIds.has(s.id));
    visibleFiles = files.filter((f) => myServiceIds.has(f.case_service_id));
    visibleAppointments = appointments.filter((a) => myServiceIds.has(a.case_service_id));
  }
  // Patients see provider uploads once the admin reviewed and closed the case.
  if (user.role === 'PATIENT' && caseRow.status !== CASE_STATUS.CLOSED) {
    visibleFiles = [];
  }
  if (user.role !== 'ADMIN') {
    services = services.map(({ notes, ...rest }) => (user.role === 'PROVIDER' ? { ...rest, notes } : rest));
  }

  const view = {
    case: shapeCaseRow(caseRow, user),
    services: services.map((service) => ({
      ...service,
      provider_avatar_url: toPublicMediaUrl(service.provider_avatar_url),
      actions: serviceActions(service, caseRow, user),
    })),
    appointments: visibleAppointments,
    provider_files: visibleFiles.map((file) => shapeFile(caseRow.id, file)),
    invoice: shapeInvoice(invoice, user, isLead),
    case_actions: {
      can_cancel: user.role === 'PATIENT'
        ? patientCanCancel(caseRow, allServices)
        : user.role === 'ADMIN' && !FINAL_CASE_STATUSES.includes(caseRow.status)
          && !allServices.some((s) => [SERVICE_STATUS.IN_PROGRESS, SERVICE_STATUS.COMPLETED].includes(s.status)),
      can_close: user.role === 'ADMIN' && caseRow.status === CASE_STATUS.COMPLETED,
      can_add_appointment: user.role === 'ADMIN' && !FINAL_CASE_STATUSES.includes(caseRow.status),
    },
  };

  if (user.role === 'ADMIN') {
    view.lifecycle = await caseRepo.listLifecycleEvents(caseRow.id);
  }

  return view;
}

async function getCaseDetail(caseId, user) {
  const caseRow = await loadAccessibleCase(caseId, user);
  return buildCaseView(caseRow, user);
}

// =====================================================================
// Ordering
// =====================================================================

async function loadCatalogItems(client, items) {
  const idsByType = new Map();
  for (const item of items) {
    if (!idsByType.has(item.type)) idsByType.set(item.type, []);
    idsByType.get(item.type).push(item.id);
  }

  const rowsByKey = new Map();
  for (const [type, ids] of idsByType) {
    const { rows } = await client.query(ITEM_CATALOG[type].sql, [ids]);
    rows.forEach((row) => rowsByKey.set(`${type}:${row.id}`, row));
  }
  return rowsByKey;
}

/**
 * Creates an order. Prices, names and VIP discount are resolved on the server.
 * @param {object|null} user  authenticated patient, or null for a guest
 * @param {object} input      validated body: items[], area_id, address, scheduled_for, notes, guest_*
 */
async function createCase(user, input) {
  const isGuest = !user;
  const trackingToken = isGuest ? crypto.randomBytes(24).toString('base64url') : null;

  const created = await withTransaction(async (client) => {
    const { rows: areaRows } = await client.query('SELECT id, is_active FROM areas WHERE id = $1', [input.area_id]);
    if (!areaRows[0] || !areaRows[0].is_active) {
      throw new AppError('Selected area is not served', 400, 'INVALID_AREA');
    }

    let patient = null;
    if (!isGuest) {
      const { rows } = await client.query(
        `SELECT id, full_name, address, is_vip, vip_discount, deleted_at FROM patients WHERE id = $1`,
        [user.id]
      );
      patient = rows[0];
      if (!patient || patient.deleted_at) throw new AppError('Patient account not found', 403, 'FORBIDDEN');
    }

    const address = (input.address || '').trim() || patient?.address || null;
    if (!address) throw new AppError('A visit address is required', 400, 'ADDRESS_REQUIRED');

    const catalog = await loadCatalogItems(client, input.items);
    const discountPercent = patient?.is_vip ? Math.min(Math.max(Number(patient.vip_discount) || 0, 0), 100) : 0;

    const lines = input.items.map((item) => {
      const row = catalog.get(`${item.type}:${item.id}`);
      if (!row) throw new AppError(`Item ${item.type} ${item.id} was not found`, 400, 'ITEM_NOT_FOUND');
      if (!row.is_active) throw new AppError(`"${row.item_name}" is not available`, 400, 'ITEM_INACTIVE');
      if (row.is_vip_exclusive && !patient?.is_vip) {
        throw new AppError(`"${row.item_name}" is available to VIP members only`, 403, 'VIP_ONLY');
      }
      const originalPrice = toMoney(row.price);
      return {
        item,
        row,
        originalPrice,
        bundlePrice: toMoney((originalPrice * (100 - discountPercent)) / 100),
      };
    });

    const caseRow = await caseRepo.insertCase({
      patient_id: patient?.id || null,
      guest_name: isGuest ? input.guest_name : null,
      guest_phone: isGuest ? input.guest_phone : null,
      guest_address: isGuest ? address : null,
      area_id: input.area_id,
      address,
      scheduled_for: input.scheduled_for || null,
      notes: input.notes || null,
      tracking_token_hash: trackingToken ? hashToken(trackingToken) : null,
    }, client);

    for (const line of lines) {
      await caseRepo.insertCaseService({
        case_id: caseRow.id,
        item_type: line.item.type,
        [ITEM_CATALOG[line.item.type].column]: line.item.id,
        item_name: line.row.item_name,
        original_price: line.originalPrice,
        bundle_price: line.bundlePrice,
        notes: line.item.notes || null,
      }, client);
    }

    await caseRepo.insertInvoice(caseRow.id, client);
    await recomputeInvoice(client, caseRow.id, CASE_STATUS.PENDING);
    await caseRepo.incrementPackageOrders(
      lines.filter((line) => line.item.type === 'PACKAGE').map((line) => line.item.id),
      client
    );
    await caseRepo.addLifecycleEvent({
      case_id: caseRow.id,
      actor_id: user?.id || null,
      actor_role: actorRole(user),
      event_type: 'CASE_CREATED',
      notes: input.notes || null,
    }, client);

    return {
      caseId: caseRow.id,
      patientId: patient?.id || null,
      sourceLabel: isGuest ? `${t('labels.guest')}: ${input.guest_name}` : patient.full_name,
      itemNames: lines.map((line) => line.row.item_name),
    };
  });

  events.caseCreated(created);

  if (isGuest) {
    return {
      tracking_token: trackingToken,
      case: await getTrackingView(created.caseId),
    };
  }
  return getCaseDetail(created.caseId, user);
}

async function listCases(user, query) {
  const filters = {
    page: query.page,
    limit: query.limit,
    status: query.status ? String(query.status).split(',').map((s) => s.trim()).filter(Boolean) : null,
    service_status: query.service_status || null,
    patient_id: query.patient_id || null,
    area_id: query.area_id || null,
    unassigned: Boolean(query.unassigned),
    search: query.search || null,
    from: query.from || null,
    to: query.to || null,
  };

  const viewer = { scope: user.role, userId: user.id };
  const { cases, total } = await caseRepo.listCases(viewer, filters);

  const shaped = cases.map((row) => {
    if (user.role === 'PROVIDER') {
      const { final_amount, total_paid, remaining_amount, payment_status, is_patient_visible, ...rest } = row;
      return rest;
    }
    if (user.role === 'PATIENT' && !row.is_patient_visible) {
      return { ...row, total_paid: null, remaining_amount: null };
    }
    return row;
  });

  return { cases: shaped, total, page: filters.page, limit: filters.limit };
}

// =====================================================================
// Assignment (admin)
// =====================================================================

async function assignTeam(caseId, { assignments, lead_provider_id: leadProviderId }, admin) {
  const result = await withTransaction(async (client) => {
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (!caseRow) throw notFound();
    if (FINAL_CASE_STATUSES.includes(caseRow.status) || caseRow.status === CASE_STATUS.COMPLETED) {
      throw new AppError(`Cannot assign providers to a ${caseRow.status} case`, 409, 'INVALID_CASE_STATUS');
    }

    const changed = [];
    for (const assignment of assignments) {
      const service = await caseRepo.lockCaseService(caseId, assignment.case_service_id, client);
      if (!service) throw new AppError('Case service not found for this case', 404, 'CASE_SERVICE_NOT_FOUND');
      if (![SERVICE_STATUS.PENDING, SERVICE_STATUS.ASSIGNED, SERVICE_STATUS.ACCEPTED].includes(service.status)) {
        throw new AppError(
          `"${service.item_name}" is ${service.status} and can no longer be reassigned`,
          409,
          'INVALID_SERVICE_STATUS'
        );
      }

      const provider = await caseRepo.findAssignableProvider(assignment.provider_id, client);
      if (!provider || provider.deleted_at) throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
      if (!provider.is_active) {
        throw new AppError(`${provider.full_name} account is disabled`, 409, 'PROVIDER_INACTIVE');
      }

      if (service.provider_id === provider.id && service.status !== SERVICE_STATUS.PENDING) continue;

      await caseRepo.updateServiceStatus(service.id, { status: SERVICE_STATUS.ASSIGNED, provider_id: provider.id }, client);
      if (caseRow.patient_id) {
        await chatRepo.upsertRoom({ caseServiceId: service.id, patientId: caseRow.patient_id, providerId: provider.id }, client);
      }
      await caseRepo.addLifecycleEvent({
        case_id: caseId,
        case_service_id: service.id,
        actor_id: admin.id,
        actor_role: 'ADMIN',
        event_type: 'PROVIDER_ASSIGNED',
        notes: `${provider.full_name} -> ${service.item_name}`,
      }, client);

      changed.push({
        caseServiceId: service.id,
        providerId: provider.id,
        providerName: provider.full_name,
        itemName: service.item_name,
        previousProviderId: service.provider_id,
      });
    }

    if (leadProviderId !== undefined) {
      if (leadProviderId) {
        const services = await caseRepo.getServiceStatuses(caseId, client);
        const onCase = services.some((s) => s.provider_id === leadProviderId && s.status !== SERVICE_STATUS.CANCELLED);
        if (!onCase) {
          throw new AppError('The lead provider must be assigned to one of the case services', 400, 'INVALID_LEAD_PROVIDER');
        }
      }
      await caseRepo.setLeadProvider(caseId, leadProviderId || null, client);
    }

    const status = await syncCaseStatus(client, caseRow, admin);
    return { caseRow, changed, status };
  });

  const { caseRow, changed, status } = result;
  if (changed.length) {
    const detail = await caseRepo.findCaseById(caseId);
    events.providersAssigned({
      caseId,
      patientId: caseRow.patient_id,
      patientName: detail?.patient_name,
      assignments: changed,
    });
  }
  events.emitCaseUpdated({
    caseId,
    status,
    patientId: caseRow.patient_id,
    providerIds: changed.flatMap((c) => [c.providerId, c.previousProviderId]),
    event: 'PROVIDER_ASSIGNED',
  });

  return getCaseDetail(caseId, admin);
}

async function getCandidates(caseId, serviceId, { includeAll = false } = {}) {
  const caseRow = await caseRepo.findCaseById(caseId);
  if (!caseRow) throw notFound();
  const services = await caseRepo.findServicesByCase(caseId);
  const service = services.find((s) => s.id === serviceId);
  if (!service) throw new AppError('Case service not found for this case', 404, 'CASE_SERVICE_NOT_FOUND');

  const allowedTypes = PROVIDER_TYPES_BY_KIND[service.service_kind] || PROVIDER_TYPES_BY_KIND.MEDICAL;
  const providers = await caseRepo.findCandidateProviders({ areaId: caseRow.area_id, allowedTypes, includeAll });

  return {
    case_service_id: service.id,
    service_kind: service.service_kind,
    allowed_provider_types: allowedTypes,
    area_id: caseRow.area_id,
    providers: providers.map((provider) => ({ ...provider, avatar_url: toPublicMediaUrl(provider.avatar_url) })),
  };
}

// =====================================================================
// Provider workflow
// =====================================================================

const PROVIDER_TRANSITIONS = {
  accept: { from: [SERVICE_STATUS.ASSIGNED], to: SERVICE_STATUS.ACCEPTED, event: 'SERVICE_ACCEPTED' },
  reject: { from: [SERVICE_STATUS.ASSIGNED, SERVICE_STATUS.ACCEPTED], to: SERVICE_STATUS.PENDING, event: 'SERVICE_REJECTED' },
  start: { from: [SERVICE_STATUS.ACCEPTED], to: SERVICE_STATUS.IN_PROGRESS, event: 'SERVICE_STARTED' },
  complete: { from: [SERVICE_STATUS.IN_PROGRESS], to: SERVICE_STATUS.COMPLETED, event: 'SERVICE_COMPLETED' },
};

const ACTION_PAST_TENSE = { accept: 'accepted', reject: 'rejected', start: 'started', complete: 'completed' };

/**
 * Applies a provider transition (accept / reject / start / complete) to one of their line items.
 */
async function providerTransition(caseId, serviceId, provider, action, { reason } = {}) {
  const transition = PROVIDER_TRANSITIONS[action];

  const result = await withTransaction(async (client) => {
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (!caseRow) throw notFound();
    const service = await caseRepo.lockCaseService(caseId, serviceId, client);
    if (!service || service.provider_id !== provider.id) throw new AppError('Service not found', 404, 'NOT_FOUND');
    if (FINAL_CASE_STATUSES.includes(caseRow.status)) {
      throw new AppError(`The case is ${caseRow.status}`, 409, 'INVALID_CASE_STATUS');
    }
    if (!transition.from.includes(service.status)) {
      throw new AppError(
        `Cannot ${action} a service that is ${service.status}`,
        409,
        'INVALID_SERVICE_STATUS'
      );
    }

    const changes = { status: transition.to };
    if (action === 'reject') changes.provider_id = null;
    await caseRepo.updateServiceStatus(service.id, changes, client);

    if (action === 'reject' && caseRow.lead_provider_id === provider.id) {
      const remaining = await caseRepo.getServiceStatuses(caseId, client);
      if (!remaining.some((s) => s.provider_id === provider.id)) {
        await caseRepo.setLeadProvider(caseId, null, client);
      }
    }

    await caseRepo.addLifecycleEvent({
      case_id: caseId,
      case_service_id: service.id,
      actor_id: provider.id,
      actor_role: 'PROVIDER',
      event_type: transition.event,
      notes: action === 'reject' ? reason || null : service.item_name,
    }, client);

    const status = await syncCaseStatus(client, caseRow, provider);
    const { rows } = await client.query('SELECT full_name FROM service_providers WHERE id = $1', [provider.id]);
    return { caseRow, service, status, providerName: rows[0]?.full_name };
  });

  const { caseRow, service, status, providerName } = result;
  events.serviceProgressed({
    action: ACTION_PAST_TENSE[action],
    caseId,
    caseStatus: status,
    patientId: caseRow.patient_id,
    providerName,
    itemName: service.item_name,
    caseServiceId: service.id,
    reason,
  });
  events.emitCaseUpdated({
    caseId,
    status,
    patientId: caseRow.patient_id,
    providerIds: [provider.id, caseRow.lead_provider_id],
    event: transition.event,
    caseServiceId: service.id,
    serviceStatus: transition.to,
  });

  if (action === 'reject') return { case_id: caseId, case_service_id: service.id, status: transition.to };
  return getCaseDetail(caseId, provider);
}

// =====================================================================
// Cancellation
// =====================================================================

async function cancelService(caseId, serviceId, admin, reason) {
  const result = await withTransaction(async (client) => {
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (!caseRow) throw notFound();
    if (FINAL_CASE_STATUSES.includes(caseRow.status)) {
      throw new AppError(`The case is ${caseRow.status}`, 409, 'INVALID_CASE_STATUS');
    }
    const service = await caseRepo.lockCaseService(caseId, serviceId, client);
    if (!service) throw new AppError('Case service not found for this case', 404, 'CASE_SERVICE_NOT_FOUND');
    if ([SERVICE_STATUS.COMPLETED, SERVICE_STATUS.CANCELLED].includes(service.status)) {
      throw new AppError(`Cannot cancel a ${service.status} service`, 409, 'INVALID_SERVICE_STATUS');
    }

    await caseRepo.updateServiceStatus(service.id, { status: SERVICE_STATUS.CANCELLED }, client);
    await caseRepo.addLifecycleEvent({
      case_id: caseId,
      case_service_id: service.id,
      actor_id: admin.id,
      actor_role: 'ADMIN',
      event_type: 'SERVICE_CANCELLED',
      notes: reason || service.item_name,
    }, client);

    const status = await syncCaseStatus(client, caseRow, admin);
    await recomputeInvoice(client, caseId, status, { forbidOverpaid: true });
    return { caseRow, service, status };
  });

  const { caseRow, service, status } = result;
  events.serviceCancelled({
    caseId,
    providerId: service.provider_id,
    itemName: service.item_name,
    caseServiceId: service.id,
  });
  events.emitCaseUpdated({
    caseId,
    status,
    patientId: caseRow.patient_id,
    providerIds: [service.provider_id],
    event: 'SERVICE_CANCELLED',
    caseServiceId: service.id,
    serviceStatus: SERVICE_STATUS.CANCELLED,
  });

  return getCaseDetail(caseId, admin);
}

/** Cancels the whole order (patient before work starts, or admin). */
async function cancelCase(caseId, user, reason) {
  const result = await withTransaction(async (client) => {
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (!caseRow) throw notFound();
    if (user.role === 'PATIENT' && caseRow.patient_id !== user.id) throw notFound();
    if (FINAL_CASE_STATUSES.includes(caseRow.status) || caseRow.status === CASE_STATUS.COMPLETED) {
      throw new AppError(`Cannot cancel a ${caseRow.status} case`, 409, 'INVALID_CASE_STATUS');
    }

    const services = await caseRepo.getServiceStatuses(caseId, client);
    if (services.some((s) => [SERVICE_STATUS.IN_PROGRESS, SERVICE_STATUS.COMPLETED].includes(s.status))) {
      throw new AppError(
        user.role === 'ADMIN'
          ? 'Work already started on this case; cancel the remaining services one by one instead'
          : 'Work already started on this order; please contact support to cancel',
        409,
        'CASE_IN_PROGRESS'
      );
    }

    const invoice = await caseRepo.lockInvoice(caseId, client);
    if (invoice && Number(invoice.total_paid) > MONEY_EPSILON) {
      throw new AppError('Payments were recorded for this case. Remove them before cancelling.', 409, 'REFUND_REQUIRED');
    }

    for (const service of services) {
      if (service.status !== SERVICE_STATUS.CANCELLED) {
        await caseRepo.updateServiceStatus(service.id, { status: SERVICE_STATUS.CANCELLED }, client);
      }
    }
    await caseRepo.markCaseCancelled(caseId, { actorId: user.id, actorRole: user.role, reason }, client);
    await caseRepo.addLifecycleEvent({
      case_id: caseId,
      actor_id: user.id,
      actor_role: user.role,
      event_type: 'CASE_CANCELLED',
      notes: reason || null,
    }, client);
    await recomputeInvoice(client, caseId, CASE_STATUS.CANCELLED);

    return { caseRow, providerIds: services.map((s) => s.provider_id).filter(Boolean) };
  });

  const { caseRow, providerIds } = result;
  events.caseCancelled({
    caseId,
    cancelledByRole: user.role,
    patientId: caseRow.patient_id,
    providerIds,
    reason,
  });
  events.emitCaseUpdated({
    caseId,
    status: CASE_STATUS.CANCELLED,
    patientId: caseRow.patient_id,
    providerIds,
    event: 'CASE_CANCELLED',
  });

  return getCaseDetail(caseId, user);
}

// =====================================================================
// Appointments, closing, rating
// =====================================================================

async function addAppointment(caseId, admin, data) {
  const result = await withTransaction(async (client) => {
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (!caseRow) throw notFound();
    if (FINAL_CASE_STATUSES.includes(caseRow.status)) {
      throw new AppError(`The case is ${caseRow.status}`, 409, 'INVALID_CASE_STATUS');
    }
    const service = await caseRepo.lockCaseService(caseId, data.case_service_id, client);
    if (!service) throw new AppError('Case service not found for this case', 404, 'CASE_SERVICE_NOT_FOUND');
    if (service.status === SERVICE_STATUS.CANCELLED) {
      throw new AppError('Cannot schedule a cancelled service', 409, 'INVALID_SERVICE_STATUS');
    }

    const appointment = await caseRepo.insertAppointment({
      case_service_id: service.id,
      scheduled_at: data.scheduled_at,
      type: data.type,
      notes: data.notes,
      created_by: admin.id,
    }, client);
    await caseRepo.addLifecycleEvent({
      case_id: caseId,
      case_service_id: service.id,
      actor_id: admin.id,
      actor_role: 'ADMIN',
      event_type: 'APPOINTMENT_SCHEDULED',
      notes: data.notes || null,
    }, client);

    return { caseRow, service, appointment };
  });

  const { caseRow, service, appointment } = result;
  events.appointmentScheduled({
    caseId,
    patientId: caseRow.patient_id,
    providerId: service.provider_id,
    itemName: service.item_name,
    scheduledAt: appointment.scheduled_at,
    caseServiceId: service.id,
  });
  events.emitCaseUpdated({
    caseId,
    status: caseRow.status,
    patientId: caseRow.patient_id,
    providerIds: [service.provider_id],
    event: 'APPOINTMENT_SCHEDULED',
    caseServiceId: service.id,
  });

  return appointment;
}

async function closeCase(caseId, admin, notes) {
  const result = await withTransaction(async (client) => {
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (!caseRow) throw notFound();
    if (caseRow.status !== CASE_STATUS.COMPLETED) {
      throw new AppError('Only COMPLETED cases can be closed', 409, 'INVALID_CASE_STATUS');
    }

    const detail = await caseRepo.findCaseById(caseId, client);
    const services = await caseRepo.findServicesByCase(caseId, client);
    const invoice = await recomputeInvoice(client, caseId, CASE_STATUS.CLOSED);

    const providers = new Map();
    services.forEach((service) => {
      if (service.provider_id) {
        providers.set(service.provider_id, {
          provider_id: service.provider_id,
          provider_name: service.provider_name,
          provider_type: service.provider_type,
        });
      }
    });

    const snapshot = await caseRepo.createSnapshot({
      case_id: caseId,
      patient_data: {
        id: detail.patient_id,
        full_name: detail.patient_name,
        phone: detail.patient_phone,
        date_of_birth: detail.patient_dob,
        gender: detail.patient_gender,
        allergies: detail.patient_allergies,
        address: detail.address,
        area: detail.area_name_ar,
      },
      services_data: services.map((service) => ({
        id: service.id,
        item_type: service.item_type,
        item_name: service.item_name,
        service_kind: service.service_kind,
        status: service.status,
        provider_id: service.provider_id,
        provider_name: service.provider_name,
        provider_type: service.provider_type,
        original_price: service.original_price,
        bundle_price: service.bundle_price,
        completed_at: service.completed_at,
      })),
      providers_data: [...providers.values()],
      invoice_data: invoice,
    }, client);
    if (!snapshot) throw new AppError('Case snapshot is locked and cannot be modified', 409, 'CASE_SNAPSHOT_LOCKED');

    await caseRepo.markCaseClosed(caseId, admin.id, notes, client);
    await caseRepo.ensureMedicalReportRecord(caseId, client);
    await caseRepo.setInvoiceVisible(caseId, client);
    await caseRepo.addLifecycleEvent({
      case_id: caseId,
      actor_id: admin.id,
      actor_role: 'ADMIN',
      event_type: 'CASE_CLOSED',
      notes: notes || null,
    }, client);

    return { caseRow, providerIds: [...providers.keys()] };
  });

  events.caseClosed({ caseId, patientId: result.caseRow.patient_id });
  events.emitCaseUpdated({
    caseId,
    status: CASE_STATUS.CLOSED,
    patientId: result.caseRow.patient_id,
    providerIds: result.providerIds,
    event: 'CASE_CLOSED',
  });

  return getCaseDetail(caseId, admin);
}

async function rateService(caseId, serviceId, patient, { rating, comment }) {
  const rated = await withTransaction(async (client) => {
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (!caseRow || caseRow.patient_id !== patient.id) throw notFound();
    const service = await caseRepo.lockCaseService(caseId, serviceId, client);
    if (!service) throw new AppError('Service not found', 404, 'NOT_FOUND');
    if (service.status !== SERVICE_STATUS.COMPLETED || !service.provider_id) {
      throw new AppError('Only completed services can be rated', 409, 'INVALID_SERVICE_STATUS');
    }

    const row = await caseRepo.insertRating({
      case_service_id: service.id,
      case_id: caseId,
      patient_id: patient.id,
      provider_id: service.provider_id,
      rating,
      comment,
    }, client);
    if (!row) throw new AppError('This service was already rated', 409, 'ALREADY_RATED');

    const { rows } = await client.query('SELECT full_name FROM service_providers WHERE id = $1', [service.provider_id]);
    return { row, providerName: rows[0]?.full_name };
  });

  events.serviceRated({
    caseId,
    providerId: rated.row.provider_id,
    providerName: rated.providerName,
    rating,
  });
  return rated.row;
}

// =====================================================================
// Guest tracking
// =====================================================================

/** Minimal, non-sensitive view of a case for the guest tracking page. */
async function getTrackingView(caseId) {
  const caseRow = await caseRepo.findCaseById(caseId);
  if (!caseRow) throw notFound();
  const [services, appointments, invoice] = await Promise.all([
    caseRepo.findServicesByCase(caseId),
    caseRepo.findAppointmentsByCase(caseId),
    caseRepo.findInvoiceByCase(caseId),
  ]);

  return {
    id: caseRow.id,
    reference: `#${caseRow.id.slice(0, 8).toUpperCase()}`,
    status: caseRow.status,
    created_at: caseRow.created_at,
    scheduled_for: caseRow.scheduled_for,
    area_name_ar: caseRow.area_name_ar,
    area_name_en: caseRow.area_name_en,
    cancel_reason: caseRow.cancel_reason,
    services: services.map((service) => ({
      id: service.id,
      item_type: service.item_type,
      item_name: service.item_name,
      service_kind: service.service_kind,
      status: service.status,
      provider_name: service.provider_name ? String(service.provider_name).split(' ')[0] : null,
      bundle_price: service.bundle_price,
    })),
    appointments: appointments.map((appointment) => ({
      case_service_id: appointment.case_service_id,
      scheduled_at: appointment.scheduled_at,
      type: appointment.type,
    })),
    invoice: invoice ? { final_amount: invoice.final_amount, payment_status: invoice.payment_status } : null,
  };
}

async function trackCase(token) {
  const caseId = await caseRepo.findCaseIdByTrackingHash(hashToken(token));
  if (!caseId) throw notFound();
  return getTrackingView(caseId);
}

/** Attaches a guest order to the logged-in patient who holds its tracking token. */
async function claimCase(patient, token) {
  const claimed = await withTransaction(async (client) => {
    const caseId = await caseRepo.findCaseIdByTrackingHash(hashToken(token), client);
    if (!caseId) throw notFound();
    const caseRow = await caseRepo.lockCase(caseId, client);
    if (caseRow.patient_id) throw new AppError('This order already belongs to an account', 409, 'ALREADY_CLAIMED');

    await caseRepo.claimGuestCase(caseId, patient.id, client);
    const services = await caseRepo.getServiceStatuses(caseId, client);
    for (const service of services) {
      if (service.provider_id && service.status !== SERVICE_STATUS.CANCELLED) {
        await chatRepo.upsertRoom({ caseServiceId: service.id, patientId: patient.id, providerId: service.provider_id }, client);
      }
    }
    await caseRepo.addLifecycleEvent({
      case_id: caseId,
      actor_id: patient.id,
      actor_role: 'PATIENT',
      event_type: 'CASE_CLAIMED',
    }, client);
    return caseId;
  });

  return getCaseDetail(claimed, patient);
}

// =====================================================================
// Ratings for providers
// =====================================================================

async function getProviderRatings(providerId, { page, limit }) {
  const offset = (page - 1) * limit;
  const [summary, data] = await Promise.all([
    caseRepo.getProviderRatingSummary(providerId),
    caseRepo.listProviderRatings(providerId, { limit, offset }),
  ]);
  return {
    summary: {
      total_ratings: summary.total_ratings,
      average_rating: Number(summary.average_rating),
    },
    data,
    pagination: {
      page,
      limit,
      total: summary.total_ratings,
      totalPages: Math.ceil(summary.total_ratings / limit),
    },
  };
}

module.exports = {
  // exported for tests
  deriveCaseStatus,
  toMoney,
  hashToken,
  // shared with sibling routers
  withTransaction,
  recomputeInvoice,
  loadAccessibleCase,
  caseRepo,
  chatRepo,
  // operations
  createCase,
  getCaseDetail,
  listCases,
  assignTeam,
  getCandidates,
  providerTransition,
  cancelService,
  cancelCase,
  addAppointment,
  closeCase,
  rateService,
  trackCase,
  claimCase,
  getProviderRatings,
};
