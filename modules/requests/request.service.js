const RequestRepository = require('../../repositories/RequestRepository'); // AUDIT-FIX: P3-REQUEST-DIP - request data access now flows through the repository layer.
const { evaluateResult } = require('../labtests/labrange.service');
const notifService = require('../notifications/notification.service');
const { logger } = require('../../utils/logger');
const { AppError } = require('../../middlewares/errorHandler');
const workflowService = require('./request.workflow.service');
const {
  buildRequestSnapshot,
  syncRequestSnapshotPayload,
  syncRequestProviderSnapshots,
  normalizePackageComponentsSnapshot,
} = require('../../utils/requestSnapshots');
const { validateAndComputeCoupon } = require('../../utils/couponValidator');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace repeated request-list bounds and metadata code

const { deleteStoredPdf } = require('../../utils/pdf/storage');

let requestRepo = null; // AUDIT-FIX: P3-STEP8-DIP - request service composition is now configured externally instead of requiring config/db here.
const PROVIDER_ALLOWED_STATUSES = ['IN_PROGRESS', 'COMPLETED'];

function getRequestRepo() { // AUDIT-FIX: P3-STEP8-DIP - singleton request-repository resolution is centralized for explicit composition.
  if (!requestRepo) { // AUDIT-FIX: P3-STEP8-DIP - fail fast when routes have not wired the request service yet.
    throw new Error('Request service has not been configured. Configure it at the composition root first.'); // AUDIT-FIX: P3-STEP8-DIP - make missing composition explicit instead of silently requiring config/db here.
  } // AUDIT-FIX: P3-STEP8-DIP - prevent null repository usage inside service helpers.
  return requestRepo; // AUDIT-FIX: P3-STEP8-DIP - reuse the configured repository singleton for all service methods.
} // AUDIT-FIX: P3-STEP8-DIP - repository lookup now lives in one place.

function getRequestDb() { // AUDIT-FIX: P3-STEP8-DIP - service fallbacks now reuse the injected repository executor instead of pool.
  return getRequestRepo()._db; // AUDIT-FIX: P3-STEP8-DIP - preserve default DB execution for helpers that still accept optional clients.
} // AUDIT-FIX: P3-STEP8-DIP - injected DB fallback is centralized for legacy helper signatures.

function configureRequestService(repository) { // AUDIT-FIX: P3-STEP8-DIP - request routes now inject the concrete repository explicitly.
  requestRepo = repository; // AUDIT-FIX: P3-STEP8-DIP - persist the externally composed request repository singleton.
  return module.exports; // AUDIT-FIX: P3-STEP8-DIP - allow callers to keep using the existing service object after configuration.
} // AUDIT-FIX: P3-STEP8-DIP - request service no longer owns its own pool-backed construction.

async function getLabResultColumnsSupport() {
  return requestRepo.getLabResultColumnsSupport(); // AUDIT-FIX: P3-REQUEST-SRP - schema capability detection is centralized in the repository.
}

function calculateAgeYears(dateOfBirth) {
  if (!dateOfBirth) return null;
  const date = new Date(dateOfBirth);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000));
}

function normalizeEvaluationGender(gender) {
  const normalized = typeof gender === 'string' ? gender.trim().toLowerCase() : null;
  return normalized === 'male' || normalized === 'female' ? normalized : null;
}

function resolveEvaluationContext(subject) {
  const guestAge = subject?.guest_age;
  const hasGuestAge = guestAge !== null && guestAge !== undefined && guestAge !== '';
  const numericGuestAge = hasGuestAge ? Number(guestAge) : null;

  return {
    gender: normalizeEvaluationGender(subject?.gender || subject?.guest_gender || null),
    age: Number.isFinite(numericGuestAge) ? numericGuestAge : calculateAgeYears(subject?.date_of_birth),
  };
}

function formatDisplayRangeRows(rows) {
  if (!rows.length) return null;

  const textRanges = rows.filter((row) => row.range_text);
  if (textRanges.length && textRanges.length === rows.length) {
    const unique = [...new Set(textRanges.map((row) => row.range_text))];
    return unique.join(' / ');
  }

  const general = rows.find(
    (row) =>
      row.gender === 'any'
      && !row.fasting_state
      && !row.cycle_phase
      && row.is_pregnant === null
  );
  const target = general || rows[0];

  if (!target) return null;

  const unit = target.unit || '';
  if (target.range_low !== null && target.range_high !== null) {
    return `${target.range_low} \u2013 ${target.range_high}${unit ? ` ${unit}` : ''}`;
  }
  if (target.range_low !== null) {
    return `\u2265 ${target.range_low}${unit ? ` ${unit}` : ''}`;
  }
  if (target.range_high !== null) {
    return `\u2264 ${target.range_high}${unit ? ` ${unit}` : ''}`;
  }

  return null;
}

async function buildPackageDisplayRanges(packageTests, db = getRequestDb()) {
  const testIds = [...new Set(
    packageTests
      .map((test) => test.lab_test_id || test.id)
      .filter(Boolean)
  )];

  if (!testIds.length) {
    return new Map();
  }

  const { rows } = await db.query(
    `
    WITH ranked_ranges AS (
      SELECT
        lab_test_id,
        gender,
        age_min,
        age_max,
        fasting_state,
        cycle_phase,
        is_pregnant,
        range_low,
        range_high,
        range_text,
        unit,
        ROW_NUMBER() OVER (
          PARTITION BY lab_test_id
          ORDER BY priority DESC, gender DESC, age_min ASC
        ) AS row_rank
      FROM lab_test_reference_ranges
      WHERE lab_test_id = ANY($1::uuid[])
    )
    SELECT
      lab_test_id,
      gender,
      age_min,
      age_max,
      fasting_state,
      cycle_phase,
      is_pregnant,
      range_low,
      range_high,
      range_text,
      unit
    FROM ranked_ranges
    WHERE row_rank <= 10
    ORDER BY lab_test_id, row_rank
    `,
    [testIds]
  );

  const rowsByTestId = new Map();
  for (const row of rows) {
    const existing = rowsByTestId.get(row.lab_test_id) || [];
    existing.push(row);
    rowsByTestId.set(row.lab_test_id, existing);
  }

  const displayRangesByTestId = new Map();
  for (const testId of testIds) {
    displayRangesByTestId.set(
      testId,
      formatDisplayRangeRows(rowsByTestId.get(testId) || [])
    );
  }

  return displayRangesByTestId;
}

function normalizeRequestServiceType(value) {
  return String(value || '').trim().toUpperCase();
}

