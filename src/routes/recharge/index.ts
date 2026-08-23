/**
 * 充值（挂载 /api/recharge）
 *
 *   GET  /tiers         充值档位列表（公开）
 *   POST /create        创建充值订单（用户 JWT）→ 返回支付宝扫码内容
 *   POST /callback      支付宝回调（form-urlencoded，返回纯文本 success）
 *
 * 到账流程（§2.6）：回调仅验签+记流水 → 异步 Worker 加余额+清缓存 → 更新流水状态
 */

import { Router, Request, Response } from "express";
import express from "express";
import crypto from "crypto";
import { userAuth } from "../../middlewares/userAuth";
import { cpQuery } from "../../config/db";
import alipay from "../../services/payment/alipay";
import {
  enqueueCreditTask,
  processPendingCreditTasks,
} from "../../services/payment/credit";

const router = Router();

// ============ 充值档位列表 ============
router.get("/tiers", async (_req: Request, res: Response) => {
  try {
    const rows = await cpQuery(
      "SELECT id, amount_yuan, quota, display_order FROM pt_recharge_tiers WHERE enabled = TRUE ORDER BY display_order ASC"
    );
    res.json({
      tiers: (Array.isArray(rows) ? rows : []).map((t: any) => ({
        id: t.id,
        amountYuan: Number(t.amount_yuan),
        quota: Number(t.quota),
        displayOrder: t.display_order,
      })),
    });
  } catch (err) {
    console.error("List tiers error:", err);
    res.status(500).json({ error: "获取充值档位失败" });
  }
});

