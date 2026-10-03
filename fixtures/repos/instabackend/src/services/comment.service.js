// All direct DB access for the comments table
const db = require('../config/db');
const { encodeCursor, decodeCursor } = require('../utils/pagination');

const createComment = async ({ postId, userId, body }) => {
  const { rows } = await db.query(
    `INSERT INTO comments (post_id, user_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, post_id, user_id, body, created_at`,
    [postId, userId, body]
  );
  return rows[0];
};

const findById = async (id) => {
  const { rows } = await db.query('SELECT * FROM comments WHERE id = $1', [id]);
  return rows[0] || null;
};

// oldest first, keyset-paginated forward — a comment thread reads top-to-bottom in the order
// it was written, so "next page" means "continue after the last comment already shown"
const listByPost = async (postId, { cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [postId];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `AND (c.created_at, c.id) > ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT c.id, c.post_id, c.body, c.created_at,
            u.id AS user_id, u.username, u.avatar_url
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.post_id = $1 ${cursorClause}
     ORDER BY c.created_at ASC, c.id ASC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
    : null;
  return { comments: rows, nextCursor };
};

const deleteComment = async (id) => {
  await db.query('DELETE FROM comments WHERE id = $1', [id]);
};

const countByPost = async (postId) => {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM comments WHERE post_id = $1', [postId]);
  return rows[0].count;
};

module.exports = { createComment, findById, listByPost, deleteComment, countByPost };
