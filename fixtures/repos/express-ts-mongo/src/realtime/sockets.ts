import type { Server } from "socket.io";

export function registerSockets(io: Server) {
  io.on("connection", (socket) => {
    socket.on("join", (userId: string) => socket.join(`user:${userId}`));
  });
}
