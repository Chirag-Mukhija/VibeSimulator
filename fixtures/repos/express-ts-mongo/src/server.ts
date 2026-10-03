import http from "node:http";
import express from "express";
import { Server } from "socket.io";
import { connectDb } from "./db.js";
import ordersRouter from "./routes/orders.js";
import authRouter from "./routes/auth.js";
import { requireUser } from "./middleware/requireUser.js";
import { registerSockets } from "./realtime/sockets.js";

const app = express();
app.use(express.json());
app.use("/auth", authRouter);
app.use("/orders", requireUser, ordersRouter);

const server = http.createServer(app);
export const io = new Server(server);
registerSockets(io);

connectDb().then(() => server.listen(3000));
