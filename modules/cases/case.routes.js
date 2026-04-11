const express = require('express');
const {
  authenticate,
  guestOrAuthenticated,
  adminOnly,
  providerOnly,
  staffOnly,
  patientOnly,
} = require('../../middlewares/auth');
const multer = require('multer');
const pool = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const ChatRepository = require('../../repositories/ChatRepository');
const CaseService = require('./case.service');
const caseController = require('./case.controller');
const reportRoutes = require('./case-report.routes');

const router = express.Router();
const chatRepo = new ChatRepository(pool);
const caseService = new CaseService(pool);
const upload = multer({ storage: multer.memoryStorage() });

router.get('/health', (req, res) => {
  res.json({ status: 'cases module ok' });
});

router.post('/public', guestOrAuthenticated, asyncHandler(async (req, res) => {
  const { guest_name, guest_phone, guest_address, services, notes } = req.body || {};

  if (!guest_name || !guest_phone || !services?.length) {
    return res.status(400).json({ error: 'guest_name, guest_phone, and services are required' });
  }

  const result = await caseService.createGuestCase({
    guest_name,
    guest_phone,
    guest_address,
    services,
    notes,
  });

  return res.status(201).json({ message: 'Case created', data: result });
}));

router.post('/', authenticate, patientOnly, caseController.createCase);
router.get('/', authenticate, caseController.listCases);
router.get('/:id', authenticate, caseController.getCaseById);
router.post(
  '/:id/services/:serviceId/files',
  authenticate,
  providerOnly,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { caseId, serviceId } = { caseId: req.params.id, serviceId: req.params.serviceId };
    const file = req.file;
    const is_sick_leave = req.body.is_sick_leave === 'true';

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { logger } = require('../../utils/logger');
    const path = require('path');
    const fs = require('fs');
    const uploadDir = '/app/uploads/case-files';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const fileName = `${Date.now()}-${file.originalname}`;
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, file.buffer);
    const fileUrl = `/uploads/case-files/${fileName}`;

    const fileType = file.mimetype === 'application/pdf' ? 'PDF' : 'IMAGE';

    const { rows } = await pool.query(
      `INSERT INTO case_provider_files 
        (case_service_id, file_url, file_type, is_sick_leave, uploaded_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [serviceId, fileUrl, fileType, is_sick_leave, req.user.id]
    );

    return res.status(201).json({ data: rows[0] });
  })
);
router.put(
  '/:id/services/:serviceId/start',
  authenticate,
  providerOnly,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE case_services 
       SET status = 'IN_PROGRESS', updated_at = NOW()
       WHERE id = $1 AND case_id = $2 AND provider_id = $3
       RETURNING *`,
      [req.params.serviceId, req.params.id, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Service not found or access denied' });
    }

    await pool.query(
      `UPDATE cases SET status = 'IN_PROGRESS', updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('COMPLETED', 'CLOSED', 'CANCELLED')`,
      [req.params.id]
    );

    return res.json({ data: rows[0] });
  })
);
router.put(
  '/:id/services/:serviceId/complete',
  authenticate,
  providerOnly,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE case_services 
       SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND case_id = $2 AND provider_id = $3
       RETURNING *`,
      [req.params.serviceId, req.params.id, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Service not found or access denied' });
    }

    const { rows: allServices } = await pool.query(
      `SELECT status FROM case_services WHERE case_id = $1`,
      [req.params.id]
    );
    const allDone = allServices.every((s) =>
      s.status === 'COMPLETED' || s.status === 'CANCELLED'
    );
    if (allDone) {
      await pool.query(
        `UPDATE cases SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
    }

    return res.json({ data: rows[0] });
  })
);
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
