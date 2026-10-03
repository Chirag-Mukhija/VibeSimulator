// All JWT signing/verification lives here — controllers and services never call jsonwebtoken directly
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const signAccessToken = (payload) =>
  jwt.sign(payload, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpiry });

const verifyAccessToken = (token) => jwt.verify(token, env.jwt.accessSecret);

// refresh tokens carry a random jti so a single session can be revoked in Redis without invalidating others
const signRefreshToken = (payload) =>
  jwt.sign(payload, env.jwt.refreshSecret, { expiresIn: env.jwt.refreshExpiry });

const verifyRefreshToken = (token) => jwt.verify(token, env.jwt.refreshSecret);

module.exports = {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
};
