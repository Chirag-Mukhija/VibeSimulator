import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.slice(7);
  try {
    res.locals.userId = (jwt.verify(token!, process.env.JWT_SECRET!) as { sub: string }).sub;
    next();
  } catch {
    res.status(401).end();
  }
}
