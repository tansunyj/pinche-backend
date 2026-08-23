/**
 * 管理端 API Key（挂载 /api/admin/tokens）
 *
 *   GET    /owners              可选的所有者用户列表（pt_users，供创建令牌时选所属用户）
 *   GET    /                    分页令牌列表（支持 username 搜索，联表用户/渠道/调用统计）
 *   POST   /                    创建令牌（服务端生成 sk-silievo- 前缀 Key）
 *   PUT    /:id                 更新令牌（name/models/rate_limit/price_markup/channel/status/时间等）
 *   DELETE /:id                 删除令牌
 *   POST   /:id/reset-quota     重置已用额度
 *
 * 业务逻辑移植自 admin_backend/routes/tokens.js（TS 化，adminAuth + gatewayPool）。
 * 注意：proxy_tokens.user_id 存的是 pt_users.id（拼车唯一用户表）。
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { gatewayPool, carpoolPool } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

/** proxy_tokens.models 兼容 JSON 数组 / 逗号分隔字符串 */
function parseModels(raw: any): string[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 逗号分隔
    }
    return raw.split(",").filter((m: string) => m.trim());
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

// ============ 可选所有者用户列表 ============
router.get("/owners", async (_req: Request, res: Response) => {
  try {
    const [rows] = await carpoolPool.execute(
      `SELECT u.id, u.nickname AS name, u.email, u.phone,
              COALESCE(u.email, u.phone, u.nickname, CONCAT('用户#', u.id)) AS label
         FROM pt_users u
        WHERE u.status = 'ACTIVE'
        ORDER BY u.id ASC`
    );
    res.json({ users: rows as any[] });
  } catch (err) {
    console.error("Admin token owners error:", err);
    res.status(500).json({ error: "获取用户列表失败" });
  }
});

// ============ 令牌列表 ============
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10)));
    // 单一搜索框：按用户手机/邮箱/昵称、令牌名称、Key 进行模糊搜索
    const search = String(req.query.search || "").trim();
    const offset = (page - 1) * pageSize;

    const conds: string[] = [];
    const params: any[] = [];
    if (search) {
      conds.push(
        "(u.phone LIKE ? OR u.nickname LIKE ? OR u.email LIKE ? OR t.name LIKE ? OR t.`key` LIKE ?)"
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const [cntRows] = await gatewayPool.execute(
      `SELECT COUNT(*) AS cnt FROM proxy_tokens t
         LEFT JOIN pt_users u ON t.user_id = u.id ${where}`,
      params
    );
    const total = Number((cntRows as any[])[0]?.cnt || 0);

    const [rows] = await gatewayPool.execute(
      `SELECT t.*, u.nickname AS user_name, u.phone AS user_phone, u.email AS user_email,
              c.name AS channel_name,
              COALESCE(stat.call_count, 0) AS call_count,
              COALESCE(stat.last_call_time, NULL) AS last_call_time
         FROM proxy_tokens t
         LEFT JOIN pt_users u ON t.user_id = u.id
         LEFT JOIN proxy_channels c ON t.channel_id = c.id
         LEFT JOIN (
           SELECT token_id,
                  COUNT(*) AS call_count,
                  MAX(created_at) AS last_call_time
             FROM proxy_logs
            WHERE status = 'success'
            GROUP BY token_id
         ) stat ON t.id = stat.token_id
         ${where}
         ORDER BY t.id DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    res.json({
      total,
      page,
      pageSize,
      tokens: (rows as any[]).map((t) => ({
        id: t.id,
        userId: t.user_id,
        username: t.user_email || t.user_phone || t.user_name || null,
        name: t.name,
        key: t.key,
        models: parseModels(t.models),
        quota: t.quota || 0,
        usedQuota: t.used_quota || 0,
        remainQuota: t.remain_quota || 0,
        rateLimitRpm: t.rate_limit_rpm || 0,
        priceMarkup: t.price_markup != null ? Number(t.price_markup) : 1.0,
        channelId: t.channel_id,
        channelName: t.channel_name || null,
        status: t.status,
        callCount: Number(t.call_count || 0),
        lastCallTime: t.last_call_time || null,
        createdAt: t.created_at,
        startAt: t.start_at,
        expiredAt: t.expired_at,
      })),
    });
  } catch (err) {
    console.error("Admin tokens list error:", err);
    res.status(500).json({ error: "获取令牌列表失败" });
  }
});

// ============ 创建令牌 ============
router.post("/", async (req: Request, res: Response) => {
  const {
    name, user_id, models, rate_limit_rpm, price_markup,
    start_at, expired_at, channel_id,
  } = req.body || {};

  if (!name) {
    res.status(400).json({ error: "令牌名称为必填项" });
    return;
  }
  if (!user_id) {
    res.status(400).json({ error: "必须绑定所属用户" });
    return;
  }
  const markup = price_markup !== undefined && price_markup !== null ? Number(price_markup) : 1.0;
  if (!Number.isFinite(markup) || markup <= 0 || markup > 100) {
    res.status(400).json({ error: "折扣倍率必须在 0~100 之间" });
    return;
  }

  const modelsStr = Array.isArray(models) ? models.join(",") : String(models || "");
  const key = "sk-silievo-" + randomUUID().replace(/-/g, "").slice(0, 32);

  try {
    const [r] = await gatewayPool.execute(
      `INSERT INTO proxy_tokens
         (user_id, name, \`key\`, models, quota, used_quota, remain_quota,
          rate_limit_rpm, start_at, expired_at, channel_id, price_markup, status)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, 1)`,
      [
        Number(user_id), name, key, modelsStr,
        rate_limit_rpm != null ? Number(rate_limit_rpm) : 10000,
        start_at || null, expired_at || null,
        channel_id ? Number(channel_id) : null, markup,
      ]
    );
    res.json({ id: (r as any).insertId, key, message: "令牌创建成功，请立即复制保存 Key" });
  } catch (err: any) {
    console.error("Admin token create error:", err);
    if (err?.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "Key 生成冲突，请重试" });
      return;
    }
    res.status(500).json({ error: "创建令牌失败" });
  }
});

