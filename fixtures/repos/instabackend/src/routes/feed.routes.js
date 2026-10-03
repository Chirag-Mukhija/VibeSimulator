// Feed route definitions — both strategies require auth, since a feed is always "my feed"
const express = require('express');
const feedController = require('../controllers/feed.controller');
const authGuard = require('../middlewares/auth.middleware');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/fanout-write', authGuard, asyncHandler(feedController.getFanoutWrite));
router.get('/fanout-read', authGuard, asyncHandler(feedController.getFanoutRead));

module.exports = router;
