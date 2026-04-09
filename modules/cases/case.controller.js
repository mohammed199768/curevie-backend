const pool = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const CaseService = require('./case.service');

const caseService = new CaseService(pool);

const createCase = asyncHandler(async (req, res) => {
  const result = await caseService.createCase(req.user.id, req.body);
  return res.status(201).json({ message: 'Case created', data: result });
});

const getCaseById = asyncHandler(async (req, res) => {
  const result = await caseService.getCaseById(req.params.id, req.user);
  return res.status(200).json({ data: result });
});

const listCases = asyncHandler(async (req, res) => {
  const result = await caseService.listCases(req.user, req.query);
  return res.status(200).json({ data: result });
});

const assignTeam = asyncHandler(async (req, res) => {
  if (Array.isArray(req.body.assignments) && req.body.lead_provider_id) {
    req.body.assignments.lead_provider_id = req.body.lead_provider_id;
  }

  const result = await caseService.assignTeam(req.params.id, req.body.assignments, req.user.id);
  return res.status(200).json({ message: 'Team assigned', data: result });
});

const addAppointment = asyncHandler(async (req, res) => {
  const result = await caseService.addAppointment(req.params.id, req.body, req.user.id);
  return res.status(201).json({ message: 'Appointment added', data: result });
});

const closeCase = asyncHandler(async (req, res) => {
  const result = await caseService.closeCase(req.params.id, req.user.id, req.body.notes);
  return res.status(200).json({ message: 'Case closed', data: result });
});

module.exports = {
  createCase,
  getCaseById,
  listCases,
  assignTeam,
  addAppointment,
  closeCase,
};
