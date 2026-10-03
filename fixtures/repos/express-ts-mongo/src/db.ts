import mongoose from "mongoose";

export function connectDb() {
  return mongoose.connect(process.env.MONGO_URL!);
}
