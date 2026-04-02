const express = require('express');
const {
  authenticate,
  guestOrAuthenticated,
  adminOnly,
  staffOnly,
} = require('../../middlewares/auth');
const { apiLimiter, readLimiter, guestRequestLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const pool = require('../../config/db'); // AUDIT-FIX: P3-STEP7F-DIP - request routes are now the composition root for concrete DB-backed dependencies.
const RequestRepository = require('../../repositories/RequestRepository'); // AUDIT-FIX: P3-STEP7F-DIP - request routes now wire the concrete request repository explicitly.
const WorkflowRepository = require('../../repositories/WorkflowRepository'); // AUDIT-FIX: P3-STEP7F-DIP - request routes now wire the concrete workflow repository explicitly.
const RequestLifecycleService = require('./request.lifecycle.service'); // AUDIT-FIX: P3-STEP7F-DIP - request routes now wire the extracted lifecycle orchestration explicitly.
const requestService = require('./request.service'); // AUDIT-FIX: P3-STEP7F-DIP - request routes inject the existing request service singleton into lifecycle orchestration.
const workflowService = require('./request.workflow.service'); // AUDIT-FIX: P3-STEP7F-DIP - request routes inject the existing workflow service singleton into lifecycle orchestration.
const invoiceService = require('../invoices/invoice.service'); // AUDIT-FIX: P3-STEP7F-DIP - request routes inject invoice orchestration dependencies explicitly.
const paymentService = require('../payments/payment.service'); // AUDIT-FIX: P3-STEP7F-DIP - request routes inject payment orchestration dependencies explicitly.
const notificationService = require('../notifications/notification.service'); // AUDIT-FIX: P3-STEP7F-DIP - request routes inject notification orchestration dependencies explicitly.
const {
  createRequestSchema,
  requestsListQuerySchema,
  updateStatusSchema,
  updateGuestDemographicsSchema,
  assignProviderSchema,
  rateRequestSchema,
  providerRatingsQuerySchema,
  addLabResultSchema,
  bulkAddLabResultsSchema,
  updateLabResultSchema,
  requestWorkflowTaskAssignSchema,
  requestWorkflowTaskUpdateSchema,
  requestWorkflowStageUpdateSchema,
  requestAdditionalOrderSchema,
  requestProviderReportSchema,
  requestFinalReportConfirmSchema,
  closeRequestSchema,
  recordPaymentSchema,
  requestIdParamSchema,
  requestTaskParamsSchema,
  requestResultParamsSchema,
  requestChatRoomTypeParamsSchema,
  requestChatRoomIdParamsSchema,
  requestPaymentApprovalParamsSchema,
  requestLifecycleQuerySchema,
  requestChatMessagesQuerySchema,
  requestChatMessageSchema,
  completeWithPaymentSchema,
} = require('../../utils/schemas');
// AUDIT-FIX: S2 — import magic bytes validators alongside upload middleware
const {
  uploadRequestFiles, uploadSingleChatMedia, uploadSinglePdf,
  validateImageContents, validatePdfContents, validateRequestFileContents,
  validateChatMediaContents,
} = require('../../utils/upload');
const requestControllerModule = require('./request.controller'); // AUDIT-FIX: P3-STEP7F-DIP - routes now request a configured controller instead of a self-composed singleton.

const requestRepo = new RequestRepository(pool); // AUDIT-FIX: P3-STEP7F-DIP - request routes own the concrete request repository instance.
const workflowRepo = new WorkflowRepository(pool); // AUDIT-FIX: P3-STEP7F-DIP - request routes own the concrete workflow repository instance.
requestService.configureRequestService(requestRepo); // AUDIT-FIX: P3-STEP8-DIP - request routes now inject the concrete request repository into the request service singleton explicitly.
workflowService.configureWorkflowService(workflowRepo); // AUDIT-FIX: P3-STEP8-DIP - request routes now inject the concrete workflow repository into the workflow service singleton explicitly.
const lifecycleService = new RequestLifecycleService({ requestRepo, workflowRepo, requestService, workflowService, notificationService, invoiceService, paymentService, snapshotUtil: require('../../utils/requestSnapshots'), storageUtil: require('../../utils/bunny') }); // AUDIT-FIX: P3-STEP7F-DIP - request routes compose the extracted lifecycle service explicitly.
const requestController = requestControllerModule.createRequestController({ requestRepo, lifecycleService }); // AUDIT-FIX: P3-STEP7F-DIP - request routes inject the configured lifecycle service into the controller.

const router = express.Router();

const requireAuthForPatientRequest = (req, res, next) => {
  if (req.body.request_type === 'PATIENT' && !req.user) {
    return res.status(401).json({ message: 'No token provided', code: 'NO_TOKEN' });
  }
  if (
    req.body.request_type === 'PATIENT'
    && req.user
    && req.user.role === 'PATIENT'
    && req.body.patient_id
    && req.body.patient_id !== req.user.id
  ) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }
  return next();
};

