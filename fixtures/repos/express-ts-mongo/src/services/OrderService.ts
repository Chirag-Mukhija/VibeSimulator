import Order from "../models/Order.js";
import { emailQueue } from "../queues.js";
import { io } from "../server.js";

export class OrderService {
  constructor(private readonly queue: typeof emailQueue) {}

  async create(userId: string, items: { sku: string; qty: number }[]) {
    const order = await Order.create({ userId, items, status: "pending" });
    await this.queue.add("order-confirmation", { orderId: order.id });
    io.to(`user:${userId}`).emit("order:created", order);
    return order;
  }

  async list(userId: string) {
    return Order.find({ userId });
  }
}

export const orderService = new OrderService(emailQueue);
