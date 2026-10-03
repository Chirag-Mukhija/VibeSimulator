// HTTP layer only — exposes both feed strategies so they can be compared directly
const feedService = require('../services/feed.service');
const { parseLimit } = require('../utils/pagination');

const getFanoutWrite = async (req, res) => {
  const { posts, nextCursor } = await feedService.getFeedFanoutWrite(req.userId, {
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ strategy: 'fanout-on-write', posts, nextCursor });
};

const getFanoutRead = async (req, res) => {
  const { posts, nextCursor } = await feedService.getFeedFanoutRead(req.userId, {
    cursor: req.query.cursor,
    limit: parseLimit(req.query.limit),
  });
  res.json({ strategy: 'fanout-on-read', posts, nextCursor });
};

module.exports = { getFanoutWrite, getFanoutRead };