// ============ 我的充值记录 ============
router.get("/orders", userAuth, async (req: Request, res: Response) => {
  try {
    const ptUserId = req.user!.userId;
    if (!ptUserId) {
      res.json({ orders: [], pagination: { page: 1, pageSize: 20, total: 0 } });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const totalRows = await cpQuery("SELECT COUNT(*) AS cnt FROM pt_payments WHERE user_id = ?", [ptUserId]);
    const total = Number((Array.isArray(totalRows) ? totalRows[0] : totalRows).cnt || 0);

    const rows = await cpQuery(
      `SELECT id, order_no, amount_yuan, quota, provider, status, paid_at, created_at FROM pt_payments WHERE user_id = ? ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      [ptUserId]
    );

    res.json({
      orders: (Array.isArray(rows) ? rows : []).map((p: any) => ({
        id: p.id,
        orderNo: p.order_no,
        amountYuan: Number(p.amount_yuan),
        quota: Number(p.quota),
        provider: p.provider,
        status: p.status,
        paidAt: p.paid_at,
        createdAt: p.created_at,
      })),
      pagination: { page, pageSize, total },
    });
  } catch (err) {
    console.error("My recharge orders error:", err);
    res.status(500).json({ error: "获取充值记录失败" });
  }
});

// ============ 创建充值订单 ============
// 支持两种入参：tierId（档位充值，优先）或 amountYuan（自定义金额充值）
const MIN_RECHARGE_YUAN = 0.01;
const MAX_RECHARGE_YUAN = 10000;

router.post("/create", userAuth, async (req: Request, res: Response) => {
  try {
    const ptUserId = req.user!.userId;
    if (!ptUserId) {
      res.status(400).json({ error: "请先完成开户（重新登录）" });
      return;
    }

    const rawTierId = Number(req.body?.tierId);
    const rawAmountYuan = req.body?.amountYuan;

    let tierId: number | null = null;
    let amountYuan: number;
    let quota: number;

    if (rawTierId && Number.isInteger(rawTierId)) {
      // —— 档位充值 ——
      const tiers = await cpQuery("SELECT * FROM pt_recharge_tiers WHERE id = ? AND enabled = TRUE LIMIT 1", [rawTierId]);
      const tier = Array.isArray(tiers) ? tiers[0] : null;
      if (!tier) {
        res.status(404).json({ error: "充值档位不存在或已下架" });
        return;
      }
      tierId = tier.id;
      amountYuan = Number(tier.amount_yuan);
      quota = Number(tier.quota);
    } else if (rawAmountYuan !== undefined && rawAmountYuan !== null && rawAmountYuan !== "") {
      // —— 自定义金额充值（tier_id 存 NULL）——
      amountYuan = Number(rawAmountYuan);
      if (!Number.isFinite(amountYuan) || amountYuan <= 0) {
        res.status(400).json({ error: "请输入有效金额" });
        return;
      }
      if (amountYuan < MIN_RECHARGE_YUAN || amountYuan > MAX_RECHARGE_YUAN) {
        res.status(400).json({ error: `单次充值金额需在 ${MIN_RECHARGE_YUAN} ~ ${MAX_RECHARGE_YUAN} 元之间` });
        return;
      }
      // 保留两位小数；额度口径：1 元 = 100000 额度
      amountYuan = Math.round(amountYuan * 100) / 100;
      quota = Math.round(amountYuan * 100000);
    } else {
      res.status(400).json({ error: "参数错误：缺少 tierId 或 amountYuan" });
      return;
    }

    const orderNo = `PT${Date.now()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    // 记录流水（PENDING）
    await cpQuery(
      "INSERT INTO pt_payments (order_no, user_id, tier_id, amount_yuan, quota, provider, status) VALUES (?, ?, ?, ?, ?, 'ALIPAY', 'PENDING')",
      [orderNo, ptUserId, tierId, amountYuan, quota]
    );

    const result = await alipay.createPayment({
      orderNo,
      amountYuan,
      subject: `拼车充值 ¥${amountYuan}`,
    });

    res.json({
      orderNo,
      qrCodeContent: result.qrCodeContent,
      amountYuan,
      quota,
      dryRun: alipay.isDryRun(),
    });
  } catch (err: any) {
    console.error("Create recharge error:", err);
    res.status(500).json({ error: err?.message || "创建充值订单失败" });
  }
});

// ============ 查询订单状态（前端扫码支付轮询）============
// 回调不可达/漏单时的兜底：主动查支付宝订单，支付成功则幂等到账。
// 到账走 pt_payment_tasks worker，仍保留异步可靠入账语义。
const lastLiveCheck: Record<string, number> = {};
const LIVE_CHECK_INTERVAL_MS = 15000; // 主动查支付宝最小间隔，避免高频打网关

router.get("/status", userAuth, async (req: Request, res: Response) => {
  try {
    const ptUserId = req.user!.userId;
    const orderNo = String(req.query.orderNo || "");
    if (!ptUserId || !orderNo) {
      res.status(400).json({ error: "参数错误" });
      return;
    }

    const pays = await cpQuery(
      "SELECT * FROM pt_payments WHERE order_no = ? AND user_id = ? LIMIT 1",
      [orderNo, ptUserId]
    );
    const payment = Array.isArray(pays) ? pays[0] : null;
    if (!payment) {
      res.status(404).json({ error: "订单不存在" });
      return;
    }

    let status: string = payment.status;

    // 回调已收到但待到账 → 主动触发 worker 加速入账（幂等）
    if (status === "CALLBACK_RECEIVED") {
      try {
        await processPendingCreditTasks(10);
      } catch (e) {
        console.error(`[Recharge] 触发到账失败 ${orderNo}:`, (e as Error).message);
      }
      const pays2 = await cpQuery("SELECT status FROM pt_payments WHERE id = ? LIMIT 1", [payment.id]);
      status = (Array.isArray(pays2) && pays2[0]?.status) || status;
    }

    // 仍待支付且下单超 20s → 主动查支付宝补漏单
    if (status === "PENDING") {
      const ageMs = Date.now() - new Date(payment.created_at).getTime();
      const now = Date.now();
      if (ageMs > 20000 && now - (lastLiveCheck[orderNo] || 0) > LIVE_CHECK_INTERVAL_MS) {
        lastLiveCheck[orderNo] = now;
        try {
          const q = await alipay.queryOrder(orderNo);
          if (q.status === "paid") {
            await handlePaid(orderNo, q.thirdPartyNo || "", Number(payment.amount_yuan));
            await processPendingCreditTasks(10);
          }
        } catch (e) {
          console.error(`[Recharge] 查询订单 ${orderNo} 失败:`, (e as Error).message);
        }
        const pays2 = await cpQuery("SELECT status FROM pt_payments WHERE id = ? LIMIT 1", [payment.id]);
        status = (Array.isArray(pays2) && pays2[0]?.status) || status;
      }
    }

    res.json({ orderNo, status });
  } catch (err) {
    console.error("Recharge status error:", err);
    res.status(500).json({ error: "查询支付状态失败" });
  }
});

// ============ 支付宝回调 ============
// 支付宝 POST 是 application/x-www-form-urlencoded，需独立解析
const urlencoded = express.urlencoded({ extended: false });

router.post("/callback", urlencoded, async (req: Request, res: Response) => {
  try {
    const bodyStr = Object.keys(req.body)
      .map((k) => `${k}=${typeof req.body[k] === "string" ? req.body[k] : JSON.stringify(req.body[k])}`)
      .join("&");
    const verified = await alipay.verifyNotify(bodyStr);

    if (verified.status === "paid") {
      await handlePaid(verified.orderNo, verified.thirdPartyNo, verified.amount);
    }
    // 支付宝要求：无论成功与否都要返回纯文本 success（否则会重试）
    res.send("success");
  } catch (err: any) {
    console.error("Alipay callback error:", err);
    // 验签失败：不返回 success，触发支付宝重试（便于排查）
    res.status(400).send("fail");
  }
});

async function handlePaid(orderNo: string, thirdPartyNo: string, amount: number) {
  // 幂等：同一订单只处理一次
  await cpQuery(
    "INSERT IGNORE INTO pt_idempotent_keys (biz_type, biz_key) VALUES ('RECHARGE', ?)",
    [orderNo]
  );
  const idem = await cpQuery(
    "SELECT id FROM pt_idempotent_keys WHERE biz_type = 'RECHARGE' AND biz_key = ?",
    [orderNo]
  );
  if (!Array.isArray(idem) || idem.length === 0) return; // 已处理过

  const pays = await cpQuery("SELECT * FROM pt_payments WHERE order_no = ? LIMIT 1", [orderNo]);
  const payment = Array.isArray(pays) ? pays[0] : null;
  if (!payment) {
    console.error(`[Recharge] 订单不存在: ${orderNo}`);
    return;
  }

  // 金额校验：回调实付金额与订单金额不一致时告警（不阻断，以订单金额入账为准）
  const expected = Number(payment.amount_yuan);
  if (Math.abs(amount - expected) > 0.01) {
    console.warn(`[Recharge] 订单 ${orderNo} 实付 ${amount} 与订单金额 ${expected} 不一致`);
  }

  // 流水状态推进 → 入队到账任务
  await cpQuery(
    "UPDATE pt_payments SET status = 'CALLBACK_RECEIVED', out_trade_no = ?, paid_at = NOW() WHERE id = ? AND status IN ('PENDING','CALLBACK_RECEIVED')",
    [thirdPartyNo, payment.id]
  );
  await enqueueCreditTask(payment.id, orderNo);
}

export default router;
