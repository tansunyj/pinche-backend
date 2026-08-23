import { Router, Request, Response } from "express";
import type { ResultSetHeader } from "mysql2";
import pool from "../db/mysql";
import redis from "../utils/redis";
import { authMiddleware } from "../middleware/auth";

const router = Router();
const REDIS_KEY = "promotions:active";

/**
 * GET /api/promotions
 * 公开：优先从 Redis 读取已上线活动列表
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    // 先读 Redis
    const cached = await redis.get(REDIS_KEY);
    if (cached) {
      res.json({ success: true, data: JSON.parse(cached) });
      return;
    }
    // 缓存未命中，查数据库
    const [rows] = await (pool as any).execute(
      `SELECT id, name, description, start_at, end_at,
              discount_rate, gift_amount, gift_ratio, rpm_limit,
              models, max_per_user, total_limit, issued_count
       FROM promotions
       WHERE is_online = 1 AND end_at >= NOW()
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error("[Promotions] 获取活动列表失败:", e);
    res.status(500).json({ success: false, error: "获取活动列表失败" });
  }
});

/**
 * POST /api/promotions/:id/claim
 * 用户领取活动（需登录）
 */
router.post("/:id/claim", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. 锁定并读取活动（FOR UPDATE 防止并发超额领取）
    const [rows] = await connection.execute(
      `SELECT * FROM promotions WHERE id = ? AND is_online = 1 AND end_at >= NOW() FOR UPDATE`,
      [id]
    );
    const promotion = (rows as any[])[0];
    if (!promotion) {
      await connection.rollback();
      res.status(404).json({ success: false, error: "活动不存在或已结束" });
      return;
    }

    // 2. 检查总量限制（行锁确保并发安全）
    if (promotion.total_limit > 0 && promotion.issued_count >= promotion.total_limit) {
      await connection.rollback();
      res.status(403).json({ success: false, error: "活动名额已满" });
      return;
    }

    // 3. 检查用户已领取次数
    const [existing] = await connection.execute(
      `SELECT COUNT(*) as count FROM user_coupons WHERE user_id = ? AND promotion_id = ?`,
      [userId, id]
    );
    const claimedCount = (existing as any[])[0]?.count || 0;
    const maxPerUser = promotion.max_per_user || 1;
    if (claimedCount >= maxPerUser) {
      await connection.rollback();
      res.status(409).json({
        success: false,
        error: `您已领取该活动 ${claimedCount} 次，每人限领 ${maxPerUser} 次`,
      });
      return;
    }

    // 4. 插入优惠券记录
    await connection.execute(
      `INSERT INTO user_coupons (user_id, promotion_id, source, status, expired_at)
       VALUES (?, ?, 'claimed', 'active', ?)`,
      [userId, id, promotion.end_at]
    );

    // 5. 原子性更新已发放数量
    const [updateResult] = await connection.execute<ResultSetHeader>(
      `UPDATE promotions SET issued_count = issued_count + 1 WHERE id = ? AND (total_limit = 0 OR issued_count < total_limit)`,
      [id]
    );
    if ((updateResult as any).affectedRows === 0) {
      await connection.rollback();
      res.status(403).json({ success: false, error: "活动名额已满" });
      return;
    }

    // 6. 如果有赠送金额，立即到账
    if (promotion.gift_amount > 0) {
      await connection.execute(
        `UPDATE user_users SET balance = balance + ? WHERE id = ?`,
        [promotion.gift_amount, userId]
      );
    }

    await connection.commit();
    res.json({ success: true, message: "领取成功" });
  } catch (e: any) {
    await connection.rollback();
    if (e?.code === "ER_DUP_ENTRY") {
      res.status(409).json({ success: false, error: "您已领取过该活动" });
      return;
    }
    console.error("[Promotions] 领取活动失败:", e);
    res.status(500).json({ success: false, error: "领取失败" });
  } finally {
    connection.release();
  }
});

/**
 * GET /api/promotions/my-coupons
 * 获取当前用户的优惠券列表（需登录）
 */
router.get("/my-coupons", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;

  try {
    const [rows] = await (pool as any).execute(
      `SELECT uc.*, p.name as promotion_name, p.description,
              p.discount_rate, p.gift_amount, p.gift_ratio, p.rpm_limit, p.models
       FROM user_coupons uc
       JOIN promotions p ON uc.promotion_id = p.id
       WHERE uc.user_id = ?
       ORDER BY uc.claimed_at DESC`,
      [userId]
    );

    // 判断是否已过期
    const now = new Date();
    const data = (rows as any[]).map(c => {
      const isExpired = c.status !== 'bound' && c.expired_at && new Date(c.expired_at) < now;
      return {
        ...c,
        is_expired: isExpired,
        // 如果数据库状态还是active但已过期，给前端一个提示状态
        display_status: isExpired ? 'expired' : c.status
      };
    });

    res.json({ success: true, data });
  } catch (e) {
    console.error("[Promotions] 获取优惠券失败:", e);
    res.status(500).json({ success: false, error: "获取优惠券失败" });
  }
});

/**
 * POST /api/promotions/coupons/:couponId/bind
 * 将优惠券绑定到指定 Token
 */
