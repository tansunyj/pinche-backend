/**
 * 管理端渠道-模型关联（挂载 /api/admin/channels，路由带 /channels 前缀）
 *
 *   GET    /channels/:channelId/models                  列出关联模型（含展示/价格/忙闲时标记）
 *   POST   /channels/:channelId/models                  添加模型到渠道（缺库时自动补录 model_library）
 *   PUT    /channels/:channelId/models/:id              更新（priority/markup/is_enabled/限流）
 *   DELETE /channels/:channelId/models/:id              解除关联
 *   GET    /channels/:channelId/models/:id/price        读取模型价格（model_prices）
 *   PUT    /channels/:channelId/models/:id/price        保存模型价格（官方/平台价格，billing_params）
 *   GET    /channels/:channelId/models/:id/busy-price   读取忙闲时配置（model_price_tiers+time_ranges）
 *   PUT    /channels/:channelId/models/:id/busy-price   保存忙闲时配置（整表替换 ranges）
 *   DELETE /channels/:channelId/models/:id/busy-price   清空忙闲时配置
 *
 * 业务逻辑移植自 admin_backend/routes/channel-models.js（TS 化，adminAuth + gatewayPool，
 * 去 Redis/审计，网关侧缓存由外部 Java 网关自行管理）。
 * model_channel_configs 表已废弃删除：不再提供端点绑定（endpoint 模板由网关自行管理）。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

/** TIME 列 → 'HH:mm:ss' 字符串（mysql2 对 TIME 可能返回带日期/数组形态，统一截取） */
function fmtTime(t: any): string | null {
  if (t == null) return null;
  const s = String(t);
  return s.length >= 8 ? s.slice(0, 8) : s;
}

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

/** 数字化（保持 null/undefined） */
function num(v: any): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ============ 列出关联模型 ============
router.get("/channels/:channelId/models", async (req: Request, res: Response) => {
  const { channelId } = req.params;
  try {
    const [rows] = await gatewayPool.execute(
      `SELECT cm.*, ml.display_name, ml.provider, ml.category, ml.icon_url, ml.status AS model_status,
              mp.billing_mode, mp.billing_params, mp.base_price,
              mp.official_price,
              ep.endpoint_name AS template_name, ep.path AS template_endpoint_path,
              CASE WHEN mpt.id IS NULL THEN 0 ELSE 1 END AS has_busy_price
         FROM proxy_channel_models cm
         LEFT JOIN model_library ml ON ml.model_id = cm.model_id
         LEFT JOIN model_prices mp ON mp.model_id = cm.model_id
                AND mp.channel_id = cm.channel_id
                AND mp.token_group_code = 'default'
                AND mp.status = 1
         LEFT JOIN endpoint ep ON ep.id = cm.use_endpoint_id
         LEFT JOIN model_price_tiers mpt ON mpt.price_id = mp.id
                AND mpt.tier_type = 'time_of_day'
                AND mpt.status = 1
        WHERE cm.channel_id = ?
        ORDER BY cm.priority DESC, cm.id ASC`,
      [channelId]
    );
    res.json({
      models: (rows as any[]).map((r) => ({
        id: r.id,
        modelId: r.model_id,
        displayName: r.display_name || r.model_id,
        provider: r.provider || null,
        category: r.category || null,
        iconUrl: r.icon_url || null,
        modelStatus: r.model_status != null ? r.model_status : null,
        priority: r.priority != null ? r.priority : 0,
        markup: r.markup != null ? Number(r.markup) : 1.0,
        isEnabled: !!r.is_enabled,
        // 该模型在此渠道绑定的 provider 能力（provider_capabilities 快照，NULL=未绑定）
        providerCapability: r.provider_capability
          ? typeof r.provider_capability === "string"
            ? parseJson(r.provider_capability)
            : r.provider_capability
          : null,
        // 该模型在此渠道绑定的端点模板（use_endpoint_id → endpoint，NULL=未绑定）
        endpoint:
          r.use_endpoint_id != null
            ? {
                id: r.use_endpoint_id,
                name: r.template_name,
                endpointPath: r.template_endpoint_path,
              }
            : null,
        billingMode: r.billing_mode || null,
        basePrice: r.base_price != null ? Number(r.base_price) : null,
        officialPrice: parseJson(r.official_price),
        billingParams: parseJson(r.billing_params),
        hasBusyPrice: !!r.has_busy_price,
      })),
    });
  } catch (err) {
    console.error("[channel-models] list error:", err);
    res.status(500).json({ error: "获取关联模型失败" });
  }
});

