// Post route definitions — creating a post requires auth, reading one does not
const express = require('express');
const postController = require('../controllers/post.controller');
const likeController = require('../controllers/like.controller');
const commentController = require('../controllers/comment.controller');
const authGuard = require('../middlewares/auth.middleware');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.post('/', authGuard, asyncHandler(postController.create));
router.get('/:id', asyncHandler(postController.getById));

router.post('/:id/like', authGuard, asyncHandler(likeController.likePost));
router.delete('/:id/like', authGuard, asyncHandler(likeController.unlikePost));
router.get('/:id/like-status', authGuard, asyncHandler(likeController.getLikeStatus));

router.post('/:id/comments', authGuard, asyncHandler(commentController.create));
router.get('/:id/comments', asyncHandler(commentController.list));
router.delete('/:id/comments/:commentId', authGuard, asyncHandler(commentController.remove));

module.exports = router;
