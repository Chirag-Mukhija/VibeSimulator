import mongoose from "mongoose";

const orderSchema = new mongoose.Schema({ userId: String, items: Array, status: String });

export default mongoose.model("Order", orderSchema);