// ============ 添加模型到渠道 ============
router.post("/channels/:channelId/models", async (req: Request, res: Response) => {
  const { channelId } = req.params;
  const {
    model_id,
    priority = 0,
    markup = 1.0,
    is_enabled = 1,
    display_name,
    provider_capability = null,
  } = req.body || {};

  if (!model_id) {
    res.status(400).json({ error: "model_id 必填" });
    return;
  }

  try {
    // 模型不在 model_library 时自动补录（保证渠道拉取的模型可立即用于发车/选模型）
    // 注意 model_library.provider 为 NOT NULL 无默认值，自动补录需显式提供
    const [libRows] = await gatewayPool.execute("SELECT id FROM model_library WHERE model_id = ? LIMIT 1", [model_id]);
    if ((libRows as any[]).length === 0) {
      await gatewayPool.execute(
        `INSERT INTO model_library (model_id, display_name, category, provider, status, is_visible, sort_order)
         VALUES (?, ?, 'llm', 'custom', 1, 1, 9999)`,
        [model_id, display_name || model_id]
      );
    }

    // provider 能力快照（对象序列化后写入 JSON 列；留空则 NULL=未绑定）
    const capJson =
      provider_capability && typeof provider_capability === "object"
        ? JSON.stringify(provider_capability)
        : typeof provider_capability === "string"
          ? provider_capability
          : null;

    const [r] = await gatewayPool.execute(
      `INSERT INTO proxy_channel_models
         (channel_id, model_id, provider_capability, priority, markup, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [channelId, model_id, capJson, priority, markup, is_enabled]
    );
    res.json({ success: true, id: (r as any).insertId, message: "模型已加入渠道" });
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "该模型已在此渠道下" });
      return;
    }
    console.error("[channel-models] create error:", err);
    res.status(500).json({ error: "添加失败" });
  }
});

// ============ 更新关联 ============
router.put("/channels/:channelId/models/:id", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  const editable = ["priority", "markup", "is_enabled", "provider_capability"];
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of editable) {
    if (req.body && req.body[f] !== undefined) {
      let val = req.body[f];
      // provider 能力以对象传入，序列化成 JSON 列；null 表示解除绑定
      if (f === "provider_capability") {
        val =
          val && typeof val === "object"
            ? JSON.stringify(val)
            : typeof val === "string"
              ? val
              : null;
      }
      sets.push(`${f} = ?`);
      params.push(val);
    }
  }
  if (sets.length === 0) {
    res.status(400).json({ error: "无更新字段" });
    return;
  }
  try {
    const [beforeRows] = await gatewayPool.execute(
      "SELECT * FROM proxy_channel_models WHERE id = ? AND channel_id = ?",
      [id, channelId]
    );
    if ((beforeRows as any[]).length === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }
    params.push(id, channelId);
    await gatewayPool.execute(
      `UPDATE proxy_channel_models SET ${sets.join(", ")} WHERE id = ? AND channel_id = ?`,
      params
    );
    res.json({ success: true, message: "更新成功" });
  } catch (err) {
    console.error("[channel-models] update error:", err);
    res.status(500).json({ error: "更新失败" });
  }
});

// ============ 绑定/解绑端点模板 ============
// use_endpoint_id 存在 proxy_channel_models 上，NULL=未绑定（model_channel_configs 表已废弃删除）
router.put("/channels/:channelId/models/:id/endpoint", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  const useEndpointId = req.body?.use_endpoint_id ?? null;

  try {
    const [cmRows] = await gatewayPool.execute(
      "SELECT id FROM proxy_channel_models WHERE id = ? AND channel_id = ?",
      [id, channelId]
    );
    if ((cmRows as any[]).length === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }

    if (useEndpointId != null) {
      const [epRows] = await gatewayPool.execute(
        "SELECT id FROM endpoint WHERE id = ?",
        [useEndpointId]
      );
      if ((epRows as any[]).length === 0) {
        res.status(400).json({ error: "端点模板不存在" });
        return;
      }
    }

    await gatewayPool.execute(
      "UPDATE proxy_channel_models SET use_endpoint_id = ?, updated_at = NOW() WHERE id = ? AND channel_id = ?",
      [useEndpointId, id, channelId]
    );
    res.json({
      success: true,
      message: useEndpointId != null ? "已绑定端点" : "已解除端点绑定",
    });
  } catch (err) {
    console.error("[channel-models] bind endpoint error:", err);
    res.status(500).json({ error: "绑定失败" });
  }
});

// ============ 解除关联 ============
router.delete("/channels/:channelId/models/:id", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  try {
    const r = await gatewayPool.execute(
      "DELETE FROM proxy_channel_models WHERE id = ? AND channel_id = ?",
      [id, channelId]
    );
    if ((r[0] as any).affectedRows === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }
    res.json({ success: true, message: "已移除" });
  } catch (err) {
    console.error("[channel-models] delete error:", err);
    res.status(500).json({ error: "移除失败" });
  }
});

// ============ 读取模型价格 ============
router.get("/channels/:channelId/models/:id/price", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  try {
    const [cmRows] = await gatewayPool.execute(
      "SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?",
      [id, channelId]
    );
    if ((cmRows as any[]).length === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }
    const modelId = (cmRows as any[])[0].model_id;

    const [rows] = await gatewayPool.execute(
      `SELECT id, billing_mode, base_price, billing_params, official_price, price_type, status
         FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default'
        ORDER BY id DESC LIMIT 1`,
      [modelId, channelId]
    );
    const row = (rows as any[])[0];
    if (!row) {
      res.json({ price: null });
      return;
    }
    const billingParams = parseJson(row.billing_params);
    res.json({
      price: {
        id: row.id,
        billingMode: row.billing_mode,
        basePrice: row.base_price != null ? Number(row.base_price) : null,
        priceType: row.price_type || null,
        status: row.status != null ? row.status : null,
        billingParams,
        officialPrice: parseJson(row.official_price),
      },
    });
  } catch (err) {
    console.error("[channel-models] get price error:", err);
    res.status(500).json({ error: "获取价格失败" });
  }
});

// ============ 保存模型价格 ============
router.put("/channels/:channelId/models/:id/price", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  const body = req.body || {};
  const { billing_mode, base_price, price_type, billing_params, official_price } = body;

  try {
    const [cmRows] = await gatewayPool.execute(
      `SELECT cm.model_id, c.name AS channel_name
         FROM proxy_channel_models cm
         JOIN proxy_channels c ON c.id = cm.channel_id
        WHERE cm.id = ? AND cm.channel_id = ?`,
      [id, channelId]
    );
    if ((cmRows as any[]).length === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }
    const { model_id: modelId, channel_name: channelName } = (cmRows as any[])[0];

    // 合并前端传来的 billing_params（前端可只传部分字段，老字段保留）
    const [rows] = await gatewayPool.execute(
      `SELECT billing_params FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' ORDER BY id DESC LIMIT 1`,
      [modelId, channelId]
    );
    const prev = (rows as any[])[0] ? parseJson((rows as any[])[0].billing_params) : {};
    const nextBillingParams = { ...prev, ...parseJson(billing_params) };

    const base = base_price != null ? num(base_price) : 0;
    const bm = billing_mode || "token";
    const pt = price_type || "platform";

    const [existingRows] = await gatewayPool.execute(
      `SELECT id FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default'`,
      [modelId, channelId]
    );

    let officialJson: any = null;
    if (official_price != null && typeof official_price === "object") {
      officialJson = JSON.stringify(official_price);
    }

    if ((existingRows as any[]).length > 0) {
      await gatewayPool.execute(
        `UPDATE model_prices
            SET billing_mode = ?, base_price = ?, billing_params = ?,
                price_type = ?, official_price = COALESCE(?, official_price),
                channel_name = ?, status = 1, updated_at = NOW()
          WHERE id = ?`,
        [bm, base, JSON.stringify(nextBillingParams), pt, officialJson, channelName, (existingRows as any[])[0].id]
      );
    } else {
      await gatewayPool.execute(
        `INSERT INTO model_prices
           (model_id, endpoint_type, token_group_code, billing_mode, base_price,
            billing_params, channel_id, channel_name, status, price_type, official_price)
         VALUES (?, NULL, 'default', ?, ?, ?, ?, ?, 1, ?, ?)`,
        [modelId, bm, base, JSON.stringify(nextBillingParams), channelId, channelName, pt, officialJson]
      );
    }

    res.json({ success: true, message: "价格更新成功" });
  } catch (err) {
    console.error("[channel-models] update price error:", err);
    res.status(500).json({ error: "更新价格失败" });
  }
});

