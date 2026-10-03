// Single shared Redis client, used for refresh-token session storage
const Redis = require('ioredis');
const env = require('./env');

const redis = new Redis(env.redisUrl);

redis.on('error', (err) => {
  console.error('Redis connection error', err);
});

module.exports = redis;
