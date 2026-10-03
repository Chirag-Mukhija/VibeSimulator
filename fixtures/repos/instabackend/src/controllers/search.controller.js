// HTTP layer only — username prefix search
const userService = require('../services/user.service');
const { parseLimit } = require('../utils/pagination');

const searchUsers = async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'q is required' });
  }

  const { users, nextCursor } = await userService.searchByUsernamePrefix(q.trim(), {
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ users, nextCursor });
};

module.exports = { searchUsers };