// ============ 读取忙闲时配置 ============
router.get("/channels/:channelId/models/:id/busy-price", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  try {
    const [cmRows] = await gatewayPool.execute(
      "SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?",
      [id, channelId]
    );
    if ((cmRows as any[]).length === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }
    const modelId = (cmRows as any[])[0].model_id;

    const [priceRows] = await gatewayPool.execute(
      `SELECT id, billing_mode FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' AND status = 1
        ORDER BY id DESC LIMIT 1`,
      [modelId, channelId]
    );
    const hasBasePrice = (priceRows as any[]).length > 0;
    const billingMode = hasBasePrice ? (priceRows as any[])[0].billing_mode : "token";
    const priceId = hasBasePrice ? (priceRows as any[])[0].id : null;

    let tierId: number | null = null;
    let tierName: string | null = null;
    if (priceId) {
      const [tierRows] = await gatewayPool.execute(
        `SELECT id, tier_name FROM model_price_tiers
          WHERE price_id = ? AND tier_type = 'time_of_day' AND status = 1
          ORDER BY priority DESC LIMIT 1`,
        [priceId]
      );
      if ((tierRows as any[]).length > 0) {
        tierId = (tierRows as any[])[0].id;
        tierName = (tierRows as any[])[0].tier_name;
      }
    }

    let ranges: any[] = [];
    if (tierId) {
      const [rangeRows] = await gatewayPool.execute(
        `SELECT id, tier_name, time_start, time_end, timezone, days_of_week, priority, price_overrides
           FROM price_tier_time_ranges
          WHERE tier_id = ?
          ORDER BY priority DESC, id ASC`,
        [tierId]
      );
      ranges = (rangeRows as any[]).map((r) => ({
        id: r.id,
        tierName: r.tier_name,
        timeStart: fmtTime(r.time_start),
        timeEnd: fmtTime(r.time_end),
        timezone: r.timezone || "Asia/Shanghai",
        daysOfWeek: r.days_of_week ? String(r.days_of_week).split(",") : ["1", "2", "3", "4", "5", "6", "7"],
        priority: r.priority != null ? r.priority : 0,
        priceOverrides: parseJson(r.price_overrides),
      }));
    }

    res.json({
      priceId,
      billingMode,
      hasBasePrice,
      tierId,
      tierName: tierName || "busy_idle",
      ranges,
    });
  } catch (err) {
    console.error("[channel-models] get busy price error:", err);
    res.status(500).json({ error: "获取忙闲时价格失败" });
  }
});

