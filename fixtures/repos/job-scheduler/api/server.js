// Entry point for the API process — job submission, stats, and the live dashboard's
// WebSocket endpoint. No worker logic here.
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./config');
const jobsRouter = require('./routes/jobs');
const statsRouter = require('./routes/stats');
const { getRedisClient, getRedisSubscriber } = require('./db/redisClient');
const { CHANNEL } = require('./services/events');
const broadcast = require('./ws/broadcast');
const pool = require('./db/pool');

const app = express();

app.use(express.json());
app.use('/jobs', jobsRouter);
app.use('/stats', statsRouter);

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  broadcast.addClient(ws);
});

let subscriber = null;

async function subscribeToJobEvents() {
  subscriber = await getRedisSubscriber();

  await subscriber.subscribe(CHANNEL, (raw) => {
    const message = JSON.parse(raw);

    if (message.type === 'worker:heartbeat') {
      broadcast.recordHeartbeat(message.workerId);
    }

    broadcast.broadcast(message);
  });
}

subscribeToJobEvents().catch((err) => {
  console.error('failed to subscribe to job events:', err);
});

server.listen(config.port, () => {
  console.log(`API server listening on port ${config.port}`);
});

let shuttingDown = false;

// Stop accepting new connections and let in-flight requests finish before
// closing the database and Redis connections — never cut a request off mid-flight
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`API received ${signal}, closing server...`);

  broadcast.closeAllClients();
  await new Promise((resolve) => server.close(resolve));
  console.log('API server closed cleanly.');

  await pool.end();
  if (subscriber) {
    await subscriber.quit();
  }
  const redis = await getRedisClient();
  await redis.quit();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
