/**
 * 营销活动路由
 *
 * 接口列表：
 *   GET    /promotion/config/:type         获取活动配置（公开）
 *   POST   /promotion/register              活动注册（自动发放活动 Token）
 *   GET    /promotion/my-token              获取当前用户的活动 Token
 *   GET    /promotion/stats/:type           获取活动统计（管理员）
 *
 * 流程：
 *   1. 用户访问落地页 /promo/:type
 *   2. 前端调用 GET /promotion/config/:type 获取活动信息
 *   3. 用户填写邮箱注册，调用 POST /promotion/register
 *   4. 系统自动创建用户 + 生成活动 Token（无限额度，限时）
 *   5. 用户可在个人中心查看活动 Token
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { body, validationResult, param } from "express-validator";
import { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import pool, { transaction } from "../db/mysql";
import UserService, { getPublicUser } from "../services/UserService";
import { issueAuthSession } from "../utils/auth-session-mysql";
import { verifyTurnstile } from "../utils/turnstile";
import { authMiddleware } from "../middleware/auth";
import StatsService from "../services/StatsService";

const router = Router();
const RELAY_API_URL = process.env.RELAY_API_URL || "http://localhost:3002";
const RELAY_ADMIN_KEY = process.env.RELAY_ADMIN_KEY || "";

// ============================================
// 类型定义
// ============================================

interface PromotionConfig extends RowDataPacket {
  id: number;
  promotion_type: string;
  name: string;
  description: string;
  start_at: Date;
  end_at: Date;
  token_expire_days: number;
  max_users: number;
  new_user_only: number;
  token_quota: number;
  token_models: string;
  token_channels: string;
  landing_page_title: string;
  landing_page_content: string;
  status: number;
}

interface PromotionRegistration extends RowDataPacket {
  id: number;
  promotion_type: string;
  user_id: number;
  token_id: number;
  created_at: Date;
}

interface UserRow extends RowDataPacket {
  id: number;
  email: string;
  name: string | null;
}

// ============================================
// 辅助函数
// ============================================

/**
 * 生成随机 API Key
 */
function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "sk-promo-";
  for (let i = 0; i < 32; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

/**
 * 在 relay 服务器创建活动 Token
 */
async function createPromotionToken(params: {
  userId: number;
  promotionType: string;
  expireAt: Date;
  quota: number;
  allowedModels: string[] | null;
  allowedChannels: string[] | null;
}): Promise<{ tokenId: number; apiKey: string } | null> {
  const { userId, promotionType, expireAt, quota, allowedModels, allowedChannels } = params;

  try {
    // 通过数据库直接插入（website_backend 和 api-relay 共用 MySQL 数据库）
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO proxy_tokens
       (user_id, \`key\`, name, quota, remain_quota, expired_at,
        status, promotion_type, allowed_models, allowed_channels, models)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '*')`,
      [
        userId,
        generateApiKey(),
        `活动Token-${promotionType}`,
        quota,
        quota, // 剩余额度等于总额度
        expireAt,
        promotionType,
        allowedModels ? JSON.stringify(allowedModels) : null,
        allowedChannels ? JSON.stringify(allowedChannels) : null,
      ]
    );

    // 获取刚创建的 token
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, \`key\` FROM proxy_tokens WHERE id = ?`,
      [result.insertId]
    );

    if (rows.length === 0) return null;

    return {
      tokenId: rows[0].id,
      apiKey: rows[0].key,
    };
  } catch (error) {
    console.error("[Promotion] 创建活动 Token 失败:", error);
    return null;
  }
}

/**
 * 检查用户是否已参与活动
 */
async function checkExistingRegistration(
  promotionType: string,
  userId: number
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM promotion_registrations
     WHERE promotion_type = ? AND user_id = ? AND status = 1`,
    [promotionType, userId]
  );
  return rows.length > 0;
}

/**
 * 获取活动参与人数
 */
async function getPromotionUserCount(promotionType: string): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) as count FROM promotion_registrations
     WHERE promotion_type = ? AND status = 1`,
    [promotionType]
  );
  return rows[0]?.count || 0;
}

// ============================================
// 路由
// ============================================

/**
 * GET /api/promotion/config/:type
 * 获取活动配置（公开接口）
 */
