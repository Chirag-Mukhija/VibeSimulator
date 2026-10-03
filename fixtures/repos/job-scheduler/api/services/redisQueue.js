// Redis sorted-set helpers for the hot claim path — one sorted set per priority tier,
// score = run_at as epoch ms, so ZRANGEBYSCORE naturally excludes not-yet-due jobs
const MIN_TIER = 0;
const MAX_TIER = 9;

function tierKey(priority) {
  const tier = Math.min(Math.max(priority, MIN_TIER), MAX_TIER);
  return `queue:priority:${tier}`;
}

async function addJob(redis, id, priority, runAt) {
  await redis.zAdd(tierKey(priority), [{ score: new Date(runAt).getTime(), value: String(id) }]);
}

async function removeJob(redis, priority, id) {
  await redis.zRem(tierKey(priority), String(id));
}

// Returns the earliest-eligible job id in this tier, or null if none are due yet
async function peekDueJob(redis, tier) {
  const results = await redis.zRangeByScore(tierKey(tier), 0, Date.now(), {
    LIMIT: { offset: 0, count: 1 },
  });
  return results[0] || null;
}

module.exports = { MIN_TIER, MAX_TIER, addJob, removeJob, peekDueJob };
