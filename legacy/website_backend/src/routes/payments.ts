/**
 * 支付相关路由
 *
 *   [auth] POST   /api/payments/create               下单 + 拿支付参数（qr/url）
 *   [auth] GET    /api/payments/orders                我的订单列表（分页）
 *   [auth] GET    /api/payments/orders/:orderNo       查单（前端轮询用）
 *   [auth] POST   /api/payments/cancel/:orderNo       用户主动取消未支付订单
 *   [public] POST /api/payments/notify/:provider      第三方异步回调（必须 raw body 验签）
 *   [public] GET  /api/payments/providers             前端拿可用通道 + dryRun 标记
 */

import express, { Router, Request, Response } from "express";
import { body, validationResult } from "express-validator";
import { authMiddleware } from "../middleware/auth";
import BillingService, { PayMethod } from "../services/BillingService";
import { getProvider, listAvailableProviders } from "../services/payments";

const router = Router();

// ============ 公开：可用通道 ============
router.get("/providers", (_req: Request, res: Response) => {
  res.json({ providers: listAvailableProviders() });
});

// ============ 创建订单 + 发起支付 ============
router.post(
  "/create",
  authMiddleware,
  [
    body("amount")
      .isFloat({ gt: 0, lt: 100000 })
      .withMessage("金额必须为正数且小于 100000"),
    body("payMethod")
      .isIn(["alipay", "wechat"])
      .withMessage("支付方式仅支持 alipay / wechat"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { amount, payMethod } = req.body as { amount: number; payMethod: PayMethod };

    try {
      const provider = getProvider(payMethod);
      if (!provider) {
        res.status(400).json({ error: `不支持的支付方式: ${payMethod}` });
        return;
      }

      const clientIp =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.ip ||
        null;
      const userAgent = (req.headers["user-agent"] as string) || null;

      const order = await BillingService.createOrder({
        userId: req.user!.userId,
        amount: Number(amount),
        payMethod,
        clientIp,
        userAgent,
      });

      const payResult = await provider.createPayment(order);

      res.json({
        order: {
          orderNo: order.order_no,
          amount: Number(order.amount),
          points: order.points,
          status: order.status,
          expiredAt: order.expired_at,
          payMethod: order.payment_channel,
        },
        payment: {
          qrCodeContent: payResult.qrCodeContent || null,
          payPageUrl: payResult.payPageUrl || null,
          h5Url: payResult.h5Url || null,
          dryRun: provider.isDryRun(),
        },
      });
    } catch (err: any) {
      console.error("[payments] create error:", err);
      res.status(500).json({ error: err?.message || "下单失败" });
    }
  }
);

// ============ 我的订单列表 ============
router.get("/orders", authMiddleware, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const orders = await BillingService.listUserOrders(req.user!.userId, {
      limit,
      offset,
    });
    res.json({
      orders: orders.map((o) => ({
        orderNo: o.order_no,
        amount: Number(o.amount),
        points: o.points,
        payMethod: o.payment_channel,
        status: o.status,
        thirdPartyNo: o.third_party_order_no,
        paidAt: o.paid_at,
        createdAt: o.created_at,
      })),
    });
  } catch (err) {
    console.error("[payments] list orders error:", err);
    res.status(500).json({ error: "查询订单失败" });
  }
});

// ============ 查单（前端轮询用） ============
router.get(
  "/orders/:orderNo",
  authMiddleware,
  async (req: Request, res: Response) => {
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
        expiredAt: order.expired_at,
        createdAt: order.created_at,
      });
    } catch (err) {
      console.error("[payments] get order error:", err);
      res.status(500).json({ error: "查询订单失败" });
    }
  }
);

// ============ 用户主动取消 ============
router.post(
  "/cancel/:orderNo",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const order = await BillingService.cancelOrder(req.params.orderNo, req.user!.userId);
      res.json({
        message: "订单已取消",
        orderNo: order.order_no,
        status: order.status,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "取消失败" });
    }
  }
);

// ============ 异步回调（第三方支付服务器调用）============
// 注意：必须用 raw body 才能验签
// - alipay 发 application/x-www-form-urlencoded
// - wechat V3 发 application/json，验签需要原始 buffer
router.post(
  "/notify/:provider",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req: Request, res: Response) => {
    const providerName = req.params.provider;
    console.log(`\n========== [Notify] received ${providerName} ==========`);
    console.log(`[Notify] headers:`, {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
      "wechatpay-signature": req.headers["wechatpay-signature"],
      "wechatpay-serial": req.headers["wechatpay-serial"],
    });

    const provider = getProvider(providerName);
    if (!provider) {
      console.warn(`[Notify] 未知通道 ${providerName}`);
      res.status(404).send("provider not found");
      return;
    }

    try {
      const verified = await provider.verifyNotify(req.body as Buffer, req.headers);
      console.log(`[Notify] verified:`, verified);

      if (verified.status === "paid") {
        // 先查询订单获取用户信息（用于审计）
        const orderBefore = await BillingService.findByOrderNo(verified.orderNo);
        if (orderBefore) {
          // 设置 req.user，让审计系统能记录 actorId
          (req as any).user = {
            userId: orderBefore.user_id,
            userType: 1, // 普通用户
          };
          // 设置审计信息
          req.audit = {
            action: "order.pay",
            category: "user",
            targetType: "order",
            targetId: verified.orderNo,
            before: { status: orderBefore.status, paidAt: null },
            after: { status: "paid", thirdPartyNo: verified.thirdPartyNo },
          };
        }

        const result = await BillingService.markOrderPaid({
          orderNo: verified.orderNo,
          thirdPartyNo: verified.thirdPartyNo,
          paidAt: verified.paidAt,
        });

        // 如果之前没设置上（比如订单查询失败），这里再设置一次
        if (!req.audit && result.order) {
          (req as any).user = {
            userId: result.order.user_id,
            userType: 1,
          };
          req.audit = {
            action: "order.pay",
            category: "user",
            targetType: "order",
            targetId: verified.orderNo,
            after: { status: "paid", newBalance: result.newBalance },
          };
        }

        // 校验金额（防篡改）
        const expectedAmount = Number(result.order.amount);
        if (Math.abs(expectedAmount - verified.amount) > 0.01 && verified.amount > 0) {
          console.error(
            `[Notify] ⚠ 金额不符！订单=${expectedAmount} 回调=${verified.amount}（仍按订单金额入账，建议人工对账）`
          );
        }
      } else {
        console.log(`[Notify] status=${verified.status}，不入账`);
      }

      // 不同通道要求的"success"响应格式不同
      if (providerName === "alipay") {
        res.status(200).type("text/plain").send("success");
      } else if (providerName === "wechat") {
        res.status(200).json({ code: "SUCCESS", message: "成功" });
      } else {
        res.status(200).send("ok");
      }
    } catch (err: any) {
      console.error(`[Notify] ${providerName} 验签/处理失败:`, err);
      // 微信 / 支付宝在非 success 响应时会重试
      if (providerName === "wechat") {
        res.status(400).json({ code: "FAIL", message: err?.message || "处理失败" });
      } else {
        res.status(400).send("fail");
      }
    }
  }
);

export default router;
