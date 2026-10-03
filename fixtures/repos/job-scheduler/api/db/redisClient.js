// Lazily connects a single shared Redis client, reused by API and worker
const { createClient } = require('redis');
const config = require('../config');

let clientPromise = null;

function getRedisClient() {
  if (!clientPromise) {
    const client = createClient({ url: config.redisUrl });
    client.on('error', (err) => console.error('Redis error:', err));
    clientPromise = client.connect().then(() => client);
  }

  return clientPromise;
}

// Redis requires a separate connection for pub/sub — a subscribed client
// cannot also issue regular commands, so this is never shared with getRedisClient
async function getRedisSubscriber() {
  const client = await getRedisClient();
  const subscriber = client.duplicate();
  subscriber.on('error', (err) => console.error('Redis subscriber error:', err));
  await subscriber.connect();
  return subscriber;
}

module.exports = { getRedisClient, getRedisSubscriber };
