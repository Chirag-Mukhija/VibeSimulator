import { Worker } from "bullmq";
import Order from "./models/Order.js";
import { sendMail } from "./services/mailer.js";

new Worker(
  "email",
  async (job) => {
    const order = await Order.findById(job.data.orderId);
    await sendMail(order);
  },
  { connection: { host: "localhost", port: 6379 } },
);
