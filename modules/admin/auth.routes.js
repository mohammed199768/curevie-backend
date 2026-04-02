const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate } = require('../../middlewares/auth');
const { authLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const { loginSchema, registerSchema, changePasswordSchema } = require('../../utils/schemas'); // FIX: F13 — refresh/logout no longer validate a body refresh_token because it comes from the cookie.
const asyncHandler = require('../../utils/asyncHandler');
const pool = require('../../config/db'); // AUDIT-FIX: P3-STEP8-DIP - auth routes are now the composition root for the auth repository singleton.
const AuthRepository = require('../../repositories/AuthRepository'); // AUDIT-FIX: P3-STEP8-DIP - auth routes now wire the concrete auth repository explicitly.
const authServiceModule = require('./auth.service'); // AUDIT-FIX: P3-STEP8-DIP - auth routes configure the auth service singleton before controllers use it.
authServiceModule.configureAuthService(new AuthRepository(pool)); // AUDIT-FIX: P3-STEP8-DIP - auth routes inject the pool-backed repository explicitly instead of auth.service requiring config/db.
const authController = require('./auth.controller'); // AUDIT-FIX: P3-STEP8-DIP - controller loads after singleton composition so its auth-service dependency stays backward compatible.

const router = express.Router();

router.post('/login', authLimiter, validate(loginSchema), asyncHandler(authController.login));
router.post('/register', authLimiter, validate(registerSchema), asyncHandler(authController.register));
router.post('/refresh', authLimiter, asyncHandler(authController.refresh)); // FIX: F13 — read the refresh token from the httpOnly cookie instead of the request body.
router.post(
  '/logout',
  authenticate,
  authLimiter,
  asyncHandler(authController.logout)
);
router.post('/logout-all', authenticate, authLimiter, asyncHandler(authController.logoutAll));
router.put(
  '/change-password',
  authenticate,
  authLimiter,
  validate(changePasswordSchema),
  asyncHandler(authController.changePassword)
);
router.get('/me', authenticate, readLimiter, asyncHandler(authController.me));

module.exports = router;
