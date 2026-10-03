// HTTP route for queue depth and worker presence — dashboard's initial-load data
const express = require('express');
const pool = require('../db/pool');
const broadcast = require('../ws/broadcast');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT status, count(*)::int AS count FROM jobs GROUP BY status`);
    const counts = {};
    for (const row of result.rows) {
      counts[row.status] = row.count;
    }

    res.json({ counts, workers: broadcast.listWorkers() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
