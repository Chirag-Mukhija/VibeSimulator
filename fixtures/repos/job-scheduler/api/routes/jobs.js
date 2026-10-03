// HTTP routes for submitting and inspecting jobs
const express = require('express');
const queueService = require('../services/queueService');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const { type, payload, maxAttempts, priority, delaySeconds } = req.body;

    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'type is required and must be a string' });
    }

    if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
      return res.status(400).json({ error: 'maxAttempts must be a positive integer' });
    }

    if (priority !== undefined && !Number.isInteger(priority)) {
      return res.status(400).json({ error: 'priority must be an integer' });
    }

    if (delaySeconds !== undefined && (typeof delaySeconds !== 'number' || delaySeconds < 0)) {
      return res.status(400).json({ error: 'delaySeconds must be a non-negative number' });
    }

    const job = await queueService.enqueueJob(type, payload || {}, { maxAttempts, priority, delaySeconds });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { status, limit, offset } = req.query;
    const jobs = await queueService.listJobs({
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const job = await queueService.getJobById(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'job not found' });
    }

    res.json(job);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/retry', async (req, res, next) => {
  try {
    const job = await queueService.retryJob(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'no dead-lettered job with this id' });
    }

    res.json(job);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
