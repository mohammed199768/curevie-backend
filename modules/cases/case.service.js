const { AppError } = require('../../middlewares/errorHandler');
const CaseRepository = require('../../repositories/CaseRepository');

class CaseService {
  constructor(pool) {
    this.pool = pool;
    this.caseRepo = new CaseRepository(pool);
  }

  _normalizePagination(query = {}) {
    return {
      page: Math.max(Number(query.page) || 1, 1),
      limit: Math.max(Number(query.limit) || 10, 1),
    };
  }

  _normalizeServiceItem(item = {}) {
    const originalPrice = Number(item.original_price);
    const bundlePrice = Number(item.bundle_price);

    if (!item.service_id) {
      throw new AppError('service_id is required for each case service', 400, 'SERVICE_ID_REQUIRED');
    }
    if (!Number.isFinite(originalPrice)) {
      throw new AppError('original_price is required for each case service', 400, 'ORIGINAL_PRICE_REQUIRED');
    }
    if (!Number.isFinite(bundlePrice)) {
      throw new AppError('bundle_price is required for each case service', 400, 'BUNDLE_PRICE_REQUIRED');
    }

    return {
      service_id: item.service_id,
      original_price: originalPrice,
      bundle_price: bundlePrice,
      notes: item.notes || null,
    };
  }

