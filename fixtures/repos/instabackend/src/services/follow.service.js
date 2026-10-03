// All direct DB access for the follows table — the social graph
const db = require('../config/db');
const { encodeCursor, decodeCursor } = require('../utils/pagination');

class FollowError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// returns true only if this call actually created a new edge — false on a repeat follow,
// so the caller can avoid firing a duplicate notification for an already-followed user
const follow = async (followerId, followeeId) => {
  if (followerId === followeeId) {
    throw new FollowError('Cannot follow yourself', 400);
  }
  const { rowCount } = await db.query(
    `INSERT INTO follows (follower_id, followee_id)
     VALUES ($1, $2)
     ON CONFLICT (follower_id, followee_id) DO NOTHING`,
    [followerId, followeeId]
  );
  return rowCount > 0;
};

const unfollow = async (followerId, followeeId) => {
  await db.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [followerId, followeeId]);
};

const isFollowing = async (followerId, followeeId) => {
  const { rows } = await db.query(
    'SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2',
    [followerId, followeeId]
  );
  return rows.length > 0;
};

const countFollowers = async (userId) => {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM follows WHERE followee_id = $1', [userId]);
  return rows[0].count;
};

const countFollowing = async (userId) => {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM follows WHERE follower_id = $1', [userId]);
  return rows[0].count;
};

// people who follow userId — joins to users for display info, newest follow first
const listFollowers = async (userId, { cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [userId];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `AND (f.created_at, u.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.avatar_url, f.created_at AS followed_at
     FROM follows f
     JOIN users u ON u.id = f.follower_id
     WHERE f.followee_id = $1 ${cursorClause}
     ORDER BY f.created_at DESC, u.id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].followed_at, rows[rows.length - 1].id)
    : null;
  return { followers: rows, nextCursor };
};

// people userId follows
const listFollowing = async (userId, { cursor, limit = 20 } = {}) => {
  const decoded = decodeCursor(cursor);
  const params = [userId];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.createdAt, decoded.tiebreaker);
    cursorClause = `AND (f.created_at, u.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.avatar_url, f.created_at AS followed_at
     FROM follows f
     JOIN users u ON u.id = f.followee_id
     WHERE f.follower_id = $1 ${cursorClause}
     ORDER BY f.created_at DESC, u.id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit
    ? encodeCursor(rows[rows.length - 1].followed_at, rows[rows.length - 1].id)
    : null;
  return { following: rows, nextCursor };
};

// all follower ids for userId, uncapped — used only for fan-out-on-write, never returned to a client
const getFollowerIds = async (userId) => {
  const { rows } = await db.query('SELECT follower_id FROM follows WHERE followee_id = $1', [userId]);
  return rows.map((r) => r.follower_id);
};

module.exports = {
  FollowError,
  follow,
  unfollow,
  isFollowing,
  countFollowers,
  countFollowing,
  listFollowers,
  listFollowing,
  getFollowerIds,
};
