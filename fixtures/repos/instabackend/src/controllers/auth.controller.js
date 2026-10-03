// HTTP layer only — parses requests, calls auth.service, shapes responses. No DB or JWT calls here.
const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const env = require('../config/env');

const REFRESH_COOKIE = 'refreshToken';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: 'strict',
  path: '/api/auth',
};

// refresh token goes both in an httpOnly cookie (web clients) and the JSON body (mobile clients
// have no cookie jar and store it in secure device storage instead)
const sendTokens = (res, { accessToken, refreshToken }, user) => {
  res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS);
  res.json({ user, accessToken, refreshToken });
};

const getRefreshToken = (req) => req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;

const register = async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password are required' });
  }

  const { user, accessToken, refreshToken } = await authService.register({ username, email, password });
  sendTokens(res, { accessToken, refreshToken }, { id: user.id, username: user.username, email: user.email });
};

const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { user, accessToken, refreshToken } = await authService.login({ email, password });
  sendTokens(res, { accessToken, refreshToken }, { id: user.id, username: user.username, email: user.email });
};

const refresh = async (req, res) => {
  const refreshToken = getRefreshToken(req);
  if (!refreshToken) {
    return res.status(401).json({ error: 'Missing refresh token' });
  }

  const tokens = await authService.refresh(refreshToken);
  sendTokens(res, tokens, undefined);
};

const logout = async (req, res) => {
  const refreshToken = getRefreshToken(req);
  if (refreshToken) {
    await authService.logout(refreshToken);
  }
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  res.status(204).send();
};

// proves the access-token guard works end to end — req.userId is set by auth.middleware
const me = async (req, res) => {
  const user = await userService.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, email: user.email, createdAt: user.created_at });
};

module.exports = { register, login, refresh, logout, me };