function sanitizeCreateRequestPayload(payload) {
  const requestType = String(payload?.request_type || '').trim().toUpperCase();
  const serviceType = normalizeRequestServiceType(payload?.service_type);
  const isGuest = requestType === 'GUEST';

  return {
    ...payload,
    request_type: requestType,
    patient_id: requestType === 'PATIENT' ? (payload?.patient_id || null) : null,
    guest_name: isGuest ? (payload?.guest_name || null) : null,
    guest_phone: isGuest ? (payload?.guest_phone || null) : null,
    guest_address: isGuest ? (payload?.guest_address || null) : null,
    service_type: serviceType,
    service_id: ['MEDICAL', 'RADIOLOGY'].includes(serviceType) ? (payload?.service_id || null) : null,
    lab_test_id: serviceType === 'LAB' ? (payload?.lab_test_id || null) : null,
    lab_panel_id: serviceType === 'LAB' ? (payload?.lab_panel_id || null) : null,
    lab_package_id: serviceType === 'LAB' ? (payload?.lab_package_id || null) : null,
    package_id: serviceType === 'PACKAGE' ? (payload?.package_id || null) : null,
  };
}

function assertCreateRequestSelection({
  service_type,
  service_id,
  lab_test_id,
  lab_panel_id,
  lab_package_id,
  package_id,
}) {
  if (['MEDICAL', 'RADIOLOGY'].includes(service_type) && !service_id) {
    throw new AppError('service_id is required for this request type', 400, 'SERVICE_ID_REQUIRED');
  }

  if (service_type === 'LAB') {
    const selectedLabTargets = [lab_test_id, lab_panel_id, lab_package_id].filter(Boolean);
    if (selectedLabTargets.length === 0) {
      throw new AppError(
        'lab_test_id, lab_panel_id, or lab_package_id is required for LAB requests',
        400,
        'LAB_TARGET_REQUIRED'
      );
    }

    if (selectedLabTargets.length > 1) {
      throw new AppError('Only one lab target is allowed per LAB request', 400, 'LAB_TARGET_CONFLICT');
    }
  }

  if (service_type === 'PACKAGE' && !package_id) {
    throw new AppError('package_id is required for PACKAGE requests', 400, 'PACKAGE_ID_REQUIRED');
  }
}

async function assertProviderCompletionRequirements({ requestId, currentRequest, providerId, client }) {
  const serviceType = normalizeRequestServiceType(currentRequest?.service_type);
  const latestReport = await requestRepo.getLatestProviderReportForUpdate(requestId, providerId, client);

  if (serviceType === 'LAB') {
    const labResultsCount = await requestRepo.countLabResultsByRequest(requestId, client);
    if (labResultsCount === 0) {
      throw new AppError('You must enter at least one lab result before completing the request', 400, 'REPORT_REQUIRED');
    }
  } else if (serviceType === 'RADIOLOGY') {
    const hasImagingWork = Boolean(
      latestReport && (
        (latestReport.imaging_notes && latestReport.imaging_notes.trim())
        || (latestReport.pdf_report_url && latestReport.pdf_report_url.trim())
      )
    );

    if (!hasImagingWork) {
      throw new AppError('You must add imaging notes or upload a PDF report before completing', 400, 'REPORT_REQUIRED');
    }
  } else if (serviceType === 'NURSING') {
    const hasNursingWork = Boolean(latestReport?.nurse_notes && latestReport.nurse_notes.trim());
    if (!hasNursingWork) {
      throw new AppError('You must add nursing notes before completing', 400, 'REPORT_REQUIRED');
    }
  }
}

async function getServicePrice(client, service_type, service_id, lab_test_id, lab_panel_id, lab_package_id, package_id) {
  return requestRepo.getServicePrice({ // AUDIT-FIX: P3-REQUEST-DIP - service price reads now go through the repository.
    serviceType: service_type, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing service-type routing.
    serviceId: service_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing service-id lookup.
    labTestId: lab_test_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing lab-test lookup.
    labPanelId: lab_panel_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the new lab-panel lookup.
    labPackageId: lab_package_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the new lab-package lookup.
    packageId: package_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing package lookup.
  }, client); // AUDIT-FIX: P3-REQUEST-DIP - reuse the caller transaction when provided.
}

function getPackageTaskTypeForService(serviceRow) {
  const haystack = `${serviceRow?.name || ''} ${serviceRow?.category_name || ''}`.toLowerCase();
  return /(xray|x-ray|radiology|scan|اشعة|أشعة)/i.test(haystack) ? 'RADIOLOGY' : 'MEDICAL';
}

function buildPackageTaskLabel(taskType, items) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (!normalizedItems.length) return taskType;
  if (normalizedItems.length === 1) return normalizedItems[0].name;

  const suffixByType = {
    LAB: 'lab tests',
    RADIOLOGY: 'imaging services',
    MEDICAL: 'medical services',
  };

  return `${normalizedItems.length} ${suffixByType[taskType] || 'items'}`;
}

function buildPackageTaskNotes(taskType, items) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (!normalizedItems.length) return null;

  const titleByType = {
    LAB: 'Included lab tests',
    RADIOLOGY: 'Included scans',
    MEDICAL: 'Included visits',
  };

  return `${titleByType[taskType] || 'Included items'}: ${normalizedItems.map((item) => item.name).join(', ')}`;
}

async function cleanupDeletedRequestAssets(assetRefs = []) {
  const uniqueAssetRefs = [...new Set(
    assetRefs
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];

  if (!uniqueAssetRefs.length) {
    return;
  }

  const cleanupResults = await Promise.allSettled(
    uniqueAssetRefs.map((assetRef) => deleteStoredPdf(assetRef))
  );

  cleanupResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('Failed to remove deleted request asset', {
        assetRef: uniqueAssetRefs[index],
        error: result.reason?.message || 'UNKNOWN_ASSET_DELETE_ERROR',
      });
    }
  });
}

async function getPackageWorkflowComponents(client, packageId) {
  const packageComponents = await requestRepo.getPackageWorkflowComponents(packageId, client); // AUDIT-FIX: P3-REQUEST-DIP - package component reads now go through the repository.
  const tests = packageComponents.tests; // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing grouped task inputs.
  const services = packageComponents.services.map((row) => ({
    ...row,
    service_kind: getPackageTaskTypeForService(row),
  })); // AUDIT-FIX: P3-REQUEST-SRP - package service kind derivation stays in the service layer.

  const groupedTasks = [];
  if (tests.length) {
    groupedTasks.push({
      taskType: 'LAB',
      taskLabel: buildPackageTaskLabel('LAB', tests),
      notes: buildPackageTaskNotes('LAB', tests),
    });
  }

  const imagingServices = services.filter((service) => service.service_kind === 'RADIOLOGY');
  if (imagingServices.length) {
    groupedTasks.push({
      taskType: 'RADIOLOGY',
      taskLabel: buildPackageTaskLabel('RADIOLOGY', imagingServices),
      notes: buildPackageTaskNotes('RADIOLOGY', imagingServices),
    });
  }

  const medicalServices = services.filter((service) => service.service_kind === 'MEDICAL');
  if (medicalServices.length) {
    groupedTasks.push({
      taskType: 'MEDICAL',
      taskLabel: buildPackageTaskLabel('MEDICAL', medicalServices),
      notes: buildPackageTaskNotes('MEDICAL', medicalServices),
    });
  }

  return {
    tests,
    services,
    groupedTasks,
  };
}

