import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";

const router = Router();

/**
 * GET /
 * 获取当前用户的模型折扣列表（需登录）
 * 查询 user_model_discounts 表中 status=1 的折扣配置
 * 返回所有数据，由前端根据时间判断状态
 */
router.get("/", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;

  try {
    const [rows] = await (pool as any).execute(
      `SELECT id, user_id, discount_type, discount_value, models,
              start_time, end_time, status, remark, created_at, updated_at
       FROM user_model_discounts
       WHERE user_id = ?
         AND status = 1
       ORDER BY created_at DESC`,
      [userId]
    );

    const now = new Date();
    const data = (rows as any[]).map(d => {
      let modelsList: string[] = [];
      if (d.models) {
        try {
          const parsed = JSON.parse(d.models);
          modelsList = Array.isArray(parsed) ? parsed : [];
        } catch {
          modelsList = [];
        }
      }

      // 计算状态
      const startTime = d.start_time ? new Date(d.start_time) : null;
      const endTime = d.end_time ? new Date(d.end_time) : null;
      let statusText = "生效中";
      if (startTime && startTime > now) {
        statusText = "待生效";
      } else if (endTime && endTime < now) {
        statusText = "已过期";
      }

      return {
        ...d,
        models: modelsList,
        discount_value: parseFloat(d.discount_value) || 0,
        status_text: statusText,
      };
    });

    res.json({ success: true, data });
  } catch (e) {
    console.error("[Promotions] 获取模型折扣列表失败:", e);
    res.status(500).json({ success: false, error: "获取模型折扣列表失败" });
  }
});

export default router;
