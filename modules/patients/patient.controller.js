const { logger, audit } = require('../../utils/logger');
const { isBunnyConfigured, uploadToBunny, deleteFromBunny } = require('../../utils/bunny');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace manual patient list metadata

function createPatientController(patientService, notifService) {
  async function listPatients(req, res) {
    const { page, limit, search } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize list pagination once per request
    const { data, total } = await patientService.listPatients({ page, limit, search });

    return res.json({
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape via shared helper
    });
  }

  async function getPatient(req, res) {
    const patient = await patientService.getPatientById(req.params.id);
    if (!patient) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    const { page: historyPage, limit: historyLimit } = paginate({ // AUDIT-FIX: DRY — use shared helper for embedded history pagination bounds
      page: req.query.history_page,
      limit: req.query.history_limit,
    });

    const [history, recent_requests] = await Promise.all([
      patientService.getPatientHistory(req.params.id, { page: historyPage, limit: historyLimit }),
      patientService.getRecentPatientRequests(req.params.id),
    ]);

    return res.json({
      patient,
      history: history.data,
      recent_requests,
      history_pagination: {
        page: history.page,
        limit: history.limit,
        total: history.total,
        total_pages: Math.ceil(history.total / history.limit),
      },
      history_has_more: history.page * history.limit < history.total,
    });
  }

  async function getPatientHistory(req, res) {
    const exists = await patientService.patientExists(req.params.id);
    if (!exists) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    const result = await patientService.getPatientHistory(req.params.id, req.query);
    return res.json(result);
  }

  async function getPatientPointsLog(req, res) {
    const exists = await patientService.patientExists(req.params.id);
    if (!exists) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    const result = await patientService.getPatientPointsLog(req.params.id, req.query);
    return res.json(result);
  }

  async function updateMedical(req, res) {
    const result = await patientService.updatePatientMedical(req.params.id, req.body);
    if (result.noUpdates) {
      return res.status(400).json({ message: 'No medical fields provided', code: 'NO_UPDATES' });
    }
    if (!result.row) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }
    return res.json(result.row);
  }

  async function updateProfile(req, res) {
    const result = await patientService.updatePatientProfile(req.params.id, req.body);
    if (result.noUpdates) {
      return res.status(400).json({ message: 'No profile fields provided', code: 'NO_UPDATES' });
    }
    if (!result.row) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }
    return res.json(result.row);
  }

  async function addHistory(req, res) {
    const exists = await patientService.patientExists(req.params.id);
    if (!exists) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    const createdByAdmin = req.user.role === 'ADMIN' ? req.user.id : null;
    const createdByProvider = req.user.role === 'PROVIDER' ? req.user.id : null;

    const row = await patientService.addPatientHistory({
      id: req.params.id,
      note: req.body.note,
      createdByAdmin,
      createdByProvider,
    });

    audit('PATIENT_HISTORY_ADDED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'patient',
      ip: req.ip,
    });

    return res.status(201).json(row);
  }

  async function updateVip(req, res) {
    const row = await patientService.updatePatientVip(req.params.id, req.body);
    if (!row) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    const { is_vip, vip_discount } = req.body;
    audit('PATIENT_VIP_UPDATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'patient',
      ip: req.ip,
      details: { is_vip, vip_discount: is_vip ? vip_discount : 0 },
    });

    await notifService.notifyVipGranted({
      patientId: req.params.id,
      discount: req.body.vip_discount,
    }).catch((err) => {
      logger.error('Failed to send VIP granted notification', {
        patientId: req.params.id,
        error: err.message,
      });
    });

    return res.json(row);
  }

  async function deletePatient(req, res) {
    const row = await patientService.deletePatient(req.params.id);
    if (!row) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    audit('PATIENT_DELETED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'patient',
      ip: req.ip,
    });

    return res.json({ message: 'Patient deleted successfully', patient: row });
  }

  async function uploadAvatar(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required', code: 'NO_FILE' });
    }

    if (!isBunnyConfigured()) {
      return res.status(503).json({ message: 'Media service not configured', code: 'MEDIA_NOT_CONFIGURED' });
    }

    const patient = await patientService.getPatientAvatarInfo(req.params.id);
    if (!patient) {
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    }

    const avatarUrl = await uploadToBunny(req.file.buffer, req.file.originalname, 'patients/avatars');
    if (!avatarUrl) {
      return res.status(502).json({ message: 'Failed to upload media', code: 'MEDIA_UPLOAD_FAILED' });
    }

    const updated = await patientService.updatePatientAvatar(req.params.id, avatarUrl);

    if (patient.avatar_url) {
      try {
        const deleted = await deleteFromBunny(patient.avatar_url);
        if (deleted === false) {
          logger.warn('Failed to delete previous patient avatar from Bunny', {
            patientId: req.params.id,
            oldUrl: patient.avatar_url,
            newUrl: avatarUrl,
          });
        }
      } catch (err) {
        logger.warn('Failed to delete previous patient avatar from Bunny', {
          patientId: req.params.id,
          oldUrl: patient.avatar_url,
          newUrl: avatarUrl,
          error: err.message,
        });
      }
    }

    audit('PATIENT_AVATAR_UPDATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'patient',
      ip: req.ip,
    });

    return res.json(updated);
  }

  return {
    listPatients,
    getPatient,
    getPatientHistory,
    getPatientPointsLog,
    updateMedical,
    updateProfile,
    addHistory,
    updateVip,
    deletePatient,
    uploadAvatar,
  };
}

module.exports = { createPatientController };
