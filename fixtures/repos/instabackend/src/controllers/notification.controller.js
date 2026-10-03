// HTTP layer only — a plain poll-based inbox: list, unread count, mark read
const notificationService = require('../services/notification.service');
const { parseLimit } = require('../utils/pagination');

const list = async (req, res) => {
  const [{ notifications, nextCursor }, unreadCount] = await Promise.all([
    notificationService.listForUser(req.userId, { cursor: req.query.cursor, limit: parseLimit(req.query.limit) }),
    notificationService.countUnread(req.userId),
  ]);
  res.json({ notifications, nextCursor, unreadCount });
};

const markRead = async (req, res) => {
  const notification = await notificationService.markRead(req.params.id, req.userId);
  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  res.json(notification);
};

const markAllRead = async (req, res) => {
  await notificationService.markAllRead(req.userId);
  res.status(204).send();
};

module.exports = { list, markRead, markAllRead };
