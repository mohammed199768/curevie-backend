const express = require('express');
const {
  authenticate,
  adminOnly,
  staffOnly,
  patientOnly,
} = require('../../middlewares/auth');
const caseController = require('./case.controller');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ status: 'cases module ok' });
});

router.post('/', authenticate, patientOnly, caseController.createCase);
router.get('/', authenticate, caseController.listCases);
router.get('/:id', authenticate, caseController.getCaseById);
router.post('/:id/assign-team', authenticate, adminOnly, caseController.assignTeam);
router.post('/:id/appointments', authenticate, adminOnly, caseController.addAppointment);
router.post('/:id/close', authenticate, adminOnly, caseController.closeCase);

module.exports = router;
