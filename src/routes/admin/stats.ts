/**
 * 管理端统计（挂载 /api/admin/stats）
 *
 *   GET /overview        运营总览（用户/车次/折扣/充值）
 *   GET /recharge-trend  近 N 天充值趋势
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

router.get("/overview", async (_req: Request, res: Response) => {
  try {
    const [users, rides, members, payments] = await Promise.all([
      cpQuery("SELECT COUNT(*) AS cnt FROM pt_users"),
      cpQuery("SELECT COUNT(*) AS total, SUM(status='ACTIVE') AS active_cnt FROM pt_rides"),
      cpQuery("SELECT COUNT(DISTINCT user_id) AS cnt FROM pt_ride_members WHERE status='ACTIVE'"),
      cpQuery("SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_yuan),0) AS total_yuan FROM pt_payments WHERE status='SUCCESS'"),
    ]);

    res.json({
      users: Number((users[0] as any).cnt || 0),
      rides: {
        total: Number((rides[0] as any).total || 0),
        active: Number((rides[0] as any).active_cnt || 0),
      },
      activeMembers: Number((members[0] as any).cnt || 0),
      recharge: {
        orderCount: Number((payments[0] as any).cnt || 0),
        amountYuan: Number((payments[0] as any).total_yuan || 0),
      },
      // 车次已不再读写 user_model_discounts，折扣统计置空
      discounts: { total: 0, active: 0 },
    });
  } catch (err) {
    console.error("Admin stats overview error:", err);
    res.status(500).json({ error: "获取统计失败" });
  }
});

router.get("/recharge-trend", async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "7"), 10)));
    const rows = await cpQuery(
      `SELECT DATE(paid_at) AS d, COUNT(*) AS cnt, COALESCE(SUM(amount_yuan),0) AS total_yuan
       FROM pt_payments
       WHERE status='SUCCESS' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(paid_at)
       ORDER BY d ASC`,
      [days - 1]
    );
    res.json({ days, trend: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error("Admin recharge trend error:", err);
    res.status(500).json({ error: "获取充值趋势失败" });
  }
});

export default router;