async function createRequest(payload) {
  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-REQUEST-DIP - transaction ownership moves to the repository base.
    const normalizedPayload = sanitizeCreateRequestPayload(payload);
    assertCreateRequestSelection(normalizedPayload);

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
    } = normalizedPayload;

    const originalAmount = await getServicePrice(
      client,
      service_type,
      service_id,
      lab_test_id,
      lab_panel_id,
      lab_package_id,
      package_id
    );

    let vipDiscountAmount = 0;
    let patientData = null;
    if (request_type === 'PATIENT' && patient_id) {
      const patientResult = await client.query(
        'SELECT is_vip, vip_discount, total_points FROM patients WHERE id = $1 FOR UPDATE',
        [patient_id]
      );
      patientData = patientResult.rows[0];
      if (patientData?.is_vip && patientData?.vip_discount > 0) {
        vipDiscountAmount = (originalAmount * patientData.vip_discount) / 100;
      }
    }

    let couponId = null;
    let couponDiscountAmount = 0;
    let lockedCouponCode = coupon_code || null;
    if (coupon_code) {
      const couponResult = await validateAndComputeCoupon(coupon_code, originalAmount, client, { reserve: true });
      couponId = couponResult.coupon?.id || null;
      couponDiscountAmount = couponResult.discountAmount;
      lockedCouponCode = couponResult.coupon?.code || coupon_code;
    }

    let pointsUsed = 0;
    let pointsDiscountAmount = 0;
    if (points_to_use && request_type === 'PATIENT' && patientData) {
      const availablePoints = patientData.total_points;
      pointsUsed = Math.min(points_to_use, availablePoints);
      pointsDiscountAmount = pointsUsed * 0.01;
    }

    let finalAmount = originalAmount - vipDiscountAmount - couponDiscountAmount - pointsDiscountAmount;
    if (finalAmount < 0) finalAmount = 0;
    const requestSnapshot = await buildRequestSnapshot(client, normalizedPayload);

    let newRequest = await requestRepo.create({ // AUDIT-FIX: P3-REQUEST-DIP - request inserts now go through the repository layer.
      request_type, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      patient_id: patient_id || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      guest_name, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      guest_phone, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      guest_address, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      service_type, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      service_id: service_id || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      lab_test_id: lab_test_id || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      lab_panel_id: lab_panel_id || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      lab_package_id: lab_package_id || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      package_id: package_id || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      notes, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      requested_at: requested_at || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the normalized request payload.
      patient_full_name_snapshot: requestSnapshot.patient.full_name || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      patient_phone_snapshot: requestSnapshot.patient.phone || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      patient_email_snapshot: requestSnapshot.patient.email || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      patient_address_snapshot: requestSnapshot.patient.address || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      patient_gender_snapshot: requestSnapshot.patient.gender || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      patient_date_of_birth_snapshot: requestSnapshot.patient.date_of_birth || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      patient_age_snapshot: requestSnapshot.patient.age ?? null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      service_name_snapshot: requestSnapshot.service.name || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      service_description_snapshot: requestSnapshot.service.description || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      service_category_name_snapshot: requestSnapshot.service.category_name || null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      service_price_snapshot: requestSnapshot.service.price ?? null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve request snapshot fields.
      package_components_snapshot: requestSnapshot.package_components ? JSON.stringify(requestSnapshot.package_components) : null, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve package snapshot storage.
      coupon_id: couponId, // FEAT: COUPON - freeze the selected coupon on the request row.
      coupon_code: lockedCouponCode, // FEAT: COUPON - persist the locked coupon code for later invoice creation.
      coupon_discount_amount: couponDiscountAmount, // FEAT: COUPON - freeze computed discount on request row.
    }, client);
    try {
      newRequest = (await syncRequestSnapshotPayload(client, newRequest.id)) || newRequest;
    } catch (snapshotErr) {
      // AUDIT-FIX: D2 — snapshot failure is logged but does not fail the request
      // The request is created successfully; snapshot will be rebuilt on next access
      logger.error('Snapshot creation failed after request creation', {
        requestId: newRequest.id,
        error: snapshotErr.message,
      });
      // TODO: add to retry queue when queue system is available
    }

    if (pointsUsed > 0) {
      await requestRepo._exec('UPDATE patients SET total_points = total_points - $1 WHERE id = $2', [pointsUsed, patient_id], client); // AUDIT-FIX: P3-REQUEST-DIP - point-redemption updates now go through the repository executor.
      await requestRepo._exec(
        `
        INSERT INTO points_log (patient_id, points, reason, request_id, note)
        VALUES ($1, $2, 'REDEEMED', $3, 'Points redeemed for discount')
        `,
        [patient_id, -pointsUsed, newRequest.id],
        client
      ); // AUDIT-FIX: P3-REQUEST-DIP - points-log inserts now go through the repository executor.
    }

    if (request_type === 'PATIENT' && patient_id && finalAmount > 0) {
      const pointsEarned = Math.floor(finalAmount);
      const pointsUpdateResult = await requestRepo._execOne(
        'UPDATE patients SET total_points = total_points + $1, updated_at = NOW() WHERE id = $2 RETURNING total_points',
        [pointsEarned, patient_id],
        client
      ); // AUDIT-FIX: P3-REQUEST-DIP - point-earning updates now go through the repository executor.
      await requestRepo._exec(
        `
        INSERT INTO points_log (patient_id, points, reason, request_id, note)
        VALUES ($1, $2, 'EARNED', $3, 'Points earned from request')
        `,
        [patient_id, pointsEarned, newRequest.id],
        client
      ); // AUDIT-FIX: P3-REQUEST-DIP - earned-points log inserts now go through the repository executor.

      if (pointsUpdateResult) {
        notifService.notifyPointsEarned({
          patientId: patient_id,
          points: pointsEarned,
          totalPoints: pointsUpdateResult.total_points,
        }, client).catch((err) => {
          logger.error('Failed to send points earned notification', {
            patientId: patient_id,
            points: pointsEarned,
            error: err.message,
          });
        });
      }
    }

    if (service_type === 'PACKAGE' && package_id) {
      await requestRepo._exec('UPDATE packages SET times_ordered = times_ordered + 1 WHERE id = $1', [package_id], client); // AUDIT-FIX: P3-REQUEST-DIP - package order counters now go through the repository executor.

      const packageComponents = requestSnapshot.package_components || await getPackageWorkflowComponents(client, package_id);
      const taskNotes = [];

      if (packageComponents.lab_tests.length) {
        taskNotes.push(`Lab: ${packageComponents.lab_tests.map((test) => test.name).join(', ')}`);
      }

      const imagingServices = packageComponents.services.filter((service) => service.service_kind === 'RADIOLOGY');
      if (imagingServices.length) {
        taskNotes.push(`Imaging: ${imagingServices.map((service) => service.name).join(', ')}`);
      }

      const medicalServices = packageComponents.services.filter((service) => service.service_kind === 'MEDICAL');
      if (medicalServices.length) {
        taskNotes.push(`Medical: ${medicalServices.map((service) => service.name).join(', ')}`);
      }

      await requestRepo._exec(
        `
        INSERT INTO request_workflow_tasks (
          request_id, provider_id, role, status, task_type, notes, task_label
        )
        VALUES ($1, NULL, 'LEAD_DOCTOR', 'ASSIGNED', 'MEDICAL', $2, $3)
        `,
        [newRequest.id, taskNotes.join(' | ') || null, 'Full Package Service'],
        client
      ); // AUDIT-FIX: P3-REQUEST-DIP - package workflow task inserts now go through the repository executor.

      await workflowService.addLifecycleEvent({
        requestId: newRequest.id,
        actorId: patient_id || null,
        actorRole: request_type === 'PATIENT' ? 'PATIENT' : 'SYSTEM',
        actorName: guest_name || null,
        eventType: 'PACKAGE_TASKS_GENERATED',
        description: 'Unified package workflow task generated',
        metadata: {
          package_id,
          task_type: 'MEDICAL',
          task_label: 'Full Package Service',
          package_components: {
            lab_tests: packageComponents.lab_tests.map((test) => test.name),
            services: packageComponents.services.map((service) => service.name),
          },
        },
        workflowStageSnapshot: newRequest.workflow_stage || null,
      }, client).catch(() => null);
    }

    return {
      request: newRequest,
      invoice: {
        originalAmount,
        vipDiscountAmount,
        couponDiscountAmount,
        pointsDiscountAmount,
        finalAmount,
      },
    }; // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing createRequest return contract.
  }); // AUDIT-FIX: P3-REQUEST-DIP - repository base now commits or rolls back automatically.
}

