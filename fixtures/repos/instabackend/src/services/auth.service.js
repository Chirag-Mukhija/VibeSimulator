// Orchestrates registration, login, token refresh, and logout — the only place these flows are assembled
const userService = require('./user.service');
const tokenService = require('./token.service');
const { hashPassword, verifyPassword } = require('../utils/password');
const jwt = require('../utils/jwt');

class AuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const issueTokenPair = async (user) => {
  const jti = await tokenService.createSession(user.id);
  const accessToken = jwt.signAccessToken({ sub: user.id });
  const refreshToken = jwt.signRefreshToken({ sub: user.id, jti });
  return { accessToken, refreshToken };
};

const register = async ({ username, email, password }) => {
  if (await userService.findByEmail(email)) {
    throw new AuthError('Email already in use', 409);
  }
  if (await userService.findByUsername(username)) {
    throw new AuthError('Username already taken', 409);
  }

  const passwordHash = await hashPassword(password);
  const user = await userService.createUser({ username, email, passwordHash });
  const tokens = await issueTokenPair(user);

  return { user, ...tokens };
};

const login = async ({ email, password }) => {
  const user = await userService.findByEmail(email);
  if (!user) throw new AuthError('Invalid credentials', 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) throw new AuthError('Invalid credentials', 401);

  const tokens = await issueTokenPair(user);
  return { user, ...tokens };
};

// rotates the refresh token on every use: old jti is revoked, a new one is issued
const refresh = async (refreshToken) => {
  let payload;
  try {
    payload = jwt.verifyRefreshToken(refreshToken);
  } catch {
    throw new AuthError('Invalid or expired refresh token', 401);
  }

  const { sub: userId, jti } = payload;
  const valid = await tokenService.isSessionValid(userId, jti);
  if (!valid) throw new AuthError('Session revoked or expired', 401);

  await tokenService.revokeSession(userId, jti);

  const user = await userService.findById(userId);
  if (!user) throw new AuthError('User no longer exists', 401);

  return issueTokenPair(user);
};

const logout = async (refreshToken) => {
  try {
    const payload = jwt.verifyRefreshToken(refreshToken);
    await tokenService.revokeSession(payload.sub, payload.jti);
  } catch {
    // token already invalid/expired — logout is a no-op in that case
  }
};

module.exports = { AuthError, register, login, refresh, logout };
