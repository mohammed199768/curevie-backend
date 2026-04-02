'use strict';

const express = require('express');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const pool = require('../../config/db');
const AnalyticsEventRepository = require('../../repositories/AnalyticsEventRepository');
const analyticsServiceModule = require('./analytics.service');
const controller = require('./analytics.controller');

const router = express.Router();
const analyticsEventRepo = new AnalyticsEventRepository(pool);
analyticsServiceModule.configureAnalyticsService(analyticsEventRepo);

router.use((req, res, next) => {
  req.analyticsService = analyticsServiceModule;
  next();
});

router.post('/events', apiLimiter, asyncHandler(controller.ingestAnalyticsEvent));
router.get('/summary', authenticate, adminOnly, readLimiter, asyncHandler(controller.getSummary));
router.get('/trend', authenticate, adminOnly, readLimiter, asyncHandler(controller.getDailyTrend));
router.get('/service-interest', authenticate, adminOnly, readLimiter, asyncHandler(controller.getServiceInterest));
router.get('/top-paths', authenticate, adminOnly, readLimiter, asyncHandler(controller.getTopPaths));

module.exports = router;
