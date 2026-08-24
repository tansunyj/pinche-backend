/**
 * 用户端渠道只读视图（挂载 /api/user/channels）
 *
 * 给普通用户（登录态）展示平台背后有哪些渠道，增强信任：
 *   GET /                启用渠道列表（id/名称/渠道 code/类型/Base URL/启用模型数）
 *   GET /:channelId/models  该渠道启用的模型 + 平台价
 *
 * 安全约束（务必遵守）：
 *   - 只读，无任何写接口；管理端 POST/PUT/DELETE 仍在 /api/admin/channels（adminAuth）。
 *   - 只返回启用渠道（status = 1）、只返回启用关联（is_enabled = 1）。
 *   - 字段白名单：绝不 SELECT api_key，绝不触碰 proxy_channel_tokens，
 *     也不暴露 priority/weight/token_lb_strategy 等内部路由配置。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

/** 解析 JSON 字符串/对象为对象（失败返回空对象） */
function parseJson(value: any): any {
  if (value == null) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// ============ 启用渠道列表 ============
router.get("/", async (_req: Request, res: Response) => {
  try {
    const [rows] = await gatewayPool.execute(
      `SELECT c.id, c.name, c.type, c.base_url, c.channel_code,
              (SELECT COUNT(*) FROM proxy_channel_models cm
                WHERE cm.channel_id = c.id AND cm.is_enabled = 1) AS model_count
         FROM proxy_channels c
        WHERE c.status = 1
        ORDER BY c.id DESC`
    );
    res.json({
      channels: (rows as any[]).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        base_url: c.base_url,
        channel_code: c.channel_code,
        model_count: Number(c.model_count) || 0,
      })),
    });
  } catch (err) {
    console.error("Public channels error:", err);
    res.status(500).json({ error: "获取渠道列表失败" });
  }
});

// ============ 某渠道启用的模型 + 平台价 ============
router.get("/:channelId/models", async (req: Request, res: Response) => {
  const { channelId } = req.params;
  try {
    const [channelRows] = await gatewayPool.execute(
      "SELECT id FROM proxy_channels WHERE id = ? AND status = 1 LIMIT 1",
      [channelId]
    );
    if ((channelRows as any[]).length === 0) {
      res.status(404).json({ error: "渠道不存在或已停用" });
      return;
    }

    const [rows] = await gatewayPool.execute(
      `SELECT cm.id, cm.model_id, ml.display_name, ml.category,
              mp.billing_mode, mp.billing_params, mp.base_price
         FROM proxy_channel_models cm
         LEFT JOIN model_library ml ON ml.model_id = cm.model_id
         LEFT JOIN model_prices mp ON mp.model_id = cm.model_id
                AND mp.channel_id = cm.channel_id
                AND mp.token_group_code = 'default'
                AND mp.status = 1
        WHERE cm.channel_id = ? AND cm.is_enabled = 1
        ORDER BY cm.priority DESC, cm.id ASC`,
      [channelId]
    );
    res.json({
      models: (rows as any[]).map((r) => ({
        id: r.id,
        modelId: r.model_id,
        displayName: r.display_name || r.model_id,
        category: r.category || null,
        billingMode: r.billing_mode || null,
        basePrice: r.base_price != null ? Number(r.base_price) : null,
        billingParams: parseJson(r.billing_params),
      })),
    });
  } catch (err) {
    console.error("Public channel models error:", err);
    res.status(500).json({ error: "获取渠道模型失败" });
  }
});

export default router;
