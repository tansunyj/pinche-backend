/**
 * 公开套餐接口（用户端）
 *
 * GET  /api/packages              — 浏览可用套餐（无需登录）
 * GET  /api/packages/:id          — 套餐详情（无需登录）
 * POST /api/packages/:id/activate — 用户自助开通套餐（需要 JWT）
 */

import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";
import redis from "../utils/redis";

const router = Router();

/**
 * 安全解析 models JSON 字段
 */
function parseModelsField(val: any): any[] {
  if (!val) return [];
  if (typeof val === "object") return Array.isArray(val) ? val : [val];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: any) {
    console.error("[packages] models JSON parse error:", e.message);
    return [];
  }
}

/**
 * 计算套餐有效期状态
 */
function getPackageStatus(pkg: any): string {
  if (pkg.status === 0) return "disabled";
  const now = new Date();
  if (pkg.start_at && new Date(pkg.start_at) > now) return "pending";
  if (pkg.end_at && new Date(pkg.end_at) < now) return "expired";
  return "active";
}

/**
 * GET /api/packages
 * 公开套餐列表（无需登录）
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const safeLimit = Math.max(1, pageSize);
    const safeOffset = Math.max(0, (page - 1) * safeLimit);

    const [countRows] = await pool.execute(
      "SELECT COUNT(*) as total FROM packages WHERE deleted_at IS NULL AND status = 1"
    );
    const total = (countRows as any[])[0]?.total || 0;

    const [rows] = await pool.execute(
      `SELECT id, name, description, models, status, sort_order, start_at, end_at,
              min_consumption, max_consumption, created_at, updated_at
       FROM packages
       WHERE deleted_at IS NULL AND status = 1
       ORDER BY sort_order ASC, id DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`
    );

    const formattedRows = (rows as any[]).map((row) => {
      const models = parseModelsField(row.models);
      const modelCount = Array.isArray(models)
        ? models.reduce((sum: number, item: any) => sum + (item.models?.length || 0), 0)
        : 0;

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        models,
        model_count: modelCount,
        min_consumption: parseFloat(row.min_consumption) || 0,
        max_consumption: row.max_consumption != null ? parseFloat(row.max_consumption) : null,
        start_at: row.start_at,
        end_at: row.end_at,
        created_at: row.created_at,
        status_text: getPackageStatus(row),
      };
    });

    res.json({
      success: true,
      data: formattedRows,
      pagination: {
        total,
        page,
        pageSize: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error: any) {
    console.error("[packages] list error:", error);
    res.status(500).json({ success: false, error: "获取套餐列表失败" });
  }
});

/**
 * GET /api/packages/:id
 * 套餐详情（无需登录）
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM packages WHERE id = ? AND deleted_at IS NULL AND status = 1",
      [req.params.id]
    );

    const row = (rows as any[])[0];
    if (!row) {
      res.status(404).json({ success: false, error: "套餐不存在或已下架" });
      return;
    }

    const models = parseModelsField(row.models);

    res.json({
      success: true,
      data: {
        id: row.id,
        name: row.name,
        description: row.description,
        models,
        min_consumption: parseFloat(row.min_consumption) || 0,
        max_consumption: row.max_consumption != null ? parseFloat(row.max_consumption) : null,
        start_at: row.start_at,
        end_at: row.end_at,
        created_at: row.created_at,
        status_text: getPackageStatus(row),
      },
    });
  } catch (error: any) {
    console.error("[packages] detail error:", error);
    res.status(500).json({ success: false, error: "获取套餐详情失败" });
  }
});

/**
 * POST /api/packages/:id/activate
 * 用户自助开通套餐（需要登录）
 */
