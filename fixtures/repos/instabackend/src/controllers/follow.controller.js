// HTTP layer only — resolves :username to a user id, then delegates to follow.service
const followService = require('../services/follow.service');
const userService = require('../services/user.service');
const notificationService = require('../services/notification.service');
const { parseLimit } = require('../utils/pagination');

const resolveTargetUser = async (username, res) => {
  const user = await userService.findByUsername(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return user;
};

const followUser = async (req, res) => {
  const target = await resolveTargetUser(req.params.username, res);
  if (!target) return;

  const isNewFollow = await followService.follow(req.userId, target.id);
  if (isNewFollow) {
    await notificationService.create({ recipientId: target.id, actorId: req.userId, type: 'follow' });
  }
  res.status(204).send();
};

const unfollowUser = async (req, res) => {
  const target = await resolveTargetUser(req.params.username, res);
  if (!target) return;

  await followService.unfollow(req.userId, target.id);
  res.status(204).send();
};

const getFollowers = async (req, res) => {
  const target = await resolveTargetUser(req.params.username, res);
  if (!target) return;

  const { followers, nextCursor } = await followService.listFollowers(target.id, {
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ followers, nextCursor });
};

const getFollowing = async (req, res) => {
  const target = await resolveTargetUser(req.params.username, res);
  if (!target) return;

  const { following, nextCursor } = await followService.listFollowing(target.id, {
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ following, nextCursor });
};

// auth required — reports the relationship between the caller and :username, both directions
const getFollowStatus = async (req, res) => {
  const target = await resolveTargetUser(req.params.username, res);
  if (!target) return;

  const [followsThem, followedByThem] = await Promise.all([
    followService.isFollowing(req.userId, target.id),
    followService.isFollowing(target.id, req.userId),
  ]);

  res.json({ followsThem, followedByThem, isMutual: followsThem && followedByThem });
};

module.exports = { followUser, unfollowUser, getFollowers, getFollowing, getFollowStatus };