router.post("/coupons/:couponId/bind", authMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId;
  const { couponId } = req.params;
  const { token_id } = req.body;

  if (!token_id) {
    res.status(400).json({ success: false, error: "请选择要绑定的 API Key" });
    return;
  }

  try {
    // 验证优惠券属于当前用户且状态为 active
    const [coupons] = await (pool as any).execute(
      `SELECT uc.*, p.discount_rate, p.gift_amount, p.gift_ratio, p.rpm_limit, p.models FROM user_coupons uc
       JOIN promotions p ON uc.promotion_id = p.id
       WHERE uc.id = ? AND uc.user_id = ? AND uc.status = 'active'`,
      [couponId, userId]
    );
    const coupon = (coupons as any[])[0];
    if (!coupon) {
      res.status(404).json({ success: false, error: "优惠券不存在或不可用" });
      return;
    }

    // 检查是否已过期
    if (coupon.expired_at && new Date(coupon.expired_at) < new Date()) {
      res.status(400).json({ success: false, error: "优惠券已过期" });
      return;
    }

    // 验证 Token 属于当前用户
    const [tokens] = await (pool as any).execute(
      `SELECT id, quota, used_quota, price_markup, gift_quota FROM proxy_tokens WHERE id = ? AND user_id = ?`,
      [token_id, userId]
    );
    if ((tokens as any[]).length === 0) {
      res.status(404).json({ success: false, error: "API Key 不存在" });
      return;
    }
    const token = (tokens as any[])[0];

    // 检查该 Token 是否已被其他优惠券绑定
    const [existing] = await (pool as any).execute(
      `SELECT id FROM user_coupons WHERE token_id = ? AND status = 'bound'`,
      [token_id]
    );
    if ((existing as any[]).length > 0) {
      res.status(409).json({ success: false, error: "该 API Key 已绑定了优惠券" });
      return;
    }

    // 计算对 proxy_tokens 的更新
    const discountRate = parseFloat(coupon.discount_rate) || 1.0;
    const giftAmount = parseInt(coupon.gift_amount) || 0;
    const giftRatio = parseFloat(coupon.gift_ratio) || 0;
    const currentQuota = parseInt(token.quota) || 0;
    const currentGiftQuota = parseInt((token as any).gift_quota) || 0;
    const usedQuota = parseInt(token.used_quota) || 0;

    let newQuota = currentQuota;
    let newGiftQuota = currentGiftQuota;
    let newPriceMarkup = parseFloat(token.price_markup) || 1.0;

    if (discountRate < 1 && discountRate > 0) {
      // 1. 折扣类型：直接设置 price_markup 为折扣率
      newPriceMarkup = discountRate;
    } else if (giftRatio > 0) {
      // 2. 赠送金额比例类型：quota = quota * (1 + giftRatio)
      const oldQuota = currentQuota;
      newQuota = Math.round(currentQuota * (1 + giftRatio));
      // 增加的部分计入 gift_quota
      newGiftQuota = currentGiftQuota + (newQuota - oldQuota);
    } else if (giftAmount > 0) {
      // 3. 赠送金额固定值类型
      // 单位统一后：promotions.gift_amount 和 quota 都是"点数"单位（1元=100000）
      // 不再需要进行 * 1000 转换
      newQuota = currentQuota + giftAmount;
      newGiftQuota = currentGiftQuota + giftAmount;
    }

    const newRemainQuota = newQuota - usedQuota;

    // 处理 models：JSON 数组 → 逗号分隔字符串
    // 如果优惠券有限定模型，强制设置到 token；如果没有限定，则允许使用全部模型（设为 null）
    const rpmLimit = parseInt(coupon.rpm_limit) || 10000;
    let modelsStr: string | null = null;
    if (coupon.models) {
      try {
        const modelsArr = Array.isArray(coupon.models) ? coupon.models : JSON.parse(coupon.models);
        if (Array.isArray(modelsArr) && modelsArr.length > 0) {
          modelsStr = modelsArr.join(",");
        }
      } catch (e) {
        console.error("[Promotions] 解析 models 失败:", e);
        modelsStr = null;
      }
    }

    // 更新 proxy_tokens 字段（models 写入限定模型列表，逗号分隔）
    await (pool as any).execute(
      `UPDATE proxy_tokens SET price_markup = ?, quota = ?, remain_quota = ?, gift_quota = ?,
              rate_limit_rpm = ?, models = ?
       WHERE id = ?`,
      [newPriceMarkup, newQuota, Math.max(0, newRemainQuota), newGiftQuota, rpmLimit, modelsStr, token_id]
    );

    // 更新优惠券状态为 bound，记录绑定的 token_id
    await (pool as any).execute(
      `UPDATE user_coupons SET status = 'bound', token_id = ?, bound_at = NOW() WHERE id = ?`,
      [token_id, couponId]
    );

    res.json({ success: true, message: "绑定成功" });
  } catch (e) {
    console.error("[Promotions] 绑定优惠券失败:", e);
    res.status(500).json({ success: false, error: "绑定失败" });
  }
});

export default router;
