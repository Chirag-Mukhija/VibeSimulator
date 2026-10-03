// Entry point for the worker process — polls for pending jobs and executes them
const crypto = require('crypto');
const { runOnce } = require('./jobRunner');
const { publishEvent } = require('../api/services/events');
const pool = require('../api/db/pool');
const { getRedisClient } = require('../api/db/redisClient');

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 5000;
const workerId = crypto.randomUUID();

let shuttingDown = false;
let inFlight = null;

async function poll() {
  if (shuttingDown) {
    return;
  }

  inFlight = runOnce().catch((err) => {
    console.error('poll iteration failed:', err);
    return false;
  });

  const worked = await inFlight;
  inFlight = null;

  if (!shuttingDown) {
    setTimeout(poll, worked ? 0 : POLL_INTERVAL_MS);
  }
}

console.log(`Worker ${workerId} started, polling for jobs...`);
poll();

const heartbeat = setInterval(() => {
  publishEvent('worker:heartbeat', { workerId }).catch((err) => {
    console.error('heartbeat publish failed:', err);
  });
}, HEARTBEAT_INTERVAL_MS);

// A worker killed mid-job leaves that job's row stuck at "processing" forever
// (Phase 2's known gap) — graceful shutdown avoids that by finishing the
// in-flight job before the process actually exits.
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Worker ${workerId} received ${signal}, finishing in-flight job before exit...`);
  clearInterval(heartbeat);

  if (inFlight) {
    await inFlight;
  }

  console.log(`Worker ${workerId} shut down cleanly.`);

  await pool.end();
  const redis = await getRedisClient();
  await redis.quit();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
