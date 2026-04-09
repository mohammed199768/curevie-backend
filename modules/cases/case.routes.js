const express = require('express');
const {
  authenticate,
  adminOnly,
  staffOnly,
  patientOnly,
} = require('../../middlewares/auth');
const pool = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const ChatRepository = require('../../repositories/ChatRepository');
const caseController = require('./case.controller');
const reportRoutes = require('./case-report.routes');

const router = express.Router();
const chatRepo = new ChatRepository(pool);

router.get('/health', (req, res) => {
  res.json({ status: 'cases module ok' });
});

router.post('/', authenticate, patientOnly, caseController.createCase);
router.get('/', authenticate, caseController.listCases);
router.get('/:id', authenticate, caseController.getCaseById);
router.post('/:id/assign-team', authenticate, adminOnly, caseController.assignTeam);
router.post('/:id/appointments', authenticate, adminOnly, caseController.addAppointment);
router.post('/:id/close', authenticate, adminOnly, caseController.closeCase);
router.get('/:id/chat-rooms', authenticate, asyncHandler(async (req, res) => {
  const caseResult = await pool.query(
    'SELECT id, patient_id FROM cases WHERE id = $1 LIMIT 1',
    [req.params.id]
  );
  const currentCase = caseResult.rows[0];

  if (!currentCase) {
    return res.status(404).json({ message: 'Case not found', code: 'NOT_FOUND' });
  }

  if (req.user.role === 'PATIENT' && currentCase.patient_id !== req.user.id) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  let rooms = [];

  if (req.user.role === 'PATIENT') {
    const patientRooms = await chatRepo.findRoomsByPatient(req.user.id);
    rooms = patientRooms.filter((room) => room.case_id === req.params.id);
  } else if (req.user.role === 'ADMIN') {
    rooms = await chatRepo.findRoomsByCase(req.params.id);
  } else if (req.user.role === 'PROVIDER') {
    const caseRooms = await chatRepo.findRoomsByCase(req.params.id);
    rooms = caseRooms.filter((room) => room.provider_id === req.user.id);
  }

  return res.json({ data: rooms });
}));
router.get('/chat/rooms/:room_id/messages', authenticate, asyncHandler(async (req, res) => {
  const room = await chatRepo.findRoomById(req.params.room_id);

  if (!room) {
    return res.status(404).json({ message: 'Room not found', code: 'NOT_FOUND' });
  }

  const canAccess =
    req.user.role === 'ADMIN' ||
    (req.user.role === 'PATIENT' && room.patient_id === req.user.id) ||
    (req.user.role === 'PROVIDER' && room.provider_id === req.user.id);

  if (!canAccess) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  const messages = await chatRepo.getMessages(room.id, {
    limit: req.query.limit || 50,
    before: req.query.before || null,
  });
  await chatRepo.markAsRead(room.id, req.user.id);

  return res.json({ data: messages });
}));

router.use('/', reportRoutes);

module.exports = router;
