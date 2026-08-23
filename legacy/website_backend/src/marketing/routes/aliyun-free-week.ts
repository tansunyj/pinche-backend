/**
 * 营销活动路由 - 极简版（阿里云免费周）
 *
 * POST /api/promotion/claim
 *   领取活动Token（限阿里云模型，7天有效，无限额度）
 *
 * GET /api/promotion/my-token
 *   查看当前用户的活动Token
 */

import { Router, Request, Response } from "express";
import { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import pool from "../../db/mysql";
import { authMiddleware } from "../../middleware/auth";

const router = Router();

// 活动配置（硬编码，简单快速）
const PROMOTION_CONFIG = {
  type: 'aliyun_free_week_2026',
  name: '阿里云百炼模型免费体验周',
  // 活动开始时间（2026年5月25日 00:00:00）
  startDate: new Date('2026-05-25T00:00:00+08:00'),
  // 活动结束时间（2026年5月31日 23:59:59）
  endDate: new Date('2026-05-31T23:59:59+08:00'),
  // 7天后过期
  getExpireAt: () => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date;
  },
  // 可用模型列表（精确匹配）
  allowedModels: [
    // 阿里云百炼模型
    'qwen-image-2.0',
    'qwen-image-2.0-pro',
    'wan2.7-image-pro',
    'wan2.7-image',
    'qwen-max',
    'qwen3.6-flash-2026-04-16',
    'qwen3.6-flash',
    'qwen3.6-max-preview',
    'qwen3.6-plus-2026-04-02',
    'qwen3.6-plus',
    // DeepSeek模型
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    // Kimi模型
    'kimi-k2.6',
    // 生视频模型
    'happyhorse-1.0-i2v',
    'happyhorse-1.0-t2v',
    'happyhorse-1.0-r2v',
    // GLM模型
    'glm-5.1',
    'glm-5',
  ],
  // token.models 字段存储格式（逗号分隔）
  get modelsString() {
    return this.allowedModels.join(',');
  },
  // Token配额（0表示无限）
  quota: 0,
  // 剩余配额（0表示无限）
  remainQuota: 0,
};

/**
 * 检查当前是否在活动时间内
 * @returns { isActive: boolean; status: 'upcoming' | 'active' | 'ended'; message: string }
 */
function checkPromotionPeriod(): { isActive: boolean; status: 'upcoming' | 'active' | 'ended'; message: string } {
  const now = new Date();
  const { startDate, endDate } = PROMOTION_CONFIG;

  if (now < startDate) {
    return {
      isActive: false,
      status: 'upcoming',
      message: `活动将于 ${startDate.toLocaleString('zh-CN')} 开始，敬请期待！`,
    };
  }

  if (now > endDate) {
    return {
      isActive: false,
      status: 'ended',
      message: '活动已结束，感谢您的关注！',
    };
  }

  return {
    isActive: true,
    status: 'active',
    message: '活动进行中',
  };
}

/**
 * 生成随机API Key
 */
