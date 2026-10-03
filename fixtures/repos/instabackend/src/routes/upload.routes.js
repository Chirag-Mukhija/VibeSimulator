// Upload route definitions — issuing presigned URLs requires authentication
const express = require('express');
const uploadController = require('../controllers/upload.controller');
const authGuard = require('../middlewares/auth.middleware');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.post('/presign', authGuard, asyncHandler(uploadController.presign));

module.exports = router;
