import { Router } from "express";
import { orderService } from "../services/OrderService.js";
import * as shipping from "../services/shipping.js";

const router = Router();

router.get("/", async (req, res) => {
  res.json(await orderService.list(res.locals.userId));
});

router.post("/", async (req, res) => {
  const quoteResult = await shipping.quote(req.body.items);
  const order = await orderService.create(res.locals.userId, req.body.items);
  res.status(201).json({ order, quote: quoteResult });
});

router.get("/:id/tracking", async (req, res) => {
  res.json(await shipping.track(req.params.id));
});

export default router;
