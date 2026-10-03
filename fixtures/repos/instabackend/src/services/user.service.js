// All direct DB access for the users table — nothing else touches this table's SQL
const db = require('../config/db');

// prefix search over usernames, keyset-paginated by username itself (already unique, needs no tiebreaker)
const searchByUsernamePrefix = async (prefix, { cursor, limit = 20 } = {}) => {
  const params = [`${prefix}%`];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND username > $${params.length}`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT id, username, full_name, avatar_url
     FROM users
     WHERE username ILIKE $1 ${cursorClause}
     ORDER BY username ASC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit ? rows[rows.length - 1].username : null;
  return { users: rows, nextCursor };
};

const findByEmail = async (email) => {
  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
};

const findByUsername = async (username) => {
  const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0] || null;
};

const findById = async (id) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
};

const createUser = async ({ username, email, passwordHash }) => {
  const { rows } = await db.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, username, email, created_at`,
    [username, email, passwordHash]
  );
  return rows[0];
};

// builds a dynamic SET clause so a partial update only touches the fields the caller actually sent
const PROFILE_FIELDS = {
  fullName: 'full_name',
  bio: 'bio',
  avatarUrl: 'avatar_url',
  website: 'website',
};

const updateProfile = async (id, fields) => {
  const sets = [];
  const values = [];

  for (const [key, column] of Object.entries(PROFILE_FIELDS)) {
    if (fields[key] !== undefined) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }

  if (sets.length === 0) return findById(id);

  values.push(id);
  const { rows } = await db.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${values.length}
     RETURNING id, username, email, full_name, bio, avatar_url, website, created_at`,
    values
  );
  return rows[0] || null;
};

module.exports = { findByEmail, findByUsername, findById, createUser, updateProfile, searchByUsernamePrefix };
