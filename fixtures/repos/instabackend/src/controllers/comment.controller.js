// HTTP layer only — comments on a post, then notifies the post's owner
const postService = require('../services/post.service');
const commentService = require('../services/comment.service');
const notificationService = require('../services/notification.service');
const { parseLimit } = require('../utils/pagination');

const resolvePost = async (req, res) => {
  const post = await postService.findById(req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return null;
  }
  return post;
};

const create = async (req, res) => {
  const post = await resolvePost(req, res);
  if (!post) return;

  const { body } = req.body;
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'body is required' });
  }

  const comment = await commentService.createComment({ postId: post.id, userId: req.userId, body });
  await notificationService.create({
    recipientId: post.user_id,
    actorId: req.userId,
    type: 'comment',
    postId: post.id,
    commentId: comment.id,
  });
  res.status(201).json(comment);
};

const list = async (req, res) => {
  const post = await resolvePost(req, res);
  if (!post) return;

  const { comments, nextCursor } = await commentService.listByPost(post.id, {
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ comments, nextCursor });
};

// only the comment's author or the post's owner may delete it
const remove = async (req, res) => {
  const comment = await commentService.findById(req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  const post = await postService.findById(comment.post_id);
  const isOwner = comment.user_id === req.userId || post.user_id === req.userId;
  if (!isOwner) return res.status(403).json({ error: 'Not allowed to delete this comment' });

  await commentService.deleteComment(comment.id);
  res.status(204).send();
};

module.exports = { create, list, remove };
