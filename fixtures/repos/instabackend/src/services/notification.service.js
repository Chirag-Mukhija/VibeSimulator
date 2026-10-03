// All direct DB access for notifications — a plain poll-based inbox, no push/websocket delivery
const db = require('../config/db');
const { encodeCursor, decodeCursor } = require('../utils/pagination');

// recipientId === actorId means someone acted on their own content — never notify yourself
const create = async ({ recipientId, actorId, type, postId = null, commentId = null }) => {
  if (recipientId === actorId) return null;

  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_id, actor_id, type, post_id, comment_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, recipient_id, actor_id, type, post_id, comment_id, is_read, created_at`,
    [recipientId, actorId, type, postId, commentId]
  );
  return rows[0];
};

const listForUser = async (userId, { cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [userId];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `AND (n.created_at, n.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT n.id, n.type, n.post_id, n.comment_id, n.is_read, n.created_at,
            a.id AS actor_id, a.username AS actor_username, a.avatar_url AS actor_avatar_url
     FROM notifications n
     JOIN users a ON a.id = n.actor_id
     WHERE n.recipient_id = $1 ${cursorClause}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
    : null;
  return { notifications: rows, nextCursor };
};

const countUnread = async (userId) => {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE recipient_id = $1 AND is_read = false',
    [userId]
  );
  return rows[0].count;
};

// scoped to userId so one user can never mark another user's notifications read
const markRead = async (id, userId) => {
  const { rows } = await db.query(
    `UPDATE notifications SET is_read = true
     WHERE id = $1 AND recipient_id = $2
     RETURNING id, is_read`,
    [id, userId]
  );
  return rows[0] || null;
};

const markAllRead = async (userId) => {
  await db.query('UPDATE notifications SET is_read = true WHERE recipient_id = $1 AND is_read = false', [userId]);
};

module.exports = { create, listForUser, countUnread, markRead, markAllRead };
