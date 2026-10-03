// Tracks connected dashboard sockets and known worker heartbeats — in-memory,
// resets on API restart; not persisted, since this is presence, not job data
const WORKER_ONLINE_WINDOW_MS = 15000;

const clients = new Set();
const workerLastSeen = new Map();

function addClient(ws) {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
}

function broadcast(message) {
  const raw = JSON.stringify(message);

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(raw);
    }
  }
}

// http.Server.close() only stops new connections — it waits for existing ones to
// end, and an open WebSocket never ends on its own, so shutdown must close them itself
function closeAllClients() {
  for (const ws of clients) {
    ws.close(1001, 'server shutting down');
  }
}

function recordHeartbeat(workerId) {
  workerLastSeen.set(workerId, Date.now());
}

function listWorkers() {
  const now = Date.now();
  return Array.from(workerLastSeen.entries()).map(([workerId, lastSeenAt]) => ({
    workerId,
    lastSeenAt: new Date(lastSeenAt).toISOString(),
    online: now - lastSeenAt <= WORKER_ONLINE_WINDOW_MS,
  }));
}

module.exports = { addClient, broadcast, recordHeartbeat, listWorkers, closeAllClients };