  async createCase(patientId, body) {
    const servicesInput = body?.services;
    if (!Array.isArray(servicesInput) || servicesInput.length < 1) {
      throw new AppError('services array must contain at least one item', 400, 'SERVICES_REQUIRED');
    }

    const servicesData = servicesInput.map((item) => this._normalizeServiceItem(item));
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const createdCase = await this.caseRepo.createCase({
        patient_id: patientId || null,
        package_id: body?.package_id || null,
        notes: body?.notes || null,
        guest_name: body?.guest_name || null,
        guest_phone: body?.guest_phone || null,
        guest_address: body?.guest_address || null,
      }, client);

      const createdServices = [];
      for (const service of servicesData) {
        const createdService = await this.caseRepo.addCaseService({
          case_id: createdCase.id,
          service_id: service.service_id,
          original_price: service.original_price,
          bundle_price: service.bundle_price,
          notes: service.notes,
        }, client);
        createdServices.push(createdService);
      }

      const originalAmount = servicesData.reduce((sum, service) => sum + service.bundle_price, 0);
      const invoice = await this.caseRepo.createInvoice({
        case_id: createdCase.id,
        original_amount: originalAmount,
      }, client);

      await this.caseRepo.addLifecycleEvent({
        case_id: createdCase.id,
        actor_id: patientId,
        actor_role: 'PATIENT',
        event_type: 'CASE_CREATED',
        notes: body?.notes || null,
      }, client);

      await client.query('COMMIT');
      return {
        case: createdCase,
        services: createdServices,
        invoice,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createGuestCase(body) {
    const guestName = body?.guest_name?.trim?.() || body?.guest_name || null;
    const guestPhone = body?.guest_phone?.trim?.() || body?.guest_phone || null;
    const servicesInput = body?.services;

    if (!guestName || !guestPhone || !Array.isArray(servicesInput) || servicesInput.length < 1) {
      throw new AppError(
        'guest_name, guest_phone, and services are required',
        400,
        'GUEST_CASE_FIELDS_REQUIRED'
      );
    }

    return this.createCase(null, {
      ...body,
      guest_name: guestName,
      guest_phone: guestPhone,
      guest_address: body?.guest_address || null,
    });
  }

  async getCaseById(caseId, requestingUser) {
    const currentCase = await this.caseRepo.findCaseById(caseId);
    if (!currentCase) {
      throw new AppError('Case not found', 404, 'NOT_FOUND');
    }

    if (requestingUser.role === 'PATIENT' && currentCase.patient_id !== requestingUser.id) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }

    const [services, appointments, providerFiles] = await Promise.all([
      this.caseRepo.findServicesByCase(caseId),
      this.caseRepo.findAppointmentsByCase(caseId),
      this.caseRepo.findProviderFilesByCase(caseId),
    ]);

    const servicesWithFiles = services.map((service) => ({
      ...service,
      provider_files: providerFiles.filter((f) => f.case_service_id === service.id),
    }));

    return {
      case: currentCase,
      services: servicesWithFiles,
      appointments,
      provider_files: providerFiles,
    };
  }

  async listCases(requestingUser, query = {}) {
    const { page, limit } = this._normalizePagination(query);

    if (requestingUser.role === 'PATIENT') {
      const result = await this.caseRepo.findCasesByPatient(requestingUser.id, { page, limit });
      return { cases: result.cases, total: result.total, page, limit };
    }

    if (requestingUser.role === 'ADMIN') {
      const result = await this.caseRepo.findAllCases({
        page,
        limit,
        status: query.status || null,
        patient_id: query.patient_id || null,
      });
      return { cases: result.cases, total: result.total, page, limit };
    }

    if (requestingUser.role === 'PROVIDER') {
      const offset = (page - 1) * limit;
      const [rowsResult, countResult] = await Promise.all([
        this.pool.query(
          `
          SELECT DISTINCT c.*
          FROM cases c
          JOIN case_services cs ON cs.case_id = c.id
          WHERE cs.provider_id = $1
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3
          `,
          [requestingUser.id, limit, offset]
        ),
        this.pool.query(
          `
          SELECT COUNT(DISTINCT c.id)::int AS total
          FROM cases c
          JOIN case_services cs ON cs.case_id = c.id
          WHERE cs.provider_id = $1
          `,
          [requestingUser.id]
        ),
      ]);

      return {
        cases: rowsResult.rows,
        total: countResult.rows[0]?.total || 0,
        page,
        limit,
      };
    }

    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }

  async assignTeam(caseId, assignments, adminId) {
    if (!Array.isArray(assignments) || assignments.length < 1) {
      throw new AppError('assignments array must contain at least one item', 400, 'ASSIGNMENTS_REQUIRED');
    }

    const leadProviderId = assignments.lead_provider_id || null;
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const currentCase = await this.caseRepo.findCaseById(caseId, client);
      if (!currentCase) {
        throw new AppError('Case not found', 404, 'NOT_FOUND');
      }

      for (const assignment of assignments) {
        if (!assignment.case_service_id || !assignment.provider_id) {
          throw new AppError('case_service_id and provider_id are required for each assignment', 400, 'INVALID_ASSIGNMENT');
        }

        const serviceResult = await client.query(
          'SELECT id FROM case_services WHERE id = $1 AND case_id = $2 LIMIT 1',
          [assignment.case_service_id, caseId]
        );
        if (!serviceResult.rows[0]) {
          throw new AppError('Case service not found for this case', 404, 'CASE_SERVICE_NOT_FOUND');
        }

        await this.caseRepo.assignProvider(assignment.case_service_id, assignment.provider_id, client);
        await this.caseRepo.addLifecycleEvent({
          case_id: caseId,
          actor_id: adminId,
          actor_role: 'ADMIN',
          event_type: 'PROVIDER_ASSIGNED',
          notes: `Assigned provider ${assignment.provider_id} to case service ${assignment.case_service_id}`,
        }, client);
      }

      if (leadProviderId) {
        await this.caseRepo.setLeadProvider(caseId, leadProviderId, client);
      }

      await this.caseRepo.updateCaseStatus(caseId, 'ACCEPTED', client);

      const updatedCase = await this.caseRepo.findCaseById(caseId, client);
      const services = await this.caseRepo.findServicesByCase(caseId, client);

      await client.query('COMMIT');
      return {
        case: updatedCase,
        services,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async addAppointment(caseId, data, adminId) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const serviceResult = await client.query(
        'SELECT id FROM case_services WHERE id = $1 AND case_id = $2 LIMIT 1',
        [data?.case_service_id, caseId]
      );
      if (!serviceResult.rows[0]) {
        throw new AppError('Case service not found for this case', 404, 'CASE_SERVICE_NOT_FOUND');
      }

      const appointment = await this.caseRepo.addAppointment({
        case_service_id: data.case_service_id,
        scheduled_at: data.scheduled_at,
        type: data.type || 'INITIAL',
        notes: data.notes || null,
        created_by: adminId,
      }, client);

      await this.caseRepo.addLifecycleEvent({
        case_id: caseId,
        actor_id: adminId,
        actor_role: 'ADMIN',
        event_type: 'APPOINTMENT_SCHEDULED',
        notes: data.notes || null,
      }, client);

      await client.query('COMMIT');
      return appointment;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async closeCase(caseId, adminId, notes) {
    const existingCase = await this.caseRepo.findCaseById(caseId);
    if (!existingCase) {
      throw new AppError('Case not found', 404, 'NOT_FOUND');
    }
    if (!['COMPLETED', 'IN_PROGRESS'].includes(existingCase.status)) {
      throw new AppError('Case can only be closed from COMPLETED or IN_PROGRESS state', 400, 'INVALID_CASE_STATUS');
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await this.caseRepo.closeCase(caseId, adminId, notes || null, client);

      const services = await this.caseRepo.findServicesByCase(caseId, client);
      const invoiceResult = await client.query(
        'SELECT * FROM case_invoices WHERE case_id = $1 LIMIT 1',
        [caseId]
      );
      const invoice = invoiceResult.rows[0] || null;

      let packageData = null;
      if (existingCase.package_id) {
        const packageResult = await client.query(
          'SELECT * FROM packages WHERE id = $1 LIMIT 1',
          [existingCase.package_id]
        );
        packageData = packageResult.rows[0] || null;
      }

      const providersMap = new Map();
      services.forEach((service) => {
        if (service.provider_id) {
          providersMap.set(service.provider_id, {
            provider_id: service.provider_id,
            provider_name: service.provider_name,
            provider_type: service.provider_type,
          });
        }
      });

      const snapshot = await this.caseRepo.createSnapshot({
        case_id: caseId,
        patient_data: {
          id: existingCase.patient_id,
          full_name: existingCase.patient_name,
          phone: existingCase.patient_phone,
          date_of_birth: existingCase.patient_dob,
          gender: existingCase.patient_gender,
          allergies: existingCase.patient_allergies,
        },
        services_data: services,
        providers_data: Array.from(providersMap.values()),
        invoice_data: invoice,
        package_data: packageData,
      }, client);

      await client.query(
        `
        UPDATE case_invoices
        SET is_patient_visible = TRUE, updated_at = NOW()
        WHERE case_id = $1
        `,
        [caseId]
      );

      await this.caseRepo.addLifecycleEvent({
        case_id: caseId,
        actor_id: adminId,
        actor_role: 'ADMIN',
        event_type: 'CASE_CLOSED',
        notes: notes || null,
      }, client);

      const closedCase = await this.caseRepo.findCaseById(caseId, client);

      await client.query('COMMIT');
      return {
        ...closedCase,
        snapshot_id: snapshot.id,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = CaseService;