async function listRequests({
  status,
  page = 1,
  limit = 10,
  patient_id,
  assigned_provider_id,
  provider_scope_id,
  search,
}) {
  const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }, { defaultLimit: 10 }); // AUDIT-FIX: DRY — shared helper now normalizes request-list pagination
  const { data, total } = await requestRepo.findAll({ // AUDIT-FIX: P3-REQUEST-DIP - request list filtering now lives in the repository.
    status, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve existing status filtering.
    patientId: patient_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve existing patient filtering.
    assignedProviderId: assigned_provider_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve existing provider assignment filtering.
    providerScopeId: provider_scope_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve existing provider-scope filtering.
    search, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve existing text search behavior.
  }, { limit: safeLimit, offset }); // AUDIT-FIX: P3-REQUEST-SRP - pagination inputs are passed explicitly to the repository.
  return {
    data, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing response payload shape.
    pagination: paginationMeta(total, safePage, safeLimit), // AUDIT-FIX: DRY — standardized list response shape for request listings
  };
}

async function getRequestById(id, { callerId = null, callerRole = null } = {}) {
  const requestRow = await requestRepo.findById(id); // AUDIT-FIX: P3-REQUEST-DIP - request detail reads now go through the repository.
  if (!requestRow) {
    return null;
  }
  if (callerRole === 'PROVIDER') {
    const allowed = await workflowService.providerHasRequestAccess(id, callerId);
    if (!allowed) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
  }
  if (callerRole === 'PATIENT' && requestRow.patient_id !== callerId) {
    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }

  if (callerRole === 'PATIENT' && requestRow.invoice_id && !requestRow.is_patient_visible) {
    [
      'invoice_id',
      'original_amount',
      'vip_discount_amount',
      'coupon_id',
      'coupon_discount_amount',
      'points_used',
      'points_discount_amount',
      'final_amount',
      'total_paid',
      'remaining_amount',
      'payment_status',
      'payment_status_detail',
      'payment_method',
      'paid_at',
      'invoice_approved_by',
      'invoice_approved_at',
      'is_patient_visible',
    ].forEach((field) => {
      requestRow[field] = null;
    });
  }

  const labResults = await requestRepo.getLabResultsByRequestId(id); // AUDIT-FIX: P3-REQUEST-DIP - lab-result detail reads now go through the repository.

  let packageTests = [];
  let packageServices = [];
  if (requestRow.package_id) {
    const packageSnapshot = normalizePackageComponentsSnapshot(requestRow.package_components_snapshot);
    if (packageSnapshot) {
      packageTests = packageSnapshot.lab_tests.map((test) => ({
        lab_test_id: test.lab_test_id,
        name: test.name,
        unit: test.unit || null,
        reference_range: test.reference_range || null,
      }));
      packageServices = packageSnapshot.services.map((service) => ({
        service_id: service.service_id,
        name: service.name,
        service_kind: service.service_kind,
        category_name: service.category_name,
      }));
    } else {
      const packageComponents = await getPackageWorkflowComponents(getRequestDb(), requestRow.package_id); // AUDIT-FIX: P3-STEP8-DIP - package-component fallback now reuses the injected repository executor instead of pool.
      packageTests = packageComponents.tests.map((test) => ({
        lab_test_id: test.id,
        name: test.name,
        unit: test.unit || null,
        reference_range: test.reference_range || null,
      }));
      packageServices = packageComponents.services.map((service) => ({
        service_id: service.id,
        name: service.name,
        service_kind: service.service_kind,
        category_name: service.category_name,
      }));
    }
  }

  if (packageTests.length) {
    const displayRangesByTestId = await buildPackageDisplayRanges(packageTests);
    packageTests = packageTests.map((test) => {
      const labTestId = test.lab_test_id || test.id;
      const smartRange = labTestId ? displayRangesByTestId.get(labTestId) : null;
      return {
        ...test,
        display_reference_range: smartRange || test.reference_range || null,
      };
    });
  }

  return {
    ...requestRow,
    lab_results: labResults, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing response field shape.
    package_tests: packageTests,
    package_services: packageServices,
  };
}

async function getPatientHistory(requestId, { callerId, callerRole }) {
  const core = await getRequestRepo().getCoreById(requestId);
  if (!core) {
    throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
  }

  if (core.status === 'CLOSED' || core.status === 'CANCELLED') {
    throw new AppError(
      'Access to patient history is not allowed for closed or cancelled requests',
      403,
      'FORBIDDEN'
    );
  }

  if (callerRole === 'PROVIDER') {
    const hasAccess = await workflowService.providerHasRequestAccess(requestId, callerId);
    if (!hasAccess) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }
  }

  const { rows } = await getRequestDb().query(
    `
    SELECT
      sr.id AS request_id,
      sr.service_type,
      sr.closed_at,
      sr.scheduled_at,
      rpr.symptoms_summary,
      rpr.diagnosis,
      rpr.treatment_plan,
      rpr.notes,
      rpr.recommendations,
      COALESCE(rpr.provider_name_snapshot, sp.full_name) AS provider_name
    FROM service_requests sr
    JOIN request_provider_reports rpr ON rpr.request_id = sr.id
    LEFT JOIN service_providers sp ON sp.id = rpr.provider_id
    WHERE sr.patient_id = $1
      AND sr.id != $2
      AND sr.status = 'CLOSED'
    ORDER BY sr.closed_at DESC
    `,
    [core.patient_id, requestId]
  );

  return rows;
}

