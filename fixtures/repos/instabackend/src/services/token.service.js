// Owns the Redis-backed refresh-token session whitelist — this is what makes refresh tokens revocable
const crypto = require('crypto');
const redis = require('../config/redis');
const env = require('../config/env');

const EXPIRY_SECONDS = parseExpiryToSeconds(env.jwt.refreshExpiry);

function parseExpiryToSeconds(expiry) {
  const match = /^(\d+)([smhd])$/.exec(expiry);
  if (!match) return 7 * 24 * 60 * 60; // fallback: 7 days
  const [, value, unit] = match;
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(value, 10) * multipliers[unit];
}

const sessionKey = (userId, jti) => `refresh:${userId}:${jti}`;

const createSession = async (userId) => {
  const jti = crypto.randomUUID();
  await redis.set(sessionKey(userId, jti), '1', 'EX', EXPIRY_SECONDS);
  return jti;
};

const isSessionValid = async (userId, jti) => {
  const exists = await redis.exists(sessionKey(userId, jti));
  return exists === 1;
};

const revokeSession = async (userId, jti) => {
  await redis.del(sessionKey(userId, jti));
};

const revokeAllSessions = async (userId) => {
  const keys = await redis.keys(`refresh:${userId}:*`);
  if (keys.length) await redis.del(...keys);
};

module.exports = { createSession, isSessionValid, revokeSession, revokeAllSessions };
