'use strict';

const express = require('express');
const { authenticate, staffOnly, adminOnly, providerOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { upsertCultureSchema } = require('../../utils/schemas');
const controller = require('./culture.controller');

const router = express.Router({ mergeParams: true });

router.get('/',
  authenticate, staffOnly, readLimiter,
  asyncHandler(controller.getCultureResult)
);

router.put('/',
  authenticate, staffOnly, apiLimiter,
  validate(upsertCultureSchema),
  asyncHandler(controller.upsertCultureResult)
);

router.delete('/',
  authenticate, adminOnly, apiLimiter,
  asyncHandler(controller.deleteCultureResult)
);

module.exports = router;