// ============ 更新令牌 ============
router.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const b = req.body || {};
  try {
    const [rows] = await gatewayPool.execute("SELECT * FROM proxy_tokens WHERE id = ? LIMIT 1", [id]);
    const token = (rows as any[])[0];
    if (!token) {
      res.status(404).json({ error: "令牌不存在" });
      return;
    }

    const after: Record<string, any> = {
      name: b.name !== undefined ? b.name : token.name,
      models: b.models !== undefined ? (Array.isArray(b.models) ? b.models.join(",") : b.models) : token.models,
      rate_limit_rpm: b.rate_limit_rpm !== undefined ? Number(b.rate_limit_rpm) : token.rate_limit_rpm,
      status: b.status !== undefined ? Number(b.status) : token.status,
      channel_id: b.channel_id !== undefined ? (b.channel_id ? Number(b.channel_id) : null) : token.channel_id,
      price_markup: b.price_markup !== undefined ? Number(b.price_markup) : token.price_markup,
      start_at: b.start_at !== undefined ? b.start_at : token.start_at,
      expired_at: b.expired_at !== undefined ? b.expired_at : token.expired_at,
    };

    // 更新配额：仅当显式传入 quota 时调整 remain_quota（保持已用额度不变）
    let quota = Number(token.quota);
    let remainQuota = Number(token.remain_quota);
    if (b.quota !== undefined) {
      quota = Number(b.quota);
      remainQuota = Math.max(0, quota - Number(token.used_quota));
    }
    after.quota = quota;
    after.remain_quota = remainQuota;

    const markup = Number(after.price_markup);
    if (!Number.isFinite(markup) || markup <= 0 || markup > 100) {
      res.status(400).json({ error: "折扣倍率必须在 0~100 之间" });
      return;
    }

    await gatewayPool.execute(
      `UPDATE proxy_tokens
          SET name=?, models=?, quota=?, remain_quota=?, rate_limit_rpm=?,
              start_at=?, expired_at=?, status=?, channel_id=?, price_markup=?
        WHERE id=?`,
      [
        after.name, after.models, after.quota, after.remain_quota, after.rate_limit_rpm,
        after.start_at, after.expired_at, after.status, after.channel_id, markup, id,
      ]
    );
    res.json({ success: true, message: "令牌更新成功" });
  } catch (err) {
    console.error("Admin token update error:", err);
    res.status(500).json({ error: "更新令牌失败" });
  }
});

// ============ 删除令牌 ============
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const [r] = await gatewayPool.execute("DELETE FROM proxy_tokens WHERE id = ?", [req.params.id]);
    if ((r as any).affectedRows === 0) {
      res.status(404).json({ error: "令牌不存在" });
      return;
    }
    res.json({ success: true, message: "令牌删除成功" });
  } catch (err) {
    console.error("Admin token delete error:", err);
    res.status(500).json({ error: "删除令牌失败" });
  }
});

// ============ 重置额度 ============
router.post("/:id/reset-quota", async (req: Request, res: Response) => {
  try {
    const [rows] = await gatewayPool.execute("SELECT * FROM proxy_tokens WHERE id = ? LIMIT 1", [req.params.id]);
    const token = (rows as any[])[0];
    if (!token) {
      res.status(404).json({ error: "令牌不存在" });
      return;
    }
    await gatewayPool.execute("UPDATE proxy_tokens SET used_quota = 0, remain_quota = quota WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: "额度已重置" });
  } catch (err) {
    console.error("Admin token reset-quota error:", err);
    res.status(500).json({ error: "重置额度失败" });
  }
});

export default router;
