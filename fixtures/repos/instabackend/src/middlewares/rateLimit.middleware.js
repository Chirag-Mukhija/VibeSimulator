// Redis-backed rate limiter — shared state across app instances, not per-process memory
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../config/redis');

// tight limit on auth endpoints specifically — this is where credential-stuffing/brute-force lands
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'ratelimit:auth:',
  }),
  message: { error: 'Too many auth requests, try again later' },
});

module.exports = { authLimiter };