const applyGuestRequestLimiter = (req, res, next) => {
  if (req.user) {
    return next();
  }
  return guestRequestLimiter(req, res, next);
};

const hydratePatientIdFromToken = (req, res, next) => {
  if (
    req.user
    && req.user.role === 'PATIENT'
    && req.body.request_type === 'PATIENT'
    && !req.body.patient_id
  ) {
    req.body.patient_id = req.user.id;
  }
  return next();
};

const staffOrPatient = (req, res, next) => {
  if (['ADMIN', 'PROVIDER', 'PATIENT'].includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
};

const providerOnly = (req, res, next) => {
  if (req.user.role === 'PROVIDER') return next();
  return res.status(403).json({ message: 'Provider access required', code: 'FORBIDDEN' });
};

router.post(
  '/',
  guestOrAuthenticated,
  applyGuestRequestLimiter,
  hydratePatientIdFromToken,
  validate(createRequestSchema),
  requireAuthForPatientRequest,
  asyncHandler(requestController.createRequest)
);
router.get(
  '/',
  authenticate,
  staffOrPatient,
  validate(requestsListQuerySchema, 'query'),
  asyncHandler(requestController.listRequests)
);

router.post(
  '/:id/files',
  authenticate,
  staffOnly,
  apiLimiter,
  uploadRequestFiles,
  // AUDIT-FIX: S2 — magic bytes check for request files (images + PDF)
  validateRequestFileContents,
  asyncHandler(requestController.uploadRequestFiles)
);

router.post(
  '/:id/rate',
  authenticate,
  apiLimiter,
  validate(rateRequestSchema),
  asyncHandler(requestController.rateRequest)
);

router.get(
  '/providers/:id/ratings',
  authenticate,
  staffOnly,
  readLimiter,
  validate(providerRatingsQuerySchema, 'query'),
  asyncHandler(requestController.getProviderRatings)
);

router.get(
  '/:id',
  authenticate,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.getRequestById)
);
router.put(
  '/:id/guest-demographics',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(updateGuestDemographicsSchema),
  asyncHandler(requestController.updateGuestDemographics)
);

router.get(
  '/:id/workflow',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.getWorkflowOverview)
);
router.put(
  '/:id/workflow-stage',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(requestWorkflowStageUpdateSchema),
  asyncHandler(requestController.updateWorkflowStage)
);
router.get(
  '/:id/tasks',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.listWorkflowTasks)
);
router.post(
  '/:id/team/assign',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(requestWorkflowTaskAssignSchema),
  asyncHandler(requestController.assignWorkflowTask)
);
router.post(
  '/:id/tasks',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(requestWorkflowTaskAssignSchema),
  asyncHandler(requestController.assignWorkflowTask)
);
router.put(
  '/:id/tasks/:taskId/accept',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(requestTaskParamsSchema, 'params'),
  validate(requestWorkflowTaskUpdateSchema),
  asyncHandler(requestController.acceptWorkflowTask)
);
router.put(
  '/:id/tasks/:taskId/unaccept',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(requestTaskParamsSchema, 'params'),
  validate(requestWorkflowTaskUpdateSchema),
  asyncHandler(requestController.unacceptWorkflowTask)
);
router.put(
  '/:id/tasks/:taskId/submit',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(requestTaskParamsSchema, 'params'),
  validate(requestWorkflowTaskUpdateSchema),
  asyncHandler(requestController.submitWorkflowTask)
);

router.get(
  '/:id/orders',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.listAdditionalOrders)
);
router.post(
  '/:id/orders',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(requestAdditionalOrderSchema),
  asyncHandler(requestController.createAdditionalOrder)
);