router.post("/:id/activate", authMiddleware, async (req: Request, res: Response) => {
  try {
    const packageId = parseInt(req.params.id);
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录" });
      return;
    }

    // 校验套餐是否存在且可用
    const [pkgRows] = await pool.execute(
      "SELECT id, name, status, start_at, end_at, min_consumption, max_consumption FROM packages WHERE id = ? AND deleted_at IS NULL",
      [packageId]
    );

    const pkg = (pkgRows as any[])[0];
    if (!pkg) {
      res.status(404).json({ success: false, error: "套餐不存在" });
      return;
    }

    if (pkg.status !== 1) {
      res.status(400).json({ success: false, error: "该套餐已下架，无法开通" });
      return;
    }

    if (pkg.end_at && new Date(pkg.end_at) < new Date()) {
      res.status(400).json({ success: false, error: "该套餐已过期，无法开通" });
      return;
    }

    // 消费额度校验：累计消费 = (cumulative_recharge - balance) / 100000（点数转元）
    const [userRows] = await pool.execute(
      "SELECT cumulative_recharge, balance FROM user_users WHERE id = ?",
      [userId]
    );

    const userRow = (userRows as any[])[0];
    if (userRow) {
      const consumption = (userRow.cumulative_recharge - userRow.balance) / 100000;
      const minConsumption = parseFloat(pkg.min_consumption) || 0;
      const maxConsumption = pkg.max_consumption != null ? parseFloat(pkg.max_consumption) : null;

      if (consumption < minConsumption) {
        res.status(400).json({
          success: false,
          error: `您的累计消费 ¥${consumption.toFixed(2)} 未达到该套餐最低门槛 ¥${minConsumption.toFixed(2)}，暂无法开通`,
          consumption: { current: consumption, min: minConsumption, max: maxConsumption },
        });
        return;
      }

      if (maxConsumption !== null && consumption > maxConsumption) {
        res.status(400).json({
          success: false,
          error: `您的累计消费 ¥${consumption.toFixed(2)} 已超出该套餐最高上限 ¥${maxConsumption.toFixed(2)}，请选择更高级别套餐`,
          consumption: { current: consumption, min: minConsumption, max: maxConsumption },
        });
        return;
      }
    }

    // 检查用户是否已绑定该套餐（幂等）
    const [existingRows] = await pool.execute(
      "SELECT id, package_id, assigned_at FROM user_packages WHERE user_id = ?",
      [userId]
    );

    const existing = (existingRows as any[])[0];

    if (existing && existing.package_id === packageId) {
      res.json({ success: true, message: "您已开通该套餐", alreadyActivated: true });
      return;
    }

    // 30 天冷却期：距上次更换不足 30 天不允许再次更换
    if (existing && existing.assigned_at) {
      const lastAssigned = new Date(existing.assigned_at);
      const daysSinceLastChange = Math.floor((Date.now() - lastAssigned.getTime()) / 86400000);
      if (daysSinceLastChange < 30) {
        const remainingDays = 30 - daysSinceLastChange;
        res.status(400).json({
          success: false,
          error: `更换套餐需间隔30天，距上次更换仅 ${daysSinceLastChange} 天，请 ${remainingDays} 天后重试`,
          cooldown: { daysSinceLastChange, remainingDays, nextAvailableDate: new Date(lastAssigned.getTime() + 30 * 86400000).toISOString() },
        });
        return;
      }
    }

    if (existing) {
      await pool.execute(
        `UPDATE user_packages
         SET package_id = ?, package_name = ?, assigned_by = NULL, assigned_at = NOW()
         WHERE user_id = ?`,
        [packageId, pkg.name, userId]
      );
    } else {
      await pool.execute(
        `INSERT INTO user_packages
         (user_id, package_id, package_name, assigned_by, assigned_at)
         VALUES (?, ?, ?, NULL, NOW())`,
        [userId, packageId, pkg.name]
      );
    }

    // 清除 Redis 缓存
    try {
      await redis.del(`package:user:${userId}`);
    } catch (cacheErr: any) {
      console.error("[packages] 缓存清除失败:", cacheErr.message);
    }

    res.json({
      success: true,
      message: existing ? "套餐更换成功" : "套餐开通成功",
      data: { package_id: packageId, package_name: pkg.name },
    });
  } catch (error: any) {
    console.error("[packages] activate error:", error);
    res.status(500).json({ success: false, error: "开通套餐失败", detail: error.message });
  }
});

export default router;
