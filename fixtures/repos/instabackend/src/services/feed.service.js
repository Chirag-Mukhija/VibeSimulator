// Publishes posts (post creation + fan-out) and reads feeds both ways, for direct comparison
const db = require('../config/db');
const postService = require('./post.service');
const followService = require('./follow.service');
const { encodeCursor, decodeCursor } = require('../utils/pagination');

// fan-out-on-write: copy this post into every follower's precomputed feed_items row
const fanOutOnWrite = async (post) => {
  const followerIds = await followService.getFollowerIds(post.user_id);
  if (followerIds.length === 0) return;

  const values = [];
  const placeholders = followerIds.map((followerId, i) => {
    values.push(followerId, post.id);
    return `($${i * 2 + 1}, $${i * 2 + 2})`;
  });

  await db.query(
    `INSERT INTO feed_items (user_id, post_id) VALUES ${placeholders.join(', ')}
     ON CONFLICT (user_id, post_id) DO NOTHING`,
    values
  );
};

// the single write path every post goes through — creates the row, then fans it out
const publishPost = async ({ userId, imageUrl, caption }) => {
  const post = await postService.createPost({ userId, imageUrl, caption });
  await fanOutOnWrite(post);
  return post;
};

// fan-out-on-write read: cheap — just follows the precomputed feed_items index, no joins across the graph
const getFeedFanoutWrite = async (userId, { cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [userId];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `AND (fi.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT p.id, p.user_id, p.image_url, p.caption, p.created_at
     FROM feed_items fi
     JOIN posts p ON p.id = fi.post_id
     WHERE fi.user_id = $1 ${cursorClause}
     ORDER BY fi.created_at DESC, p.id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
    : null;
  return { posts: rows, nextCursor };
};

// fan-out-on-read: expensive at read time — joins the follow graph against posts live, nothing precomputed
const getFeedFanoutRead = async (userId, { cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [userId];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT p.id, p.user_id, p.image_url, p.caption, p.created_at
     FROM posts p
     JOIN follows f ON f.followee_id = p.user_id
     WHERE f.follower_id = $1 ${cursorClause}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
    : null;
  return { posts: rows, nextCursor };
};

module.exports = { publishPost, getFeedFanoutWrite, getFeedFanoutRead };
