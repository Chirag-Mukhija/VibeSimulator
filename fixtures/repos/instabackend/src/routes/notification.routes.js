// Notification route definitions — always scoped to the authenticated caller's own inbox
const express = require('express');
const notificationController = require('../controllers/notification.controller');
const authGuard = require('../middlewares/auth.middleware');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/', authGuard, asyncHandler(notificationController.list));
router.patch('/:id/read', authGuard, asyncHandler(notificationController.markRead));
router.patch('/read-all', authGuard, asyncHandler(notificationController.markAllRead));

module.exports = router;