router.get(
  '/:id/provider-reports',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.listProviderReports)
);
router.post(
  '/:id/provider-reports',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(requestProviderReportSchema),
  asyncHandler(requestController.upsertProviderReport)
);
router.post(
  '/:id/provider-reports/pdf-upload',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  uploadSinglePdf,
  // AUDIT-FIX: S2 — magic bytes check for PDF uploads
  validatePdfContents,
  asyncHandler(requestController.uploadProviderReportPdf)
);
router.put(
  '/:id/final-report/confirm',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(requestFinalReportConfirmSchema),
  asyncHandler(requestController.confirmFinalReport)
);

router.get(
  '/:id/lifecycle',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(requestLifecycleQuerySchema, 'query'),
  asyncHandler(requestController.listLifecycleEvents)
);

router.get(
  '/:id/chat/:roomType/messages',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestChatRoomTypeParamsSchema, 'params'),
  validate(requestChatMessagesQuerySchema, 'query'),
  asyncHandler(requestController.listRequestChatMessages)
);
router.get(
  '/:id/chat/rooms',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.listRequestChatRooms)
);
router.get(
  '/:id/chat/rooms/:roomId/messages',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestChatRoomIdParamsSchema, 'params'),
  validate(requestChatMessagesQuerySchema, 'query'),
  asyncHandler(requestController.listRequestChatMessagesByRoomId)
);
router.post(
  '/:id/chat/:roomType/messages',
  authenticate,
  staffOrPatient,
  apiLimiter,
  uploadSingleChatMedia,
  // AUDIT-FIX: S2 — magic bytes check for chat image uploads
  validateChatMediaContents,
  validate(requestChatRoomTypeParamsSchema, 'params'),
  validate(requestChatMessageSchema),
  asyncHandler(requestController.sendRequestChatMessage)
);
router.post(
  '/:id/chat/rooms/:roomId/messages',
  authenticate,
  staffOrPatient,
  apiLimiter,
  uploadSingleChatMedia,
  // AUDIT-FIX: S2 — magic bytes check for chat image uploads
  validateChatMediaContents,
  validate(requestChatRoomIdParamsSchema, 'params'),
  validate(requestChatMessageSchema),
  asyncHandler(requestController.sendRequestChatMessageByRoomId)
);

router.put(
  '/:id/start',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.startRequest)
);
router.put(
  '/:id/complete',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.completeRequest)
);
router.put(
  '/:id/complete-with-payment',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(completeWithPaymentSchema),
  asyncHandler(requestController.completeWithPayment)
);
router.put(
  '/:id/close',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(closeRequestSchema),
  asyncHandler(requestController.closeRequest)
);
router.post(
  '/:id/payments',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(recordPaymentSchema),
  asyncHandler(requestController.recordPayment)
);
router.get(
  '/:id/payments',
  authenticate,
  staffOnly,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.listPayments)
);
router.get(
  '/:id/patient-history',
  authenticate,
  staffOnly,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.getPatientHistory)
);
router.put(
  '/:id/payments/:paymentId/approve',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestPaymentApprovalParamsSchema, 'params'),
  asyncHandler(requestController.approvePaymentRecord)
);

router.put(
  '/:id/status',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(updateStatusSchema),
  asyncHandler(requestController.updateRequestStatus)
);
router.put(
  '/:id/assign',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  validate(assignProviderSchema),
  asyncHandler(requestController.assignProvider)
);
router.post(
  '/:id/results',
  authenticate,
  staffOnly,
  validate(requestIdParamSchema, 'params'),
  validate(addLabResultSchema),
  asyncHandler(requestController.addLabResult)
);
router.post(
  '/:id/results/bulk',
  authenticate,
  staffOnly,
  validate(requestIdParamSchema, 'params'),
  validate(bulkAddLabResultsSchema),
  asyncHandler(requestController.addLabResultsBulk)
);

router.put(
  '/:id/results/:resultId',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(requestResultParamsSchema, 'params'),
  validate(updateLabResultSchema),
  asyncHandler(requestController.updateLabResult)
);

router.post(
  '/:id/report/publish',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.publishReport)
);

router.get(
  '/:id/report',
  authenticate,
  staffOrPatient,
  readLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.getReportStatus)
);
router.delete(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(requestIdParamSchema, 'params'),
  asyncHandler(requestController.deleteRequest)
);

module.exports = router;
