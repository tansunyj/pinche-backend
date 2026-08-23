/**
 * 用量统计（挂载 /api/user/stats）
 * 直连网关库 proxy_logs 聚合：今日 / 本月 / 累计消费（cost_points 之和）。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const [rows] = await gatewayPool.execute(
      `SELECT
         COALESCE(SUM(quota_consumed), 0) AS total_consumption,
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN quota_consumed ELSE 0 END), 0) AS today_consumption,
         COALESCE(SUM(CASE WHEN YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE()) THEN quota_consumed ELSE 0 END), 0) AS month_consumption,
         COUNT(*) AS total_requests
       FROM proxy_logs
       WHERE user_id = ?`,
      [userId]
    );

    const row = (rows as any[])[0] || {};
    res.json({
      totalConsumption: Number(row.total_consumption) || 0,
      todayConsumption: Number(row.today_consumption) || 0,
      monthConsumption: Number(row.month_consumption) || 0,
      totalRequests: Number(row.total_requests) || 0,
    });
  } catch (err) {
    console.error("Get stats error:", err);
    res.status(500).json({ error: "获取统计失败" });
  }
});

export default router;
