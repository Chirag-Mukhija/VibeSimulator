// Publishes job/worker events on Redis Pub/Sub — the bridge between the worker
// process (which knows about job transitions) and the API process (which serves
// the dashboard's WebSocket connections)
const { getRedisClient } = require('../db/redisClient');

const CHANNEL = 'job:events';

async function publishEvent(type, data) {
  const redis = await getRedisClient();
  await redis.publish(CHANNEL, JSON.stringify({ type, ...data, at: new Date().toISOString() }));
}

module.exports = { CHANNEL, publishEvent };
