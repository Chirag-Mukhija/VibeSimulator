// Opaque keyset-pagination cursor: encodes a (created_at, tiebreaker) position, base64url so it's URL-safe
const encodeCursor = (createdAt, tiebreaker) =>
  Buffer.from(`${new Date(createdAt).toISOString()}|${tiebreaker}`).toString('base64url');

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [createdAt, tiebreaker] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !tiebreaker) return null;
    return { createdAt, tiebreaker };
  } catch {
    return null;
  }
};

// clamps a client-supplied ?limit= to a sane range so no one can request an unbounded page
const parseLimit = (raw, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
};

module.exports = { encodeCursor, decodeCursor, parseLimit };
