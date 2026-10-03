// All reads/writes to the jobs table go through this module.
// Postgres remains the durable record for every job; Redis is only a fast
// index of which pending jobs are due, used to avoid scanning the full table.
const pool = require('../db/pool');
const { backoffSeconds } = require('./backoff');
const { getRedisClient } = require('../db/redisClient');
const redisQueue = require('./redisQueue');
const { publishEvent } = require('./events');

async function enqueueJob(type, payload, { maxAttempts, priority, delaySeconds } = {}) {
  const result = await pool.query(
    `INSERT INTO jobs (type, payload, max_attempts, priority, run_at)
     VALUES ($1, $2, COALESCE($3, 3), COALESCE($4, 0), now() + (COALESCE($5, 0) || ' seconds')::interval)
     RETURNING *`,
    [type, payload, maxAttempts, priority, delaySeconds]
  );

  const job = result.rows[0];
  const redis = await getRedisClient();
  await redisQueue.addJob(redis, job.id, job.priority, job.run_at);
  await publishEvent('job:created', { jobId: job.id, jobType: job.type, status: job.status });
  return job;
}

async function getJobById(id) {
  const result = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function listJobs({ status, limit = 50, offset = 0 } = {}) {
  if (status) {
    const result = await pool.query(
      `SELECT * FROM jobs WHERE status = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
    return result.rows;
  }

  const result = await pool.query(
    `SELECT * FROM jobs ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

// Asks Redis which job is next (cheap, in-memory, priority-tier lookup), then
// claims it in Postgres with a guarded UPDATE. A guard (WHERE status = 'pending')
// is enough here — unlike Phase 2's full-table scan, Redis has already picked a
// single candidate, so there's no set of competing rows left to lock against.
async function claimNextJob() {
  const redis = await getRedisClient();

  for (let tier = redisQueue.MIN_TIER; tier <= redisQueue.MAX_TIER; tier++) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const jobId = await redisQueue.peekDueJob(redis, tier);
      if (!jobId) {
        break;
      }

      const claimed = await pool.query(
        `UPDATE jobs
         SET status = 'processing', attempts = attempts + 1, updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [jobId]
      );

      await redisQueue.removeJob(redis, tier, jobId);

      if (claimed.rows.length > 0) {
        const job = claimed.rows[0];
        await publishEvent('job:claimed', { jobId: job.id, jobType: job.type, status: job.status });
        return job;
      }

      // stale Redis entry (already claimed/retried/dead-lettered) — try this tier again
    }
  }

  return null;
}

async function completeJob(id) {
  const result = await pool.query(
    `UPDATE jobs
     SET status = 'completed', error = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  const job = result.rows[0];
  await publishEvent('job:completed', { jobId: job.id, jobType: job.type, status: job.status });
  return job;
}

// Decides retry vs. dead-letter using the attempt count already on the claimed row
async function recordFailure(job, errorMessage) {
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    const result = await pool.query(
      `UPDATE jobs
       SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [job.id, errorMessage]
    );

    const deadLettered = result.rows[0];
    await publishEvent('job:failed', { jobId: deadLettered.id, jobType: deadLettered.type, status: deadLettered.status, error: errorMessage });
    return deadLettered;
  }

  const delaySeconds = backoffSeconds(job.attempts);
  const result = await pool.query(
    `UPDATE jobs
     SET status = 'pending', error = $2, run_at = now() + ($3 || ' seconds')::interval, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [job.id, errorMessage, delaySeconds]
  );

  const retried = result.rows[0];
  const redis = await getRedisClient();
  await redisQueue.addJob(redis, retried.id, retried.priority, retried.run_at);
  await publishEvent('job:failed', { jobId: retried.id, jobType: retried.type, status: retried.status, error: errorMessage });
  return retried;
}

// Manually requeues a dead-lettered job — the documented DLQ recovery path
async function retryJob(id) {
  const result = await pool.query(
    `UPDATE jobs
     SET status = 'pending', attempts = 0, error = NULL, run_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'failed'
     RETURNING *`,
    [id]
  );

  const retried = result.rows[0];
  if (!retried) {
    return null;
  }

  const redis = await getRedisClient();
  await redisQueue.addJob(redis, retried.id, retried.priority, retried.run_at);
  await publishEvent('job:created', { jobId: retried.id, jobType: retried.type, status: retried.status });
  return retried;
}

module.exports = {
  enqueueJob,
  getJobById,
  listJobs,
  claimNextJob,
  completeJob,
  recordFailure,
  retryJob,
};
