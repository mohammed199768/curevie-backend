const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, guestOrAuthenticated } = require('../../middlewares/auth');
const {
  loginLimiter,
  loginAccountLimiter,
  registerLimiter,
  refreshLimiter,
  logoutLimiter,
  accountActionLimiter,
  readLimiter,
} = require('../../middlewares/rateLimiter');
const { loginSchema, registerSchema, changePasswordSchema } = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');
const authController = require('./auth.controller');

const router = express.Router();

router.post('/login', loginLimiter, loginAccountLimiter, validate(loginSchema), asyncHandler(authController.login));
router.post('/register', registerLimiter, validate(registerSchema), asyncHandler(authController.register));
router.post('/refresh', refreshLimiter, asyncHandler(authController.refresh));
router.post('/logout', guestOrAuthenticated, logoutLimiter, asyncHandler(authController.logout));
router.post('/logout-all', authenticate, accountActionLimiter, asyncHandler(authController.logoutAll));
router.put(
  '/change-password',
  authenticate,
  accountActionLimiter,
  validate(changePasswordSchema),
  asyncHandler(authController.changePassword)
);
router.get('/me', authenticate, readLimiter, asyncHandler(authController.me));

module.exports = router;
