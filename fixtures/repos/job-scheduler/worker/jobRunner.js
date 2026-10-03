// Claims a single job and drives it through execution to a terminal status
const queueService = require('../api/services/queueService');
const handlers = require('./handlers');

async function runOnce() {
  const job = await queueService.claimNextJob();

  if (!job) {
    return false;
  }

  const handler = handlers[job.type];

  try {
    if (!handler) {
      throw new Error(`no handler registered for job type "${job.type}"`);
    }

    await handler(job.payload);
    await queueService.completeJob(job.id);
    console.log(`job ${job.id} (${job.type}) completed`);
  } catch (err) {
    const updated = await queueService.recordFailure(job, err.message);
    const outcome = updated.status === 'failed' ? 'dead-lettered' : `retry scheduled for ${updated.run_at}`;
    console.error(`job ${job.id} (${job.type}) failed: ${err.message} (${outcome})`);
  }

  return true;
}

module.exports = { runOnce };
