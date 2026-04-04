const express = require('express');
const { authenticate } = require('../../middlewares/auth');
const asyncHandler = require('../../utils/asyncHandler');
const { getSecureUrl } = require('./files.controller');

const router = express.Router();

router.get('/secure-url', authenticate, asyncHandler(getSecureUrl));

module.exports = router;
