// Orchestrates profile reads/writes — shapes what's public vs. private about a user record
const userService = require('./user.service');
const postService = require('./post.service');
const followService = require('./follow.service');

class ProfileError extends Error {
  constructor(message, statusCode = 404) {
    super(message);
    this.statusCode = statusCode;
  }
}

const toPublicProfile = async (user) => {
  const [postCount, followerCount, followingCount] = await Promise.all([
    postService.countByUserId(user.id),
    followService.countFollowers(user.id),
    followService.countFollowing(user.id),
  ]);

  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    bio: user.bio,
    avatarUrl: user.avatar_url,
    website: user.website,
    postCount,
    followerCount,
    followingCount,
    createdAt: user.created_at,
  };
};

const getPublicProfile = async (username) => {
  const user = await userService.findByUsername(username);
  if (!user) throw new ProfileError('User not found', 404);
  return toPublicProfile(user);
};

const getOwnProfile = async (userId) => {
  const user = await userService.findById(userId);
  if (!user) throw new ProfileError('User not found', 404);
  return { ...(await toPublicProfile(user)), email: user.email };
};

const updateOwnProfile = async (userId, fields) => {
  const user = await userService.updateProfile(userId, fields);
  if (!user) throw new ProfileError('User not found', 404);
  return toPublicProfile(user);
};

module.exports = { ProfileError, getPublicProfile, getOwnProfile, updateOwnProfile };