// ============ 保存忙闲时配置 ============
router.put("/channels/:channelId/models/:id/busy-price", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  const { billing_mode, tier_name, ranges } = req.body || {};
  try {
    const [cmRows] = await gatewayPool.execute(
      "SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?",
      [id, channelId]
    );
    if ((cmRows as any[]).length === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }
    const modelId = (cmRows as any[])[0].model_id;

    const conn = await gatewayPool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 确保 model_prices 有挂载记录（无基础价时自动创建）
      const [priceRows] = await conn.execute(
        `SELECT id, billing_mode FROM model_prices
          WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' AND status = 1
          ORDER BY id DESC LIMIT 1`,
        [modelId, channelId]
      );
      let priceId: number;
      if ((priceRows as any[]).length > 0) {
        priceId = (priceRows as any[])[0].id;
        const bm = billing_mode || "token";
        if ((priceRows as any[])[0].billing_mode && (priceRows as any[])[0].billing_mode !== bm) {
          await conn.execute("UPDATE model_prices SET billing_mode = ? WHERE id = ?", [bm, priceId]);
        }
      } else {
        const [ins] = await conn.execute(
          `INSERT INTO model_prices
             (model_id, endpoint_type, token_group_code, billing_mode, base_price, billing_params, channel_id, channel_name, status, price_type)
           VALUES (?, NULL, 'default', ?, 0, '{}', ?, NULL, 1, 'platform')`,
          [modelId, billing_mode || "token", channelId]
        );
        priceId = (ins as any).insertId;
      }

      // 2. upsert model_price_tiers
      const [tierRows] = await conn.execute(
        `SELECT id FROM model_price_tiers
          WHERE price_id = ? AND tier_type = 'time_of_day' ORDER BY priority DESC LIMIT 1`,
        [priceId]
      );
      const tierNameVal = tier_name || "busy_idle";
      let tierId: number;
      if ((tierRows as any[]).length > 0) {
        tierId = (tierRows as any[])[0].id;
        await conn.execute("UPDATE model_price_tiers SET tier_name = ?, status = 1 WHERE id = ?", [tierNameVal, tierId]);
      } else {
        const [ins] = await conn.execute(
          `INSERT INTO model_price_tiers (price_id, tier_type, tier_name, priority, status)
           VALUES (?, 'time_of_day', ?, 0, 1)`,
          [priceId, tierNameVal]
        );
        tierId = (ins as any).insertId;
      }

      // 3. 替换全部 ranges
      await conn.execute("DELETE FROM price_tier_time_ranges WHERE tier_id = ?", [tierId]);
      const list = Array.isArray(ranges) ? ranges : [];
      for (const r of list) {
        // 兼容 camelCase（前端）/ snake_case 两种字段形态
        const overrideVal = r.price_overrides || r.priceOverrides;
        const overrides =
          overrideVal && typeof overrideVal === "object"
            ? JSON.stringify(overrideVal)
            : null;
        await conn.execute(
          `INSERT INTO price_tier_time_ranges
             (tier_id, tier_name, time_start, time_end, timezone, price_multiplier, days_of_week, priority, price_overrides)
           VALUES (?, ?, ?, ?, ?, 1.00, ?, ?, ?)`,
          [
            tierId,
            r.tierName || r.tier_name || "slot",
            r.timeStart || r.time_start || "00:00:00",
            r.timeEnd || r.time_end || "23:59:59",
            r.timezone || "Asia/Shanghai",
            Array.isArray(r.daysOfWeek)
              ? r.daysOfWeek.join(",")
              : Array.isArray(r.days_of_week)
                ? r.days_of_week.join(",")
                : r.days_of_week || "1,2,3,4,5,6,7",
            r.priority != null ? r.priority : 0,
            overrides,
          ]
        );
      }
      await conn.commit();
      res.json({ success: true, message: "忙闲时价格已保存", data: { ranges: list.length } });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("[channel-models] save busy price error:", err);
    res.status(500).json({ error: "保存忙闲时价格失败" });
  }
});

