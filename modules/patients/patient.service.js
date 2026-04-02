const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace duplicated bounds and metadata logic

function createPatientService(patientRepo) {
  async function createPatient(data) {
    return patientRepo.createPatient(data);
  }

  async function listPatients({ page, limit, search }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — use shared offset calculation for patient lists
    return patientRepo.list({ search }, { limit, offset });
  }

  async function getPatientById(id) {
    return patientRepo.getById(id);
  }

  async function getPatientHistory(id, { page = 1, limit = 20 } = {}) {
    const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — centralize page/limit sanitizing for history pagination

    const { data, total } = await patientRepo.getHistory(id, { limit: safeLimit, offset });
    return { // AUDIT-FIX: DRY — expose standardized pagination metadata while preserving existing top-level fields for compatibility
      data,
      total,
      page: safePage,
      limit: safeLimit,
      pagination: paginationMeta(total, safePage, safeLimit),
    };
  }

  async function getPatientHistoryCount(id) {
    return patientRepo.getHistoryCount(id);
  }

  async function getRecentPatientRequests(id) {
    return patientRepo.getRecentRequests(id);
  }

  async function updatePatientMedical(id, data) {
    return patientRepo.updateMedical(id, data);
  }

  async function updatePatientProfile(id, data) {
    return patientRepo.updateProfile(id, data);
  }

  async function patientExists(id) {
    return patientRepo.exists(id);
  }

  async function addPatientHistory({ id, note, createdByAdmin, createdByProvider }) {
    return patientRepo.addHistory({
      patientId: id,
      note,
      createdByAdmin,
      createdByProvider,
    });
  }

  async function updatePatientVip(id, { is_vip, vip_discount }) {
    return patientRepo.updateVip(id, is_vip, vip_discount);
  }

  async function deletePatient(id) {
    return patientRepo.deletePatient(id);
  }

  async function getPatientAvatarInfo(id) {
    return patientRepo.getAvatarInfo(id);
  }

  async function updatePatientAvatar(id, avatarUrl) {
    return patientRepo.updateAvatar(id, avatarUrl);
  }

  async function getPatientPointsLog(id, { page = 1, limit = 20 } = {}) {
    const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — reuse shared pagination bounds for points log queries

    const { data, total } = await patientRepo.getPointsLog(id, { limit: safeLimit, offset });
    return {
      data,
      pagination: paginationMeta(total, safePage, safeLimit), // AUDIT-FIX: DRY — standardized pagination shape via shared helper
    };
  }

  return {
    createPatient,
    listPatients,
    getPatientById,
    getPatientHistory,
    getPatientHistoryCount,
    getRecentPatientRequests,
    updatePatientMedical,
    updatePatientProfile,
    patientExists,
    addPatientHistory,
    updatePatientVip,
    deletePatient,
    getPatientAvatarInfo,
    updatePatientAvatar,
    getPatientPointsLog,
  };
}

module.exports = { createPatientService };