router.get(
  "/config/:type",
  [param("type").notEmpty().withMessage("活动类型不能为空")],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const promotionType = req.params.type;

    try {
      const [rows] = await pool.execute<PromotionConfig[]>(
        `SELECT promotion_type, name, description,
                start_at, end_at, token_expire_days,
                max_users, new_user_only,
                token_quota, token_models, token_channels,
                landing_page_title, landing_page_content, status
         FROM promotion_configs
         WHERE promotion_type = ? AND status = 1`,
        [promotionType]
      );

      if (rows.length === 0) {
        res.status(404).json({ error: "活动不存在或已结束" });
        return;
      }

      const config = rows[0];
      const now = new Date();
      const startAt = new Date(config.start_at);
      const endAt = new Date(config.end_at);

      // 检查活动状态
      if (now < startAt) {
        res.status(403).json({ error: "活动尚未开始", startAt: config.start_at });
        return;
      }

      if (now > endAt) {
        res.status(403).json({ error: "活动已结束" });
        return;
      }

      // 检查人数限制
      const userCount = await getPromotionUserCount(promotionType);
      if (config.max_users > 0 && userCount >= config.max_users) {
        res.status(403).json({ error: "活动名额已满" });
        return;
      }

      // 返回活动配置（不包含敏感信息）
      res.json({
        type: config.promotion_type,
        name: config.name,
        description: config.description,
        endAt: config.end_at,
        tokenExpireDays: config.token_expire_days,
        maxUsers: config.max_users,
        currentUsers: userCount,
        remainingSlots: config.max_users > 0 ? config.max_users - userCount : null,
        newUserOnly: config.new_user_only === 1,
        landingPageTitle: config.landing_page_title,
        landingPageContent: config.landing_page_content,
        allowedModels: config.token_models ? JSON.parse(config.token_models) : null,
      });
    } catch (error) {
      console.error("[Promotion] 获取活动配置失败:", error);
      res.status(500).json({ error: "获取活动信息失败" });
    }
  }
);

/**
 * POST /api/promotion/register
 * 活动注册（创建用户 + 发放活动 Token）
 */
