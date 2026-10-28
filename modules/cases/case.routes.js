const express = require('express');
const {
  authenticate,
  guestOrAuthenticated,
  adminOnly,
  providerOnly,
  patientOnly,
} = require('../../middlewares/auth');
const { apiLimiter, readLimiter, guestRequestLimiter, trackLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const caseService = require('./case.service');
const schemas = require('./case.schemas');
const chatRoutes = require('./case-chat.routes');
const fileRoutes = require('./case-files.routes');
const invoiceRoutes = require('./case-invoice.routes');
const reportRoutes = require('./case-report.routes');

const router = express.Router();

const patientOrAdmin = (req, res, next) => {
  if (['PATIENT', 'ADMIN'].includes(req.user.role)) return next();
  return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
};

// ------------------------------------------------------------------ ordering

// Guest order (or a logged-in patient using the public form).
router.post(
  '/public',
  guestOrAuthenticated,
  guestRequestLimiter,
  validate(schemas.createGuestCaseSchema),
  asyncHandler(async (req, res) => {
    const user = req.user?.role === 'PATIENT' ? req.user : null;
    const result = await caseService.createCase(user, req.body);
    return res.status(201).json({ message: 'Case created', data: result });
  })
);

router.post(
  '/',
  authenticate,
  patientOnly,
  apiLimiter,
  validate(schemas.createCaseSchema),
  asyncHandler(async (req, res) => {
    const result = await caseService.createCase(req.user, req.body);
    return res.status(201).json({ message: 'Case created', data: result });
  })
);

router.get(
  '/track/:token',
  trackLimiter,
  validate(schemas.trackingParams, 'params'),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ data: await caseService.trackCase(req.params.token) });
  })
);

router.post(
  '/claim',
  authenticate,
  patientOnly,
  apiLimiter,
  validate(schemas.claimSchema),
  asyncHandler(async (req, res) => {
    const result = await caseService.claimCase(req.user, req.body.tracking_token);
    return res.json({ message: 'Order added to your account', data: result });
  })
);

router.get(
  '/',
  authenticate,
  readLimiter,
  validate(schemas.listCasesQuerySchema, 'query'),
  asyncHandler(async (req, res) => res.json({ data: await caseService.listCases(req.user, req.query) }))
);

// Sub-routers are mounted before "/:id" so "/chat/..." and "/invoices" are not read as case ids.
router.use('/chat', chatRoutes);
router.use('/', invoiceRoutes);
router.use('/', fileRoutes);
router.use('/', reportRoutes);

router.get(
  '/:id',
  authenticate,
  readLimiter,
  validate(schemas.caseIdParams, 'params'),
  asyncHandler(async (req, res) => res.json({ data: await caseService.getCaseDetail(req.params.id, req.user) }))
);

// ------------------------------------------------------------------ admin

router.get(
  '/:id/services/:serviceId/candidates',
  authenticate,
  adminOnly,
  readLimiter,
  validate(schemas.caseServiceParams, 'params'),
  validate(schemas.candidatesQuerySchema, 'query'),
  asyncHandler(async (req, res) => res.json({
    data: await caseService.getCandidates(req.params.id, req.params.serviceId, { includeAll: req.query.include_all }),
  }))
);

router.post(
  '/:id/assign-team',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  validate(schemas.assignTeamSchema),
  asyncHandler(async (req, res) => res.json({
    message: 'Team assigned',
    data: await caseService.assignTeam(req.params.id, req.body, req.user),
  }))
);

router.post(
  '/:id/appointments',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  validate(schemas.appointmentSchema),
  asyncHandler(async (req, res) => res.status(201).json({
    message: 'Appointment added',
    data: await caseService.addAppointment(req.params.id, req.user, req.body),
  }))
);

router.post(
  '/:id/services/:serviceId/cancel',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(schemas.caseServiceParams, 'params'),
  validate(schemas.reasonSchema),
  asyncHandler(async (req, res) => res.json({
    message: 'Service cancelled',
    data: await caseService.cancelService(req.params.id, req.params.serviceId, req.user, req.body.reason),
  }))
);

router.post(
  '/:id/close',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  validate(schemas.closeCaseSchema),
  asyncHandler(async (req, res) => res.json({
    message: 'Case closed',
    data: await caseService.closeCase(req.params.id, req.user, req.body.notes),
  }))
);

// Patient (before work starts) or admin.
router.post(
  '/:id/cancel',
  authenticate,
  patientOrAdmin,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  validate(schemas.reasonSchema),
  asyncHandler(async (req, res) => res.json({
    message: 'Case cancelled',
    data: await caseService.cancelCase(req.params.id, req.user, req.body.reason),
  }))
);

// ------------------------------------------------------------------ provider workflow

for (const action of ['accept', 'start', 'complete']) {
  router.put(
    `/:id/services/:serviceId/${action}`,
    authenticate,
    providerOnly,
    apiLimiter,
    validate(schemas.caseServiceParams, 'params'),
    asyncHandler(async (req, res) => res.json({
      data: await caseService.providerTransition(req.params.id, req.params.serviceId, req.user, action),
    }))
  );
}

router.put(
  '/:id/services/:serviceId/reject',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(schemas.caseServiceParams, 'params'),
  validate(schemas.rejectSchema),
  asyncHandler(async (req, res) => res.json({
    data: await caseService.providerTransition(req.params.id, req.params.serviceId, req.user, 'reject', {
      reason: req.body.reason,
    }),
  }))
);

// ------------------------------------------------------------------ patient

router.post(
  '/:id/services/:serviceId/rate',
  authenticate,
  patientOnly,
  apiLimiter,
  validate(schemas.caseServiceParams, 'params'),
  validate(schemas.rateSchema),
  asyncHandler(async (req, res) => res.status(201).json({
    message: 'Thank you for your rating',
    data: await caseService.rateService(req.params.id, req.params.serviceId, req.user, req.body),
  }))
);

router.get(
  '/:id/chat-rooms',
  authenticate,
  readLimiter,
  validate(schemas.caseIdParams, 'params'),
  asyncHandler(async (req, res) => {
    await caseService.loadAccessibleCase(req.params.id, req.user);
    const rooms = await caseService.chatRepo.listRoomsForUser(req.user, { caseId: req.params.id });
    return res.json({ data: rooms });
  })
);

module.exports = router;
