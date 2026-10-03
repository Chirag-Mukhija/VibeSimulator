// Express app assembly — middleware stack and route mounting only, no listen() here
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const morgan = require('morgan');

const env = require('./config/env');

const authRoutes = require('./routes/auth.routes');
const uploadRoutes = require('./routes/upload.routes');
const profileRoutes = require('./routes/profile.routes');
const postRoutes = require('./routes/post.routes');
const feedRoutes = require('./routes/feed.routes');
const notificationRoutes = require('./routes/notification.routes');
const searchRoutes = require('./routes/search.routes');
const exploreRoutes = require('./routes/explore.routes');
const errorHandler = require('./middlewares/error.middleware');

const app = express();

// behind Nginx in production, this is what makes req.ip resolve to the real client IP
// instead of Nginx's — the rate limiter's per-IP bucketing depends on this being correct
app.set('trust proxy', 1);

app.use(helmet());
// dev gets human-readable request logs; prod gets the standard combined access-log format
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(cors({ credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/users', profileRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/explore', exploreRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