router.post(
  "/register",
  [
    body("email").isEmail().withMessage("请输入有效邮箱").normalizeEmail(),
    body("password").isLength({ min: 6 }).withMessage("密码至少 6 个字符"),
    body("promotionType").notEmpty().withMessage("活动类型不能为空"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    // 人机验证
    const captchaResult = await verifyTurnstile(
      req.body?.captchaToken,
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip
    );
    if (!captchaResult.success) {
      res.status(400).json({ error: captchaResult.error || "人机验证未通过" });
      return;
    }

    const { email, password, promotionType, source } = req.body;
    const clientIp =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.ip ||
      null;
    const userAgent = req.headers["user-agent"] || null;

    try {
      // 1. 检查活动是否有效
      const [configRows] = await pool.execute<PromotionConfig[]>(
        `SELECT * FROM promotion_configs
         WHERE promotion_type = ? AND status = 1`,
        [promotionType]
      );

      if (configRows.length === 0) {
        res.status(404).json({ error: "活动不存在" });
        return;
      }

      const config = configRows[0];
      const now = new Date();
      const startAt = new Date(config.start_at);
      const endAt = new Date(config.end_at);

      if (now < startAt || now > endAt) {
        res.status(403).json({ error: "活动不在进行中" });
        return;
      }

      // 2. 检查人数限制
      const userCount = await getPromotionUserCount(promotionType);
      if (config.max_users > 0 && userCount >= config.max_users) {
        res.status(403).json({ error: "活动名额已满" });
        return;
      }

      // 3. 检查邮箱是否已注册
      const existingUser = await UserService.findByEmail(email);
      let userId: number;
      let isNewUser = false;

      if (existingUser) {
        // 已注册用户
        if (config.new_user_only === 1) {
          res.status(403).json({ error: "本活动仅限新用户参与" });
          return;
        }
        userId = existingUser.id;

        // 检查是否已参与过该活动
        const hasRegistered = await checkExistingRegistration(promotionType, userId);
        if (hasRegistered) {
          res.status(409).json({ error: "您已参与过该活动，每人仅限一次" });
          return;
        }
      } else {
        // 创建新用户
        const result = await UserService.createEmailUser({
          email,
          name: email.split("@")[0],
          password,
          invitedBy: null,
        });
        userId = result.userId;
        isNewUser = true;

        // 记录新用户注册统计
        StatsService.recordNewUser(userId);
      }

      // 4. 计算 Token 过期时间
      const tokenExpireAt = new Date();
      tokenExpireAt.setDate(tokenExpireAt.getDate() + config.token_expire_days);

      // 5. 创建活动 Token
      const tokenModels = config.token_models ? JSON.parse(config.token_models) : null;
      const tokenChannels = config.token_channels ? JSON.parse(config.token_channels) : null;

      const tokenResult = await createPromotionToken({
        userId,
        promotionType,
        expireAt: tokenExpireAt,
        quota: config.token_quota,
        allowedModels: tokenModels,
        allowedChannels: tokenChannels,
      });

      if (!tokenResult) {
        res.status(500).json({ error: "创建活动 Token 失败" });
        return;
      }

      // 记录Token创建统计
      StatsService.recordTokenCreated(tokenResult.tokenId, userId);

      // 6. 记录活动注册
      await pool.execute(
        `INSERT INTO promotion_registrations
         (promotion_type, user_id, token_id, ip_address, user_agent, source, status)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [promotionType, userId, tokenResult.tokenId, clientIp, userAgent, source || null]
      );

      // 7. 获取用户信息并创建会话
      const user = await UserService.findById(userId);
      if (!user) {
        res.status(500).json({ error: "用户查询失败" });
        return;
      }

      const { accessToken } = await issueAuthSession(user, res);

      // 8. 返回成功信息
      res.status(201).json({
        token: accessToken,
        user: getPublicUser(user),
        isNewUser,
        promotion: {
          type: promotionType,
          name: config.name,
          apiKey: tokenResult.apiKey,
          expireAt: tokenExpireAt.toISOString(),
          allowedModels: tokenModels,
          usageUrl: `${process.env.WEB_BASE_URL || "http://localhost:13000"}/studio`,
        },
        message: "活动参与成功！您的免费 Token 已发放，有效期 " + config.token_expire_days + " 天",
      });
    } catch (error: any) {
      console.error("[Promotion] 活动注册失败:", error);

      if (error?.code === "ER_DUP_ENTRY") {
        res.status(409).json({ error: "您已参与过该活动" });
        return;
      }

      res.status(500).json({ error: "注册失败，请稍后重试" });
    }
  }
);

/**
 * GET /api/promotion/my-token
 * 获取当前用户的活动 Token（需要登录）
 */
router.get("/my-token", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    res.status(401).json({ error: "未登录" });
    return;
  }

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT pr.promotion_type, pr.created_at,
              pt.key as api_key, pt.expired_at, pt.allowed_models, pt.allowed_channels,
              pc.name as promotion_name, pc.token_expire_days
       FROM promotion_registrations pr
       JOIN proxy_tokens pt ON pr.token_id = pt.id
       JOIN promotion_configs pc ON pr.promotion_type = pc.promotion_type
       WHERE pr.user_id = ? AND pr.status = 1 AND pt.status = 1
       ORDER BY pr.created_at DESC`,
      [userId]
    );

    const tokens = rows.map((row: any) => ({
      promotionType: row.promotion_type,
      promotionName: row.promotion_name,
      apiKey: row.api_key,
      createdAt: row.created_at,
      expiredAt: row.expired_at,
      allowedModels: row.allowed_models ? JSON.parse(row.allowed_models) : null,
      isExpired: new Date(row.expired_at) < new Date(),
    }));

    res.json({ tokens });
  } catch (error) {
    console.error("[Promotion] 获取活动 Token 失败:", error);
    res.status(500).json({ error: "获取活动 Token 失败" });
  }
});

/**
 * GET /api/promotion/stats/:type
 * 获取活动统计（管理员接口）
 */
router.get("/stats/:type", authMiddleware, async (req: Request, res: Response) => {
  // 简单权限检查：只有管理员可以查看（user_type = 1 或 2）
  const userType = (req as any).user?.userType;
  if (userType !== 1 && userType !== 2) {
    res.status(403).json({ error: "权限不足" });
    return;
  }

  const promotionType = req.params.type;

  try {
    // 获取活动基本信息
    const [configRows] = await pool.execute<PromotionConfig[]>(
      `SELECT * FROM promotion_configs WHERE promotion_type = ?`,
      [promotionType]
    );

    if (configRows.length === 0) {
      res.status(404).json({ error: "活动不存在" });
      return;
    }

    const config = configRows[0];

    // 获取统计数据
    const [statsRows] = await pool.execute<RowDataPacket[]>(
      `SELECT
        COUNT(*) as total_registrations,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN 1 END) as today_registrations,
        source,
        COUNT(*) as count
       FROM promotion_registrations
       WHERE promotion_type = ? AND status = 1
       GROUP BY source WITH ROLLUP`,
      [promotionType]
    );

    // Token 使用情况（从 proxy_request_logs 统计）
    const [usageRows] = await pool.execute<RowDataPacket[]>(
      `SELECT
        COUNT(*) as total_requests,
        COUNT(DISTINCT token_id) as active_tokens,
        SUM(quota_consumed) as total_quota
       FROM proxy_request_logs
       WHERE token_id IN (
         SELECT token_id FROM promotion_registrations WHERE promotion_type = ?
       )`,
      [promotionType]
    );

    res.json({
      promotion: {
        type: config.promotion_type,
        name: config.name,
        status: config.status,
        startAt: config.start_at,
        endAt: config.end_at,
        maxUsers: config.max_users,
      },
      stats: {
        totalRegistrations: statsRows[0]?.total_registrations || 0,
        uniqueUsers: statsRows[0]?.unique_users || 0,
        todayRegistrations: statsRows[0]?.today_registrations || 0,
        totalRequests: usageRows[0]?.total_requests || 0,
        activeTokens: usageRows[0]?.active_tokens || 0,
        totalQuota: usageRows[0]?.total_quota || 0,
        sourceBreakdown: statsRows.filter((r: any) => r.source !== null),
      },
    });
  } catch (error) {
    console.error("[Promotion] 获取活动统计失败:", error);
    res.status(500).json({ error: "获取统计失败" });
  }
});

export default router;
