// Profile route definitions — /me routes require auth, public profile lookup does not
const express = require('express');
const profileController = require('../controllers/profile.controller');
const postController = require('../controllers/post.controller');
const followController = require('../controllers/follow.controller');
const authGuard = require('../middlewares/auth.middleware');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/me', authGuard, asyncHandler(profileController.getMe));
router.patch('/me', authGuard, asyncHandler(profileController.updateMe));
router.get('/:username', asyncHandler(profileController.getByUsername));
router.get('/:username/posts', asyncHandler(postController.listByUsername));
router.post('/:username/follow', authGuard, asyncHandler(followController.followUser));
router.delete('/:username/follow', authGuard, asyncHandler(followController.unfollowUser));
router.get('/:username/followers', asyncHandler(followController.getFollowers));
router.get('/:username/following', asyncHandler(followController.getFollowing));
router.get('/:username/follow-status', authGuard, asyncHandler(followController.getFollowStatus));

module.exports = router;
