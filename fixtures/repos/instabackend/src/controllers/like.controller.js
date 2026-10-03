// HTTP layer only — likes a post, then notifies the post's owner (skipped for self-likes by notificationService)
const postService = require('../services/post.service');
const likeService = require('../services/like.service');
const notificationService = require('../services/notification.service');

const resolvePost = async (req, res) => {
  const post = await postService.findById(req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return null;
  }
  return post;
};

const likePost = async (req, res) => {
  const post = await resolvePost(req, res);
  if (!post) return;

  const isNewLike = await likeService.like(req.userId, post.id);
  if (isNewLike) {
    await notificationService.create({ recipientId: post.user_id, actorId: req.userId, type: 'like', postId: post.id });
  }
  res.status(204).send();
};

const unlikePost = async (req, res) => {
  const post = await resolvePost(req, res);
  if (!post) return;

  await likeService.unlike(req.userId, post.id);
  res.status(204).send();
};

const getLikeStatus = async (req, res) => {
  const post = await resolvePost(req, res);
  if (!post) return;

  const liked = await likeService.hasLiked(req.userId, post.id);
  res.json({ liked });
};

module.exports = { likePost, unlikePost, getLikeStatus };
