import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";

const router = Router();
const attempts = new Map<string, number>();

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  attempts.set(email, (attempts.get(email) ?? 0) + 1);
  const user = await User.findOne({ email });
  if (!user || !bcrypt.compareSync(password, user.passwordHash!)) return res.status(401).end();
  res.json({ token: jwt.sign({ sub: user.id }, process.env.JWT_SECRET!) });
});

export default router;
