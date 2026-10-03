// Auth route definitions — wires HTTP verbs/paths to controller functions
const express = require('express');
const authController = require('../controllers/auth.controller');
const authGuard = require('../middlewares/auth.middleware');
const { authLimiter } = require('../middlewares/rateLimit.middleware');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// rate-limited: these are exactly the endpoints a credential-stuffing/brute-force attempt would hit
router.post('/register', authLimiter, asyncHandler(authController.register));
router.post('/login', authLimiter, asyncHandler(authController.login));
router.post('/refresh', authLimiter, asyncHandler(authController.refresh));
router.post('/logout', asyncHandler(authController.logout));
router.get('/me', authGuard, asyncHandler(authController.me));

module.exports = router;
