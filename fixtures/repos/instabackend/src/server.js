// Process entry point — starts the HTTP listener and shuts down cleanly on termination signals
const app = require('./app');
const env = require('./config/env');
const { pool } = require('./config/db');
const redis = require('./config/redis');

const server = app.listen(env.port, () => {
  console.log(`instaBackend listening on port ${env.port}`);
});

// under Docker/Nginx, SIGTERM is how the orchestrator asks the process to stop — a bare process.exit()
// would drop in-flight requests and leave DB/Redis connections open
const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await pool.end();
    redis.disconnect();
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
