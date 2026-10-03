// Explore route — public, global recent posts, no personalization
const express = require('express');
const postController = require('../controllers/post.controller');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(postController.explore));

module.exports = router;
