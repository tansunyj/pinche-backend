/**
 * 旧版 /api/orders 路由：
 *
 * 本来用 prisma 实现，但项目早就切到 MySQL；现在统一改为转发到 /api/payments 的对应实现。
 * 保留这个文件只是为了不破坏老前端代码（兼容旧调用方）。新代码请用 /api/payments/orders。
 */

import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import BillingService from "../services/BillingService";

const router = Router();

router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const orders = await BillingService.listUserOrders(req.user!.userId, { limit, offset });
    res.json({
      orders: orders.map((o) => ({
        orderNo: o.order_no,
        amount: Number(o.amount),
        points: o.points,
        payMethod: o.payment_channel,
        status: o.status,
        paidAt: o.paid_at,
        createdAt: o.created_at,
      })),
    });
  } catch (err) {
    console.error("[orders] list error:", err);
    res.status(500).json({ error: "查询订单失败" });
  }
});

router.get("/:orderNo", authMiddleware, async (req: Request, res: Response) => {
  try {
    const order = await BillingService.findByOrderNo(req.params.orderNo);
    if (!order || order.user_id !== req.user!.userId) {
      res.status(404).json({ error: "订单不存在" });
      return;
    }
    res.json({
      orderNo: order.order_no,
      amount: Number(order.amount),
      points: order.points,
      payMethod: order.payment_channel,
      status: order.status,
      thirdPartyNo: order.third_party_order_no,
      paidAt: order.paid_at,
      createdAt: order.created_at,
    });
  } catch (err) {
    console.error("[orders] get error:", err);
    res.status(500).json({ error: "查询订单失败" });
  }
});

export default router;