// ============ 清空忙闲时配置 ============
router.delete("/channels/:channelId/models/:id/busy-price", async (req: Request, res: Response) => {
  const { channelId, id } = req.params;
  try {
    const [cmRows] = await gatewayPool.execute(
      "SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?",
      [id, channelId]
    );
    if ((cmRows as any[]).length === 0) {
      res.status(404).json({ error: "关联不存在" });
      return;
    }
    const modelId = (cmRows as any[])[0].model_id;

    const [priceRows] = await gatewayPool.execute(
      `SELECT id FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' AND status = 1
        ORDER BY id DESC LIMIT 1`,
      [modelId, channelId]
    );
    if ((priceRows as any[]).length === 0) {
      res.json({ success: true, message: "忙闲时配置已清空（无基础价记录）" });
      return;
    }
    const priceId = (priceRows as any[])[0].id;

    const conn = await gatewayPool.getConnection();
    try {
      await conn.beginTransaction();
      const [tierRows] = await conn.execute(
        `SELECT id FROM model_price_tiers WHERE price_id = ? AND tier_type = 'time_of_day'`,
        [priceId]
      );
      if ((tierRows as any[]).length > 0) {
        const tierId = (tierRows as any[])[0].id;
        await conn.execute("DELETE FROM price_tier_time_ranges WHERE tier_id = ?", [tierId]);
        await conn.execute("DELETE FROM model_price_tiers WHERE id = ?", [tierId]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ success: true, message: "忙闲时配置已清空" });
  } catch (err) {
    console.error("[channel-models] clear busy price error:", err);
    res.status(500).json({ error: "清空忙闲时价格失败" });
  }
});

export default router;
