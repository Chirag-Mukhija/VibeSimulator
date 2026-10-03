// Search route definitions — public, read-only
const express = require('express');
const searchController = require('../controllers/search.controller');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/users', asyncHandler(searchController.searchUsers));

module.exports = router;
