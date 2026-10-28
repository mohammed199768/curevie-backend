const pool = require('../../config/db');
const PatientRepository = require('../../repositories/PatientRepository');
const AuthRepository = require('../../repositories/AuthRepository');
const notificationService = require('../notifications/notification.service');
const { AppError } = require('../../middlewares/errorHandler');
const { audit } = require('../../utils/logger');
const { paginate, paginationMeta } = require('../../utils/pagination');
const { uploadPublicMedia, deletePublicMedia, toPublicMediaUrl } = require('../../utils/storage');

const patientRepo = new PatientRepository(pool);
const authRepo = new AuthRepository(pool);

function present(patient) {
  return patient ? { ...patient, avatar_url: toPublicMediaUrl(patient.avatar_url) } : patient;
}

function auditPatient(req, action, details) {
  audit(action, {
    userId: req.user.id,
    role: req.user.role,
    targetId: req.params.id,
    targetType: 'patient',
    ip: req.ip,
    details,
  });
}

/**
 * Access policy for one patient record:
 *   ADMIN    always
 *   PATIENT  only their own record (when allowSelf)
 *   PROVIDER only patients they serve (openOnly: an active case right now)
 * Everyone else gets 404 so patient ids cannot be probed.
 */
function patientAccess({ allowSelf = true, allowProvider = false, openOnly = false } = {}) {
  return async (req, res, next) => {
    try {
      const { role, id } = req.user;
      if (role === 'ADMIN') return next();
      if (role === 'PATIENT' && allowSelf && id === req.params.id) return next();
      if (role === 'PROVIDER' && allowProvider
        && await patientRepo.providerServesPatient(id, req.params.id, { openOnly })) {
        return next();
      }
      return res.status(404).json({ message: 'Patient not found', code: 'PATIENT_NOT_FOUND' });
    } catch (err) {
      return next(err);
    }
  };
}

async function requireExisting(id) {
  if (!(await patientRepo.exists(id))) throw new AppError('Patient not found', 404, 'PATIENT_NOT_FOUND');
}

async function listPatients(req, res) {
  const { page, limit, offset } = paginate(req.query);
  const { data, total } = await patientRepo.list({ search: req.query.search }, { limit, offset });
  return res.json({ data: data.map(present), pagination: paginationMeta(total, page, limit) });
}

async function listCombinedPatients(req, res) {
  const { page, limit, offset } = paginate(req.query, { defaultLimit: 20 });
  const { data, total } = await patientRepo.listCombined({ search: req.query.search }, { limit, offset });
  return res.json({ data, pagination: paginationMeta(total, page, limit) });
}

async function getPatient(req, res) {
  const patient = await patientRepo.getById(req.params.id);
  if (!patient) throw new AppError('Patient not found', 404, 'PATIENT_NOT_FOUND');

  const response = { patient: present(patient) };
  if (req.user.role !== 'PATIENT') {
    const history = await patientRepo.getHistory(req.params.id, { limit: 20, offset: 0 });
    response.history = history.data;
    response.history_total = history.total;
  }
  if (req.user.role === 'ADMIN' || req.user.role === 'PATIENT') {
    const cases = await patientRepo.getRecentCases(req.params.id);
    response.recent_cases = cases.data;
    response.total_cases = cases.total;
  }
  return res.json(response);
}

async function getPatientHistory(req, res) {
  await requireExisting(req.params.id);
  const { page, limit, offset } = paginate(req.query, { defaultLimit: 20 });
  const { data, total } = await patientRepo.getHistory(req.params.id, { limit, offset });
  return res.json({ data, pagination: paginationMeta(total, page, limit) });
}

async function addHistory(req, res) {
  await requireExisting(req.params.id);
  const row = await patientRepo.addHistory({
    patientId: req.params.id,
    note: req.body.note,
    createdByAdmin: req.user.role === 'ADMIN' ? req.user.id : null,
    createdByProvider: req.user.role === 'PROVIDER' ? req.user.id : null,
  });
  auditPatient(req, 'PATIENT_HISTORY_ADDED');
  return res.status(201).json(row);
}

async function updateMedical(req, res) {
  await requireExisting(req.params.id);
  const result = await patientRepo.updateMedical(req.params.id, req.body);
  if (result.noUpdates) return res.status(400).json({ message: 'No medical fields provided', code: 'NO_UPDATES' });
  auditPatient(req, 'PATIENT_MEDICAL_UPDATED', Object.keys(req.body));
  return res.json(present(await patientRepo.getById(req.params.id)));
}

async function updateProfile(req, res) {
  await requireExisting(req.params.id);
  if (req.body.area_id) {
    const { rows } = await pool.query('SELECT 1 FROM areas WHERE id = $1 AND is_active = TRUE', [req.body.area_id]);
    if (!rows[0]) throw new AppError('Selected area is not served', 400, 'INVALID_AREA');
  }
  const result = await patientRepo.updateProfile(req.params.id, req.body);
  if (result.noUpdates) return res.status(400).json({ message: 'No profile fields provided', code: 'NO_UPDATES' });
  auditPatient(req, 'PATIENT_PROFILE_UPDATED', Object.keys(req.body));
  return res.json(present(await patientRepo.getById(req.params.id)));
}

async function updateVip(req, res) {
  const row = await patientRepo.updateVip(req.params.id, req.body.is_vip, req.body.vip_discount);
  if (!row) throw new AppError('Patient not found', 404, 'PATIENT_NOT_FOUND');
  auditPatient(req, 'PATIENT_VIP_UPDATED', { is_vip: row.is_vip, vip_discount: row.vip_discount });

  if (row.is_vip) {
    notificationService.notifySafely('vip_granted', () => notificationService.notifyVipGranted({
      patientId: row.id,
      discount: Number(row.vip_discount),
    }));
  }
  return res.json(row);
}

async function deletePatient(req, res) {
  const row = await patientRepo.softDelete(req.params.id);
  if (!row) throw new AppError('Patient not found', 404, 'PATIENT_NOT_FOUND');
  await authRepo.revokeAllUserTokens(row.id, 'PATIENT');
  auditPatient(req, 'PATIENT_DELETED');
  return res.json({ message: 'Patient deleted successfully', patient: row });
}

async function uploadAvatar(req, res) {
  if (!req.file) throw new AppError('Image file is required', 400, 'NO_FILE');
  const patient = await patientRepo.getAvatarInfo(req.params.id);
  if (!patient) throw new AppError('Patient not found', 404, 'PATIENT_NOT_FOUND');

  const avatarUrl = await uploadPublicMedia(req.file.buffer, { folder: 'patients/avatars', mimeType: req.file.mimetype });
  if (!avatarUrl) throw new AppError('Media service not configured', 503, 'MEDIA_NOT_CONFIGURED');

  const updated = await patientRepo.updateAvatar(req.params.id, avatarUrl);
  if (patient.avatar_url) await deletePublicMedia(patient.avatar_url);
  auditPatient(req, 'PATIENT_AVATAR_UPDATED');
  return res.json(present(updated));
}

module.exports = {
  patientAccess,
  listPatients,
  listCombinedPatients,
  getPatient,
  getPatientHistory,
  addHistory,
  updateMedical,
  updateProfile,
  updateVip,
  deletePatient,
  uploadAvatar,
};