async function updateRequestStatus({
  id,
  status,
  admin_notes,
  scheduled_at,
  callerRole = null,
  callerId = null,
  collectedAmount = null,
  collectedMethod = null,
  collectedNotes = null,
  allowProviderCompletionTransition = false,
}) {
  const normalizedStatus = status === 'ACCEPTED' ? 'ASSIGNED' : status;

  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-REQUEST-DIP - transaction ownership moves to the repository base.
    if (callerRole === 'PROVIDER') {
      if (!PROVIDER_ALLOWED_STATUSES.includes(normalizedStatus)) {
        throw new AppError(
          `Providers can only set status to: ${PROVIDER_ALLOWED_STATUSES.join(', ')}`,
          403,
          'FORBIDDEN_STATUS'
        );
      }
    }

    const currentRequest = await requestRepo.lockCoreById(id, client); // AUDIT-FIX: P3-REQUEST-DIP - locked request-core reads now go through the repository.
    if (!currentRequest) {
      return null;
    }

    if (callerRole === 'PROVIDER') {
      const canAccess = await workflowService.providerHasRequestAccess(id, callerId, client);
      if (!canAccess) {
        throw new AppError('Access denied', 403, 'FORBIDDEN');
      }

      if (normalizedStatus === 'COMPLETED') {
        const leadProviderId = currentRequest.lead_provider_id;
        const assignedProviderId = currentRequest.assigned_provider_id;
        if (leadProviderId) {
          if (leadProviderId !== callerId) {
            throw new AppError('Only lead doctor can complete this request', 403, 'FORBIDDEN');
          }
        } else if (assignedProviderId && assignedProviderId !== callerId) {
          throw new AppError('Only assigned provider can complete this request', 403, 'FORBIDDEN');
        }

        if (!allowProviderCompletionTransition) {
          throw new AppError(
            'Providers must use the dedicated completion flow to complete requests',
            409,
            'FORBIDDEN_STATUS'
          );
        }

        await assertProviderCompletionRequirements({
          requestId: id,
          currentRequest,
          providerId: callerId,
          client,
        });
      }
    }

    const previousStatus = currentRequest.status;
    const shouldSetCompletedAt = normalizedStatus === 'COMPLETED';
    const shouldSetInProgressAt = normalizedStatus === 'IN_PROGRESS';
    const shouldSetClosedAt = normalizedStatus === 'CLOSED';
    const hasCollectionData = normalizedStatus === 'COMPLETED' && collectedAmount != null;
    const updatedRequest = await requestRepo._execOne(
      `
      UPDATE service_requests SET
        status = $1::request_status,
        admin_notes = COALESCE($2, admin_notes),
        scheduled_at = COALESCE($3, scheduled_at),
        completed_at = CASE WHEN $5 THEN NOW() ELSE completed_at END,
        in_progress_at = CASE WHEN $6 THEN NOW() ELSE in_progress_at END,
        closed_at = CASE WHEN $7 THEN NOW() ELSE closed_at END,
        collected_amount = CASE WHEN $8 THEN $9 ELSE collected_amount END,
        collected_method = CASE WHEN $8 THEN $10 ELSE collected_method END,
        collected_notes = CASE WHEN $8 THEN $11 ELSE collected_notes END,
        collected_at = CASE WHEN $8 THEN NOW() ELSE collected_at END,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [normalizedStatus, admin_notes, scheduled_at, id, shouldSetCompletedAt, shouldSetInProgressAt, shouldSetClosedAt, hasCollectionData, collectedAmount, collectedMethod, collectedNotes],
      client
    ); // AUDIT-FIX: P3-REQUEST-DIP - status updates now go through the repository executor.

    if (updatedRequest && normalizedStatus === 'CANCELLED' && previousStatus !== 'CANCELLED') {
      const invoiceDetails = await client.query(
        `
        SELECT
          id AS invoice_id,
          payment_status AS invoice_payment_status,
          points_used
        FROM invoices
        WHERE request_id = $1
        LIMIT 1
        FOR UPDATE
        `,
        [id]
      );

      const reqData = {
        patient_id: currentRequest.patient_id,
        package_id: currentRequest.package_id,
        ...(invoiceDetails.rows[0] || {}),
      };

      if (reqData) {
        if (reqData.invoice_id && reqData.invoice_payment_status !== 'PAID') {
          await requestRepo._exec(
            `
            UPDATE invoices
            SET payment_status = 'CANCELLED', updated_at = NOW()
            WHERE id = $1
            `,
            [reqData.invoice_id],
            client
          ); // AUDIT-FIX: P3-REQUEST-DIP - cancellation invoice updates now go through the repository executor.
        }

        if (reqData.patient_id && Number(reqData.points_used) > 0) {
          await requestRepo._exec(
            `
            UPDATE patients
            SET total_points = total_points + $1, updated_at = NOW()
            WHERE id = $2
            `,
            [reqData.points_used, reqData.patient_id],
            client
          ); // AUDIT-FIX: P3-REQUEST-DIP - cancellation point refunds now go through the repository executor.

          await requestRepo._exec(
            `
            INSERT INTO points_log (patient_id, points, reason, request_id, note)
            VALUES ($1, $2, 'ADJUSTED', $3, 'Points refunded due to request cancellation')
            `,
            [reqData.patient_id, reqData.points_used, id],
            client
          ); // AUDIT-FIX: P3-REQUEST-DIP - cancellation refund logs now go through the repository executor.
        }

        if (reqData.patient_id) {
          const earnedPoints = await client.query(
            `
            SELECT points
            FROM points_log
            WHERE request_id = $1 AND reason = 'EARNED'
            LIMIT 1
            `,
            [id]
          );

          if (earnedPoints.rows[0]) {
            const pointsToReverse = Number(earnedPoints.rows[0].points);
            if (pointsToReverse > 0) {
              await requestRepo._exec(
                `
                UPDATE patients
                SET total_points = GREATEST(0, total_points - $1), updated_at = NOW()
                WHERE id = $2
                `,
                [pointsToReverse, reqData.patient_id],
                client
              ); // AUDIT-FIX: P3-REQUEST-DIP - earned-point reversals now go through the repository executor.

              await requestRepo._exec(
                `
                INSERT INTO points_log (patient_id, points, reason, request_id, note)
                VALUES ($1, $2, 'ADJUSTED', $3, 'Points reversed due to request cancellation')
                `,
                [reqData.patient_id, -pointsToReverse, id],
                client
              ); // AUDIT-FIX: P3-REQUEST-DIP - earned-point reversal logs now go through the repository executor.
            }
          }
        }

        if (reqData.package_id) {
          await requestRepo._exec(
            `
            UPDATE packages
            SET times_ordered = GREATEST(0, times_ordered - 1)
            WHERE id = $1
            `,
            [reqData.package_id],
            client
          ); // AUDIT-FIX: P3-REQUEST-DIP - package counter reversals now go through the repository executor.
        }
      }
    }

    return updatedRequest;
  }); // AUDIT-FIX: P3-REQUEST-DIP - repository base now commits or rolls back automatically.
}

async function assignProvider({ id, provider_id }) {
  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-REQUEST-DIP - transaction ownership moves to the repository base.
    const requestMeta = await requestRepo.lockCoreById(id, client); // AUDIT-FIX: P3-RACE - lock the request row before evaluating assignment preconditions.
    if (!requestMeta) {
      return null;
    }

    if (requestMeta.service_type === 'PACKAGE') {
      throw new AppError(
        'Package requests must be assigned through workflow tasks',
        409,
        'PACKAGE_ASSIGNMENT_REQUIRES_WORKFLOW'
      );
    }

    if (['CANCELLED', 'CLOSED'].includes(requestMeta.status)) {
      throw new AppError(
        `Cannot assign provider to a ${requestMeta.status.toLowerCase()} request`,
        409,
        'FORBIDDEN_STATUS'
      );
    }

    const updatedRequest = await requestRepo.assignProvider(id, provider_id, client); // AUDIT-FIX: P3-REQUEST-DIP - provider assignment writes now go through the repository.
    if (!updatedRequest) {
      return null;
    }

    await syncRequestProviderSnapshots(client, id);
    return updatedRequest;
  }); // AUDIT-FIX: P3-REQUEST-DIP - repository base now commits or rolls back automatically.
}

async function getPatientForRequest(requestId, db = getRequestDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected request DB instead of config/db.
  return requestRepo.getPatientContextByRequestId(requestId, db); // AUDIT-FIX: P3-REQUEST-DIP - patient context reads now go through the repository.
}

async function upsertLabResultRow(db, {
  requestId,
  lab_test_id,
  result,
  is_normal,
  notes,
  entered_by,
  flag,
  matchedRangeId,
  condition,
}) {
  return requestRepo.upsertLabResultRow({ // AUDIT-FIX: P3-REQUEST-DIP - lab-result upserts now go through the repository.
    requestId, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    lab_test_id, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    result, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    is_normal, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    notes, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    entered_by, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    flag, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    matchedRangeId, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
    condition, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing upsert payload.
  }, db); // AUDIT-FIX: P3-REQUEST-DIP - reuse the current transaction when provided.
}

async function persistLabResult(db, requestId, labResultInput, subject, preloadedRanges = null) {
  const {
    lab_test_id,
    result,
    is_normal,
    notes,
    condition,
    entered_by,
  } = labResultInput;
  const normalizedCondition = condition || null;
  const { gender, age } = resolveEvaluationContext(subject);

  // AUDIT-FIX: P1 — pass preloaded ranges to avoid N+1 queries
  const evaluation = await evaluateResult(lab_test_id, result, {
    gender,
    age,
    condition: normalizedCondition,
  }, preloadedRanges);

  const computedIsNormal = evaluation.flag === 'NO_RANGE' && typeof is_normal === 'boolean'
    ? is_normal
    : evaluation.is_normal;
  const computedFlag = evaluation.flag === 'NO_RANGE' && typeof is_normal === 'boolean'
    ? (is_normal ? 'NORMAL' : 'ABNORMAL')
    : evaluation.flag;

  return upsertLabResultRow(db, {
    requestId,
    lab_test_id,
    result,
    is_normal: computedIsNormal,
    notes,
    entered_by,
    flag: computedFlag,
    matchedRangeId: evaluation.range?.id || null,
    condition: normalizedCondition,
  });
}

async function touchMedicalReportDraft(db, requestId) {
  await requestRepo.touchMedicalReportDraft(requestId, db); // AUDIT-FIX: P3-REQUEST-DIP - draft-report upserts now go through the repository.
}

async function addLabResult({
  id,
  lab_test_id,
  result,
  is_normal,
  notes,
  condition,
  entered_by,
  callerRole = null,
  callerId = null,
}) {
  const requestId = id;

  if (callerRole === 'PROVIDER') {
    const canAccess = await workflowService.providerHasRequestAccess(requestId, callerId);
    if (!canAccess) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
  }

  const subject = await getPatientForRequest(id);
  const dbResult = await persistLabResult(getRequestDb(), requestId, { // AUDIT-FIX: P3-STEP8-DIP - single-result fallback now reuses the injected request DB instead of pool.
    lab_test_id,
    result,
    is_normal,
    notes,
    condition,
    entered_by,
  }, subject);

  await touchMedicalReportDraft(getRequestDb(), requestId); // AUDIT-FIX: P3-STEP8-DIP - draft-report fallback now reuses the injected request DB instead of pool.

  return dbResult;
}

async function addLabResultsBulk({
  id,
  results,
  entered_by,
  callerRole = null,
  callerId = null,
}) {
  const requestId = id;
  const normalizedResults = Array.isArray(results)
    ? results
      .map((item) => ({
        ...item,
        result: typeof item?.result === 'string' ? item.result.trim() : item?.result,
        notes: typeof item?.notes === 'string' ? item.notes.trim() : item?.notes,
      }))
      .filter((item) => item.lab_test_id && typeof item.result === 'string' && item.result.length > 0)
    : [];

  if (!normalizedResults.length) {
    throw new AppError('At least one lab result is required', 400, 'LAB_RESULTS_REQUIRED');
  }

  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-REQUEST-DIP - transaction ownership moves to the repository base.
    if (callerRole === 'PROVIDER') {
      const canAccess = await workflowService.providerHasRequestAccess(requestId, callerId, client);
      if (!canAccess) {
        throw new AppError('Access denied', 403, 'FORBIDDEN');
      }
    }

    const subject = await getPatientForRequest(requestId, client);

    // AUDIT-FIX: P1 — pre-fetch all reference ranges before the loop
    const testIds = normalizedResults.map(r => r.lab_test_id);
    const { rows: allRanges } = await client.query(
      `SELECT * FROM lab_test_reference_ranges
       WHERE lab_test_id = ANY($1::uuid[])
       ORDER BY priority DESC`,
      [testIds]
    );
    const rangesByTestId = allRanges.reduce((map, range) => {
      if (!map[range.lab_test_id]) map[range.lab_test_id] = [];
      map[range.lab_test_id].push(range);
      return map;
    }, {});

    const savedResults = [];
    for (const item of normalizedResults) {
      const preloaded = rangesByTestId[item.lab_test_id] || [];
      // Preserve per-test evaluation while saving the whole panel atomically.
      const row = await persistLabResult(client, requestId, {
        ...item,
        entered_by,
      }, subject, preloaded);
      savedResults.push(row);
    }

    await touchMedicalReportDraft(client, requestId);
    return savedResults;
  }); // AUDIT-FIX: P3-REQUEST-DIP - repository base now commits or rolls back automatically.
}

async function reEvaluateLabResultsForRequest(db, requestId, subject) {
  const columnSupport = await getLabResultColumnsSupport();
  const existingResults = await requestRepo.getLabResultsForReevaluation( // AUDIT-FIX: P3-REQUEST-DIP - reevaluation reads now go through the repository.
    requestId, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the current request scoping.
    { includeCondition: columnSupport.hasCondition }, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve optional condition support.
    db // AUDIT-FIX: P3-REQUEST-DIP - reuse the current transaction when provided.
  );

  const updatedResults = [];
  for (const row of existingResults) {
    const updated = await persistLabResult(db, requestId, {
      lab_test_id: row.lab_test_id,
      result: row.result,
      is_normal: row.is_normal,
      notes: row.notes,
      condition: row.condition,
      entered_by: row.entered_by,
    }, subject);
    updatedResults.push(updated);
  }

  return updatedResults;
}

async function updateGuestDemographics(requestId, data, { callerRole = null, callerId = null } = {}) {
  const normalizedGender = Object.prototype.hasOwnProperty.call(data, 'guest_gender')
    ? (data.guest_gender || null)
    : undefined;
  const normalizedAge = Object.prototype.hasOwnProperty.call(data, 'guest_age')
    ? (data.guest_age === null || data.guest_age === undefined ? null : Number(data.guest_age))
    : undefined;

  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-REQUEST-DIP - transaction ownership moves to the repository base.
    if (callerRole === 'PROVIDER') {
      const canAccess = await workflowService.providerHasRequestAccess(requestId, callerId, client);
      if (!canAccess) {
        throw new AppError('Access denied', 403, 'FORBIDDEN');
      }
    }

    const requestResult = await client.query(
      `
      SELECT id, request_type
      FROM service_requests
      WHERE id = $1
      FOR UPDATE
      `,
      [requestId]
    );

    const requestRow = requestResult.rows[0];
    if (!requestRow) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }
    if (requestRow.request_type !== 'GUEST') {
      throw new AppError('Guest demographics can only be updated for guest requests', 409, 'REQUEST_NOT_GUEST');
    }

    const updates = [];
    const params = [];
    if (normalizedGender !== undefined) {
      params.push(normalizedGender);
      updates.push(`guest_gender = $${params.length}`);
    }
    if (normalizedAge !== undefined) {
      params.push(normalizedAge);
      updates.push(`guest_age = $${params.length}`);
    }

    if (!updates.length) {
      throw new AppError('No guest demographics were provided to update', 400, 'NO_GUEST_DEMOGRAPHIC_UPDATES');
    }

    params.push(requestId);
    const updatedRequest = await requestRepo._execOne(
      `
      UPDATE service_requests
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING id, request_type, guest_gender, guest_age
      `,
      params,
      client
    ); // AUDIT-FIX: P3-REQUEST-DIP - guest-demographic updates now go through the repository executor.

    const subject = await getPatientForRequest(requestId, client);
    const recalculatedLabResults = await reEvaluateLabResultsForRequest(client, requestId, subject);
    if (recalculatedLabResults.length) {
      await touchMedicalReportDraft(client, requestId);
    }

    return {
      ...updatedRequest,
      recalculated_lab_results: recalculatedLabResults.length,
    };
  }); // AUDIT-FIX: P3-REQUEST-DIP - repository base now commits or rolls back automatically.
}

async function updateLabResult(resultId, requestId, data, { callerRole = null, callerId = null } = {}) {
  if (callerRole === 'PROVIDER') {
    const canAccess = await workflowService.providerHasRequestAccess(requestId, callerId);
    if (!canAccess) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
  }

  const columnSupport = await getLabResultColumnsSupport();
  const hasCondition = columnSupport.hasCondition;
  const existing = await requestRepo.getExistingLabResult( // AUDIT-FIX: P3-REQUEST-DIP - existing lab-result reads now go through the repository.
    resultId, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing result-id lookup.
    requestId, // AUDIT-FIX: P3-REQUEST-COMPAT - preserve the existing request scoping.
    { includeCondition: hasCondition } // AUDIT-FIX: P3-REQUEST-COMPAT - preserve optional condition support.
  );
  if (!existing) {
    return null;
  }

  const subject = await getPatientForRequest(requestId);
  const { gender, age } = resolveEvaluationContext(subject);
  const normalizedCondition = Object.prototype.hasOwnProperty.call(data, 'condition')
    ? (data.condition || null)
    : (existing.condition || null);
  const resultValue = Object.prototype.hasOwnProperty.call(data, 'result')
    ? data.result
    : existing.result;

  const evaluation = await evaluateResult(existing.lab_test_id, resultValue, {
    gender,
    age,
    condition: normalizedCondition,
  });

  const hasManualIsNormal = Object.prototype.hasOwnProperty.call(data, 'is_normal');
  const computedIsNormal = evaluation.flag === 'NO_RANGE' && hasManualIsNormal
    ? data.is_normal
    : evaluation.is_normal;
  const computedFlag = evaluation.flag === 'NO_RANGE' && hasManualIsNormal
    ? (data.is_normal ? 'NORMAL' : 'ABNORMAL')
    : evaluation.flag;

  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-REQUEST-DIP - transaction ownership moves to the repository base.
    const updates = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(data, 'result')) {
      params.push(data.result);
      updates.push(`result = $${params.length}`);
    }

    params.push(computedIsNormal);
    updates.push(`is_normal = $${params.length}`);

    if (Object.prototype.hasOwnProperty.call(data, 'notes')) {
      params.push(data.notes);
      updates.push(`notes = $${params.length}`);
    }

    if (hasCondition && Object.prototype.hasOwnProperty.call(data, 'condition')) {
      params.push(normalizedCondition);
      updates.push(`condition = $${params.length}`);
    }

    if (columnSupport.hasFlag) {
      params.push(computedFlag);
      updates.push(`flag = $${params.length}`);
    }

    if (columnSupport.hasMatchedRangeId) {
      params.push(evaluation.range?.id || null);
      updates.push(`matched_range_id = $${params.length}`);
    }

    params.push(resultId);
    params.push(requestId);
    const row = await requestRepo._execOne(
      `
      UPDATE lab_test_results
      SET ${updates.join(', ')}
      WHERE id = $${params.length - 1} AND request_id = $${params.length}
      RETURNING *
      `,
      params,
      client
    ); // AUDIT-FIX: P3-REQUEST-DIP - lab-result updates now go through the repository executor.
    if (!row) {
      return null;
    }

    await touchMedicalReportDraft(client, requestId);

    return row;
  }); // AUDIT-FIX: P3-REQUEST-DIP - repository base now commits or rolls back automatically.
}

async function publishReport(requestId, adminId, adminNotes) {
  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-RACE - keep publish preconditions and writes inside one transaction.
    const requestCore = await requestRepo.lockCoreById(requestId, client);
    if (!requestCore) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }

    const requestRow = await requestRepo.getPublishableRequestState(requestId, client); // AUDIT-FIX: P3-REQUEST-DIP - publish precondition reads now participate in the same transaction.
    if (!requestRow) {
      throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
    }
    if (requestRow.status !== 'COMPLETED') {
      throw new AppError('Request must be COMPLETED before publishing report', 409, 'REQUEST_NOT_COMPLETED');
    }
    if (
      requestRow.lead_provider_id
      && requestRow.lead_provider_type === 'DOCTOR'
      && !requestRow.final_report_confirmed_at
    ) {
      throw new AppError('Final report must be confirmed by lead doctor before publishing', 409, 'FINAL_REPORT_NOT_CONFIRMED');
    }

    const lockedReport = await requestRepo._execOne(
      `
      SELECT id, published_at
      FROM medical_reports
      WHERE request_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [requestId],
      client
    );
    if (!lockedReport) {
      throw new AppError('No report found for this request', 404, 'REPORT_NOT_FOUND');
    }
    if (lockedReport.published_at) {
      throw new AppError('Report already published', 409, 'REPORT_ALREADY_PUBLISHED');
    }

    const row = await requestRepo._execOne(
      `
      UPDATE medical_reports
      SET status = 'PUBLISHED',
          reviewed_by = $2,
          reviewed_at = NOW(),
          published_at = NOW(),
          admin_notes = $3,
          version = version + 1,
          updated_at = NOW()
      WHERE request_id = $1
      RETURNING *,
        (
          SELECT sr.patient_id
          FROM service_requests sr
          WHERE sr.id = medical_reports.request_id
          LIMIT 1
        ) AS patient_id
      `,
      [requestId, adminId, adminNotes || null],
      client
    ); // AUDIT-FIX: P3-REQUEST-DIP - report-publish updates now go through the repository executor.

    await requestRepo._exec(
      `
      UPDATE service_requests
      SET workflow_stage = 'PUBLISHED',
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-REQUEST-DIP - workflow-stage publish updates now go through the repository executor.

    await workflowService.addLifecycleEvent({
      requestId,
      actorId: adminId,
      actorRole: 'ADMIN',
      actorName: null,
      eventType: 'PUBLISHED',
      description: 'Final report published',
      metadata: {},
      workflowStageSnapshot: 'PUBLISHED',
    }).catch(() => null);

    await notifService.notifyReportPublished(requestId, row.patient_id).catch((err) => {
      logger.error('Failed to send report published notification', {
        requestId,
        patientId: row.patient_id,
        error: err.message,
      });
    });

    return row;
  });
}

async function getReportStatus(requestId) {
  return requestRepo.getReportStatus(requestId); // AUDIT-FIX: P3-REQUEST-DIP - report status reads now go through the repository.
}

async function requestExists(id) {
  return requestRepo.existsById(id); // AUDIT-FIX: P3-REQUEST-DIP - existence checks now go through the repository.
}

async function saveRequestFiles({ requestId, uploadedBy, uploaderRole, files }) {
  return requestRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-REQUEST-DIP - transaction ownership moves to the repository base.
    return requestRepo.saveRequestFiles({ requestId, uploadedBy, uploaderRole, files }, client); // AUDIT-FIX: P3-REQUEST-DIP - request-file inserts now go through the repository.
  }); // AUDIT-FIX: P3-REQUEST-DIP - repository base now commits or rolls back automatically.
}

async function getRequestForRating(id) {
  return requestRepo.getRequestForRating(id); // AUDIT-FIX: P3-REQUEST-DIP - rating precondition reads now go through the repository.
}

async function getRequestRating(id) {
  return requestRepo.getRequestRating(id); // AUDIT-FIX: P3-REQUEST-DIP - request rating reads now go through the repository.
}

async function createRequestRating({ requestId, patientId, rating, comment }) {
  return requestRepo.createRequestRating({ requestId, patientId, rating, comment }); // AUDIT-FIX: P3-REQUEST-DIP - request-rating inserts now go through the repository.
}

async function getProviderById(id) {
  return requestRepo.getProviderById(id); // AUDIT-FIX: P3-REQUEST-DIP - provider reads now go through the repository.
}

async function getProviderRatingsSummary(providerId) {
  return requestRepo.getProviderRatingsSummary(providerId); // AUDIT-FIX: P3-REQUEST-DIP - provider rating summaries now go through the repository.
}

async function getProviderRatingsCount(providerId) {
  return requestRepo.getProviderRatingsCount(providerId); // AUDIT-FIX: P3-REQUEST-DIP - provider rating counts now go through the repository.
}

async function getProviderRatings(providerId, limit, offset) {
  return requestRepo.getProviderRatings(providerId, limit, offset); // AUDIT-FIX: P3-REQUEST-DIP - provider rating lists now go through the repository.
}

async function getInvoiceForRequest(requestId) {
  return requestRepo.getInvoiceForRequest(requestId); // AUDIT-FIX: P3-REQUEST-DIP - request invoice reads now go through the repository.
}

async function ensureMedicalReportRecord(requestId, client = getRequestDb()) { // AUDIT-FIX: P3-STEP8-DIP - helper default now uses injected request DB instead of config/db.
  return requestRepo.ensureMedicalReportRecord(requestId, client); // AUDIT-FIX: P3-REQUEST-DIP - medical report record upserts now go through the repository.
}

async function deleteRequest(id) {
  let assetRefs = [];

  const deletedRequest = await requestRepo.withTransaction(async (client) => {
    const deletionContext = await requestRepo.getRequestDeletionContext(id, client);
    if (!deletionContext) {
      return null;
    }

    assetRefs = await requestRepo.getRequestDeletionAssets(id, client);

    if (deletionContext.patient_id && Number(deletionContext.points_net_effect) !== 0) {
      await requestRepo._exec(
        `
        UPDATE patients
        SET total_points = GREATEST(0, total_points - $1),
            updated_at = NOW()
        WHERE id = $2
        `,
        [Number(deletionContext.points_net_effect), deletionContext.patient_id],
        client
      );
    }

    if (deletionContext.coupon_id) {
      await requestRepo._exec(
        `
        UPDATE coupons
        SET used_count = GREATEST(0, used_count - 1)
        WHERE id = $1
        `,
        [deletionContext.coupon_id],
        client
      );
    }

    if (
      deletionContext.service_type === 'PACKAGE'
      && deletionContext.package_id
      && deletionContext.status !== 'CANCELLED'
    ) {
      await requestRepo._exec(
        `
        UPDATE packages
        SET times_ordered = GREATEST(0, times_ordered - 1)
        WHERE id = $1
        `,
        [deletionContext.package_id],
        client
      );
    }

    await requestRepo.deletePointsLogsByRequestId(id, client);
    await requestRepo.deleteInvoicesByRequestId(id, client);

    return requestRepo.delete(id, client);
  });

  if (!deletedRequest) {
    return null;
  }

  await cleanupDeletedRequestAssets(assetRefs);

  return deletedRequest;
}

module.exports = {
  createRequest,
  listRequests,
  getRequestById,
  getPatientHistory,
  updateRequestStatus,
  updateGuestDemographics,
  assignProvider,
  addLabResult,
  addLabResultsBulk,
  updateLabResult,
  publishReport,
  getReportStatus,
  requestExists,
  saveRequestFiles,
  getRequestForRating,
  getRequestRating,
  createRequestRating,
  getProviderById,
  getProviderRatingsSummary,
  getProviderRatingsCount,
  getProviderRatings,
  getInvoiceForRequest,
  ensureMedicalReportRecord,
  deleteRequest,
  configureRequestService, // AUDIT-FIX: P3-STEP8-DIP - expose explicit singleton wiring for route-level composition roots.
};
