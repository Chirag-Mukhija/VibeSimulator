// All direct DB access for the likes table
const db = require('../config/db');

// returns true only if this call actually created a new like — false on a repeat like,
// so the caller can avoid firing a duplicate notification for an already-liked post
const like = async (userId, postId) => {
  const { rowCount } = await db.query(
    `INSERT INTO likes (user_id, post_id) VALUES ($1, $2)
     ON CONFLICT (user_id, post_id) DO NOTHING`,
    [userId, postId]
  );
  return rowCount > 0;
};

const unlike = async (userId, postId) => {
  await db.query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [userId, postId]);
};

const hasLiked = async (userId, postId) => {
  const { rows } = await db.query('SELECT 1 FROM likes WHERE user_id = $1 AND post_id = $2', [userId, postId]);
  return rows.length > 0;
};

const countByPost = async (postId) => {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM likes WHERE post_id = $1', [postId]);
  return rows[0].count;
};

module.exports = { like, unlike, hasLiked, countByPost };
