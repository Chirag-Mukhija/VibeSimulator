// HTTP layer only — parses requests, calls profile.service, shapes responses
const profileService = require('../services/profile.service');
const uploadService = require('../services/upload.service');

const getByUsername = async (req, res) => {
  const profile = await profileService.getPublicProfile(req.params.username);
  res.json(profile);
};

const getMe = async (req, res) => {
  const profile = await profileService.getOwnProfile(req.userId);
  res.json(profile);
};

const updateMe = async (req, res) => {
  const { fullName, bio, website, avatarUrl } = req.body;

  if (avatarUrl !== undefined && !uploadService.isOwnedPublicUrl(avatarUrl)) {
    return res.status(400).json({ error: 'avatarUrl must point to an uploaded object from this app' });
  }

  const profile = await profileService.updateOwnProfile(req.userId, { fullName, bio, website, avatarUrl });
  res.json(profile);
};

module.exports = { getByUsername, getMe, updateMe };
