// HTTP layer only — parses requests, calls post.service/upload.service, shapes responses
const postService = require('../services/post.service');
const userService = require('../services/user.service');
const uploadService = require('../services/upload.service');
const feedService = require('../services/feed.service');
const likeService = require('../services/like.service');
const commentService = require('../services/comment.service');
const { parseLimit } = require('../utils/pagination');

const create = async (req, res) => {
  const { imageUrl, caption } = req.body;
  if (!imageUrl) {
    return res.status(400).json({ error: 'imageUrl is required' });
  }
  if (!uploadService.isOwnedPublicUrl(imageUrl)) {
    return res.status(400).json({ error: 'imageUrl must point to an uploaded object from this app' });
  }

  // publishPost creates the row and fans it out to followers' feed_items in one step
  const post = await feedService.publishPost({ userId: req.userId, imageUrl, caption });
  res.status(201).json(post);
};

const getById = async (req, res) => {
  const post = await postService.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const [likeCount, commentCount] = await Promise.all([
    likeService.countByPost(post.id),
    commentService.countByPost(post.id),
  ]);

  res.json({ ...post, likeCount, commentCount });
};

const listByUsername = async (req, res) => {
  const user = await userService.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { posts, nextCursor } = await postService.listByUserId(user.id, {
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ posts, nextCursor });
};

// global recent posts across every user, newest first — no personalization, no ranking
const explore = async (req, res) => {
  const { posts, nextCursor } = await postService.listRecent({
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ posts, nextCursor });
};

module.exports = { create, getById, listByUsername, explore };
