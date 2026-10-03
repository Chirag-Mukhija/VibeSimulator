// All direct DB access for the posts table
const db = require('../config/db');
const { encodeCursor, decodeCursor } = require('../utils/pagination');

const createPost = async ({ userId, imageUrl, caption }) => {
  const { rows } = await db.query(
    `INSERT INTO posts (user_id, image_url, caption)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, image_url, caption, created_at`,
    [userId, imageUrl, caption || null]
  );
  return rows[0];
};

const findById = async (id) => {
  const { rows } = await db.query('SELECT * FROM posts WHERE id = $1', [id]);
  return rows[0] || null;
};

// newest first, keyset-paginated on (created_at, id) — backed by idx_posts_user_created.
// (created_at, id) < (cursor) is what makes this cheap at any page depth: no OFFSET, no re-scanning
// rows already returned on a previous page, just "continue after where I left off"
const listByUserId = async (userId, { cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [userId];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT id, user_id, image_url, caption, created_at
     FROM posts
     WHERE user_id = $1 ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
    : null;
  return { posts: rows, nextCursor };
};

// global recent posts across every user — the explore feed, same keyset pattern, no user_id filter
const listRecent = async ({ cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `WHERE (created_at, id) < ($1, $2)`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT id, user_id, image_url, caption, created_at
     FROM posts
     ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
    : null;
  return { posts: rows, nextCursor };
};

const countByUserId = async (userId) => {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM posts WHERE user_id = $1', [userId]);
  return rows[0].count;
};

module.exports = { createPost, findById, listByUserId, listRecent, countByUserId };
