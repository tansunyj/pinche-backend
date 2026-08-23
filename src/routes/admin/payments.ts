/**
 * 管理端充值流水（挂载 /api/admin/payments）
 *
 *   GET    /                 分页流水（支持 status / user_id 过滤）
 *   GET    /:id              流水详情 + 到账任务状态
 *   POST   /:id/retry        手动重试到账任务（仅超管）
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";
import { adminAuth, requireSuperAdmin } from "../../middlewares/adminAuth";
import { enqueueCreditTask } from "../../services/payment/credit";

const router = Router();
router.use(adminAuth);

router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10)));
    const status = String(req.query.status || "").trim();
    const userId = String(req.query.user_id || "").trim();
    const offset = (page - 1) * pageSize;

    const conds: string[] = [];
    const params: any[] = [];
    if (status) { conds.push("p.status = ?"); params.push(status); }
    if (userId) { conds.push("p.user_id = ?"); params.push(Number(userId)); }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const totalRows = await cpQuery(`SELECT COUNT(*) AS cnt FROM pt_payments p ${where}`, params);
    const total = Number((Array.isArray(totalRows) ? totalRows[0] : totalRows).cnt || 0);

    const rows = await cpQuery(
      `SELECT p.*, u.phone
       FROM pt_payments p
       LEFT JOIN pt_users u ON u.id = p.user_id
       ${where}
       ORDER BY p.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    res.json({
      total,
      page,
      pageSize,
      payments: (Array.isArray(rows) ? rows : []).map((p: any) => ({
        id: p.id,
        orderNo: p.order_no,
        userId: p.user_id,
        phone: p.phone,
        tierId: p.tier_id,
        amountYuan: Number(p.amount_yuan),
        quota: Number(p.quota),
        provider: p.provider,
        status: p.status,
        outTradeNo: p.out_trade_no,
        paidAt: p.paid_at,
        createdAt: p.created_at,
      })),
    });
  } catch (err) {
    console.error("Admin payments list error:", err);
    res.status(500).json({ error: "获取流水失败" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const rows = await cpQuery("SELECT * FROM pt_payments WHERE id = ? LIMIT 1", [req.params.id]);
    const payment = Array.isArray(rows) ? rows[0] : null;
    if (!payment) {
      res.status(404).json({ error: "流水不存在" });
      return;
    }
    const tasks = await cpQuery("SELECT * FROM pt_payment_tasks WHERE payment_id = ? ORDER BY id DESC", [payment.id]);
    res.json({ payment, tasks: Array.isArray(tasks) ? tasks : [] });
  } catch (err) {
    console.error("Admin payment detail error:", err);
    res.status(500).json({ error: "获取流水详情失败" });
  }
});

router.post("/:id/retry", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await cpQuery("SELECT * FROM pt_payments WHERE id = ? LIMIT 1", [req.params.id]);
    const payment = Array.isArray(rows) ? rows[0] : null;
    if (!payment) {
      res.status(404).json({ error: "流水不存在" });
      return;
    }
    if (payment.status === "SUCCESS") {
      res.status(400).json({ error: "该订单已到账，无需重试" });
      return;
    }
    // 置回 PENDING 并重新入队
    await cpQuery(
      "UPDATE pt_payments SET status = 'PENDING' WHERE id = ? AND status IN ('PENDING','CALLBACK_RECEIVED','PROCESSING','FAILED')",
      [payment.id]
    );
    await cpQuery(
      "UPDATE pt_payment_tasks SET status = 'FAILED' WHERE payment_id = ? AND status IN ('PENDING','PROCESSING')",
      [payment.id]
    );
    await enqueueCreditTask(payment.id, payment.order_no);
    res.json({ success: true, message: "已重新入队到账任务" });
  } catch (err) {
    console.error("Admin payment retry error:", err);
    res.status(500).json({ error: "重试失败" });
  }
});

export default router;