function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "sk-aliyun-";
  for (let i = 0; i < 32; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

/**
 * POST /api/promotion/claim
 * 领取活动Token（需要登录、已充值且余额≥9.9元）
 */
router.post("/claim", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    res.status(401).json({ error: "请先登录" });
    return;
  }

  // 检查活动时间（仅用于提示，不阻断领取）
  const periodCheck = checkPromotionPeriod();

  try {
    // 1. 检查用户充值记录和余额
    const [userRows] = await pool.execute<RowDataPacket[]>(
      `SELECT cumulative_recharge, balance FROM user_users WHERE id = ?`,
      [userId]
    );

    if (userRows.length === 0) {
      res.status(403).json({ error: "用户不存在" });
      return;
    }

    const cumulativeRecharge = Number(userRows[0].cumulative_recharge || 0);
    const balance = Number(userRows[0].balance || 0);

    // 检查是否有充值记录（1元 = 100分）
    if (cumulativeRecharge < 100) {
      res.status(403).json({
        error: "活动仅限已充值用户参与",
        message: "请先充值任意金额后再领取活动Token",
        required: 100,
        current: cumulativeRecharge,
      });
      return;
    }

    // 检查余额是否≥9.9元（9.9元 = 990分）
    if (balance < 990) {
      res.status(403).json({
        error: "余额不足",
        message: "账户余额需≥9.9元才能领取活动Token，请先充值",
        required: 990,
        current: balance,
        requiredYuan: 9.9,
        currentYuan: (balance / 100).toFixed(2),
      });
      return;
    }

    // 2. 检查是否已领取（使用数据库连接防止并发）
    // 获取连接以支持事务
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 加锁查询，防止并发重复领取
      const [existing] = await connection.execute<RowDataPacket[]>(
        `SELECT id, \`key\`, expired_at, status
         FROM proxy_tokens
         WHERE user_id = ? AND name = ?
         FOR UPDATE`,
        [userId, PROMOTION_CONFIG.name]
      );

      if (existing.length > 0) {
        const token = existing[0];
        // 检查是否过期
        if (token.status === 1 && new Date(token.expired_at) > new Date()) {
          await connection.rollback();
          res.status(409).json({
            error: "您已领取过活动Token",
            token: {
              apiKey: token.key,
              expireAt: token.expired_at,
            },
          });
          return;
        }
        // 已过期可以重新领取，先删除旧记录
        await connection.execute(
          `DELETE FROM proxy_tokens WHERE id = ?`,
          [token.id]
        );
      }

      // 3. 创建新的活动Token
      // Token生效时间：活动开始时间 2026-05-25 00:00:00
      // Token过期时间：活动结束时间 2026-05-31 23:59:59
      const startAt = PROMOTION_CONFIG.startDate;
      const expireAt = PROMOTION_CONFIG.endDate;
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO proxy_tokens
         (user_id, name, \`key\`, quota, remain_quota, start_at, expired_at, status, models)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          userId,
          PROMOTION_CONFIG.name,
          generateApiKey(),
          PROMOTION_CONFIG.quota,
          PROMOTION_CONFIG.quota,
          startAt,
          expireAt,
          PROMOTION_CONFIG.modelsString,
        ]
      );

      await connection.commit();

      // 4. 返回Token信息
      const [newToken] = await pool.execute<RowDataPacket[]>(
        `SELECT \`key\`, expired_at FROM proxy_tokens WHERE id = ?`,
        [result.insertId]
      );

      res.json({
        success: true,
        message: "领取成功！",
        token: {
          apiKey: newToken[0].key,
          expireAt: newToken[0].expired_at,
          allowedModels: PROMOTION_CONFIG.allowedModels,
          note: "仅限使用阿里云百炼模型（Qwen、WanX系列）",
        },
        activity: {
          status: periodCheck.status,
          startDate: PROMOTION_CONFIG.startDate.toISOString(),
          endDate: PROMOTION_CONFIG.endDate.toISOString(),
          message: periodCheck.status === 'upcoming' ? '活动尚未开始，Token将在活动开始时生效' : periodCheck.message,
        },
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("[Promotion] 领取失败:", error);
    res.status(500).json({ error: "领取失败，请稍后重试" });
  }
});

/**
 * GET /api/promotion/my-token
 * 查看当前用户的活动Token
 */
router.get("/my-token", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    res.status(401).json({ error: "未登录" });
    return;
  }

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT \`key\`, expired_at, status, used_quota, created_at
       FROM proxy_tokens
       WHERE user_id = ? AND name = ?
       ORDER BY created_at DESC LIMIT 1`,
      [userId, PROMOTION_CONFIG.name]
    );

    if (rows.length === 0) {
      res.json({ hasToken: false });
      return;
    }

    const token = rows[0];
    const isExpired = token.status !== 1 || new Date(token.expired_at) <= new Date();

    res.json({
      hasToken: true,
      token: {
        apiKey: token.key,
        expireAt: token.expired_at,
        isExpired,
        usedQuota: token.used_quota,
        createdAt: token.created_at,
        allowedModels: PROMOTION_CONFIG.allowedModels,
      },
    });
  } catch (error) {
    console.error("[Promotion] 查询失败:", error);
    res.status(500).json({ error: "查询失败" });
  }
});

/**
 * GET /api/promotion/config
 * 获取活动配置（公开接口）
 */
router.get("/config", async (_req: Request, res: Response) => {
  const periodCheck = checkPromotionPeriod();

  res.json({
    type: PROMOTION_CONFIG.type,
    name: PROMOTION_CONFIG.name,
    allowedModels: PROMOTION_CONFIG.allowedModels,
    durationDays: 7,
    quota: '无限额度',
    // 活动时间信息
    startDate: PROMOTION_CONFIG.startDate.toISOString(),
    endDate: PROMOTION_CONFIG.endDate.toISOString(),
    status: periodCheck.status,
    statusMessage: periodCheck.message,
    // 格式化后的日期（方便前端显示）
    display: {
      startDate: PROMOTION_CONFIG.startDate.toLocaleDateString('zh-CN'),
      endDate: PROMOTION_CONFIG.endDate.toLocaleDateString('zh-CN'),
      period: `${PROMOTION_CONFIG.startDate.toLocaleDateString('zh-CN')} ~ ${PROMOTION_CONFIG.endDate.toLocaleDateString('zh-CN')}`,
    }
  });
});

export default router;
