/**
 * 模型广场（挂载 /api/pricing）
 *
 * 供前端 features/pricing 页面消费，返回 PricingData 形状：
 *   { success, message, data: PricingModel[], vendors, group_ratio, usable_group,
 *     supported_endpoint, auto_groups }
 *
 * 数据来源：
 *   - model_library：可见模型目录（status=1 && is_visible=1）
 *   - model_prices：多渠道价（status=1，billing_params 按元/1M tokens 计价，channel_id 区分渠道，
 *     channel_id IS NULL 为官方兜底价）；列表返回每个模型的 prices[]（含 channel_name）与 endpoints[]，
 *     镜像老接口 marketplace.ts 的 md 格式，前端据此做渠道切换 + 忙闲时价格查询。
 *   - 状态过滤（用户侧统一口径）：
 *     渠道关闭（proxy_channels.status=0）或渠道-模型关联关闭（proxy_channel_models.is_enabled=0），
 *     其价格行一律排除——模型广场不展示「仅被关渠道/被关关联上架」的模型，多渠道模型也不提供该渠道切换；
 *     模型目录本身已要求 model_library.status=1 && is_visible=1。
 *   - proxy_channels：渠道名称（model_prices.channel_name 缺省时回退）
 *
 * 价格展示口径（用户已确认：额度模式）：
 *   前端显示值 = model_ratio × 2 × quota_per_unit（status 返回 500000）= model_ratio × 1e6；
 *   平台计费口径 1 元 = 100000 额度，故要显示「真实额度成本」需
 *     model_ratio        = input_per_1m × 100000 / (2 × 500000) = input_per_1m × 0.1
 *     completion_ratio   = output_per_1m / input_per_1m
 *     cache_ratio        = cache_hit_per_1m / input_per_1m
 *     create_cache_ratio = cache_write_per_1m / input_per_1m
 *
 * 上架判定（用户侧口径，含免费模型）：
 *   任一启用渠道下有「已配置」的价格行即上架。已配置 = base_price > 0，
 *   或 billing_params 中存在显式价格字段（值为 0 也是显式配置 = 免费模型，展示 ¥0）；
 *   无价格行或空配置（'{}'）的价格行 = 未上架，管理端补价后自动出现。
 */

import { Router, Request, Response } from "express";

import { gwQuery } from "../../config/db";

const router = Router();

/** 计费口径：1 元 = 100000 额度（与 user/balance、admin/logs 一致） */
const QUOTA_PER_YUAN = 100000;
/** 前端 formatCurrencyFromUSD 在 TOKENS 模式下相乘的 quota_per_unit（status.ts 返回 500000） */
const QUOTA_PER_UNIT = 500000;

interface LibraryRow {
  id: number;
  model_id: string;
  display_name: string;
  description: string | null;
  category: string;
  provider: string;
  capabilities: unknown;
  context_window: number | null;
  max_output_tokens: number | null;
  training_data_cutoff: unknown;
  icon_url: string | null;
  is_hot: number;
  is_new: number;
  badge_text: string | null;
  badge_color: string | null;
  sort_order: number;
}

interface PriceRow {
  id: number;
  model_id: string;
  endpoint_type: string | null;
  token_group_code: string;
  is_auto_derived: number | null;
  billing_mode: string | null;
  base_price: number | null;
  billing_params: unknown;
  price_type: string | null;
  channel_id: number | null;
  channel_name: string | null;
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(value as string) as T;
  } catch {
    return null;
  }
}

/** TIME 列 → 'HH:mm:ss' 字符串（mysql2 对 TIME 可能返回带日期/数组形态，统一截取） */
function fmtTime(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length >= 8 ? s.slice(0, 8) : s;
}

function toFinite(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** DATE/字符串 → 'YYYY-MM-DD'（避免 toISOString 时区漂移） */
function formatYmd(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "string") return value.slice(0, 10);
  return undefined;
}

/** 根据 category 生成默认端点（镜像老接口 marketplace.ts 的 getDefaultEndpointType；pt_carpool 无 model_endpoints 表） */
function getDefaultEndpointType(category: string): string {
  switch (category) {
    case "reasoning":
    case "llm":
      return "chat";
    case "embedding":
      return "embeddings";
    case "audio":
      return "audio";
    case "image":
      return "images";
    case "video":
      return "videos";
    default:
      return "chat";
  }
}

/** 渠道价 → md 格式 prices[] 项（镜像老接口 shapePrice） */
function shapePrice(row: PriceRow): Record<string, unknown> {
  return {
    endpoint_type: row.endpoint_type,
    token_group_code: row.token_group_code,
    channel_id: row.channel_id,
    channel_name: row.channel_id ? row.channel_name ?? null : null,
    is_auto_derived: Number(row.is_auto_derived) === 1,
    billing_mode: row.billing_mode,
    billing_params: parseJson<Record<string, unknown>>(row.billing_params) || {},
  };
}

/** billing_params 中会被前端当作价格格子的字段（镜像老接口 HAS_REAL_PRICE 判定） */
const PRICE_FIELDS = [
  "input_per_1m", "output_per_1m", "cache_hit_per_1m", "cache_write_per_1m",
  "thinking_output_per_m", "embedding_per_1m", "image_per_call",
  "video_per_second_720p", "video_per_second_1080p",
  "input_text_per_1m", "input_image_per_1m", "output_text_per_1m", "output_image_per_1m",
  "text_tokens_per_1m", "image_tokens_per_1m", "vector_tokens_per_1m",
  "characters_per_1k", "audio_per_second",
  "480p_noInput", "480p_withInput", "720p_noInput", "720p_withInput",
  "1080p_noInput", "1080p_withInput", "4k_noInput", "4k_withInput",
] as const;

/** 是否「已配置价格」：base_price > 0，或 billing_params 中至少一个价格字段被显式设置
 *  （显式设置为 0 也算已配置 = 免费模型，同样上架；空配置 '{}' 不算已配置） */
function hasConfiguredPrice(row: PriceRow): boolean {
  const base = toFinite(row.base_price);
  if (base && base > 0) return true;
  const bp = parseJson<Record<string, unknown>>(row.billing_params);
  if (!bp) return false;
  for (const field of PRICE_FIELDS) {
    if (bp[field] != null && bp[field] !== "") return true;
  }
  return false;
}

// GET /api/pricing
router.get("/", async (_req: Request, res: Response) => {
  try {
    const [libRows, priceRows] = await Promise.all([
      gwQuery(
        `SELECT ml.id, ml.model_id, ml.display_name, ml.description, ml.category,
                ml.provider, ml.capabilities, ml.context_window, ml.max_output_tokens,
                ml.training_data_cutoff, ml.icon_url, ml.is_hot, ml.is_new,
                ml.badge_text, ml.badge_color, ml.sort_order
           FROM model_library ml
          WHERE ml.status = 1 AND ml.is_visible = 1
          ORDER BY ml.sort_order ASC, ml.id ASC`
      ),
      gwQuery(
        `SELECT mp.model_id, mp.endpoint_type, mp.token_group_code, mp.is_auto_derived,
                mp.billing_mode, mp.base_price, mp.billing_params, mp.price_type,
                mp.channel_id, COALESCE(mp.channel_name, pc.name) AS channel_name
           FROM model_prices mp
           LEFT JOIN proxy_channels pc ON pc.id = mp.channel_id
          WHERE mp.status = 1
            AND (mp.channel_id IS NULL OR (
              pc.status = 1 AND EXISTS (
                SELECT 1 FROM proxy_channel_models pcm
                 WHERE pcm.channel_id = mp.channel_id
                   AND pcm.model_id = mp.model_id
                   AND pcm.is_enabled = 1)))
          ORDER BY mp.model_id, (mp.channel_id IS NULL) DESC, mp.updated_at DESC`
      ),
    ]);

    // 多渠道价按 model_id 分组（官方兜底价 channel_id IS NULL 排最前，其余按更新倒序）
    const pricesByModel = new Map<string, PriceRow[]>();
    for (const row of priceRows as PriceRow[]) {
      if (!hasConfiguredPrice(row)) continue; // 未配置价格的价格行不参与上架判定
      const arr = pricesByModel.get(row.model_id);
      if (arr) arr.push(row);
      else pricesByModel.set(row.model_id, [row]);
    }

    // 供应商序号化（vendors 数组由前端按 vendor_id 关联）
    const vendorIdMap = new Map<string, number>();
    const vendors: { id: number; name: string; icon?: string }[] = [];

    const data: Record<string, unknown>[] = [];
    for (const row of libRows as LibraryRow[]) {
      const prices = pricesByModel.get(row.model_id);
      if (!prices || prices.length === 0) continue; // 无价 = 未上架

      // 主价格 = 官方兜底价（channel_id IS NULL）优先，否则第一条渠道价
      const primary = prices[0];
      const bp = parseJson<Record<string, unknown>>(primary.billing_params) || {};
      // 输入价维度必须存在才可展示：input_per_1m 显式存在（含 0 = 免费模型），或 base_price > 0
      // （仅配置了图片/视频单价、无输入价维度的行维持原样跳过）
      const hasInputDim = bp.input_per_1m != null || (toFinite(primary.base_price) ?? 0) > 0;
      if (!hasInputDim) continue; // 无输入价维度 → 跳过
      const input = toFinite(bp.input_per_1m) ?? toFinite(primary.base_price);

      const output = toFinite(bp.output_per_1m);
      const cacheHit = toFinite(bp.cache_hit_per_1m);
      const cacheWrite = toFinite(bp.cache_write_per_1m);

      let vendorId = vendorIdMap.get(row.provider);
      if (vendorId === undefined) {
        vendorId = vendors.length + 1;
        vendorIdMap.set(row.provider, vendorId);
        vendors.push({
          id: vendorId,
          name: row.provider,
          icon: row.icon_url ?? undefined,
        });
      }

      // 端点：pt_carpool 无 model_endpoints 表，按 category 生成默认端点（镜像老接口）
      const endpointType = getDefaultEndpointType(row.category);
      const endpoints = [{ endpoint_type: endpointType, is_default: true }];

      const model: Record<string, unknown> = {
        id: row.id,
        model_name: row.model_id,
        description: row.description ?? undefined,
        icon: row.icon_url ?? undefined,
        vendor_id: vendorId,
        quota_type: 0,
        model_ratio: Number(
          ((input * QUOTA_PER_YUAN) / (2 * QUOTA_PER_UNIT)).toFixed(10)
        ),
        enable_groups: ["default"],
        tags: row.category || undefined,
        supported_endpoint_types: [endpointType],
        billing_mode: primary.billing_mode || "token",
        context_length: row.context_window ?? undefined,
        max_output_tokens: row.max_output_tokens ?? undefined,
        knowledge_cutoff: formatYmd(row.training_data_cutoff),
        // ---- 复刻参考页模型卡片所需的展示字段(向后兼容,不破坏上方额度派生字段) ----
        display_name: row.display_name || row.model_id,
        provider: row.provider || undefined,
        category: row.category || undefined,
        is_hot: Number(row.is_hot) === 1,
        is_new: Number(row.is_new) === 1,
        badge_text: row.badge_text || undefined,
        badge_color: row.badge_color || undefined,
        // 原始官方价(元/1M)直接透传,前端按 billing_mode/category 决定渲染哪些价格格子
        billing_params: bp,
        // ---- 多渠道：镜像老接口 md 格式 endpoints[] + prices[]（前端渠道切换据此渲染） ----
        endpoints,
        prices: prices.map((p) => shapePrice(p)),
      };

      if (output && output > 0) {
        model.completion_ratio = Number((output / input).toFixed(6));
      }
      if (cacheHit && cacheHit > 0) {
        model.cache_ratio = Number((cacheHit / input).toFixed(6));
      }
      if (cacheWrite && cacheWrite > 0) {
        model.create_cache_ratio = Number((cacheWrite / input).toFixed(6));
      }

      const caps = parseJson<unknown>(row.capabilities);
      if (Array.isArray(caps)) {
        model.capabilities = caps;
      }

      data.push(model);
    }

    res.json({
      success: true,
      message: "ok",
      data,
      vendors,
      group_ratio: { default: 1 },
      usable_group: { default: { desc: "default", ratio: 1 } },
      supported_endpoint: {
        openai: { path: "/v1/chat/completions", method: "POST" },
      },
      auto_groups: [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "获取模型广场数据失败" });
  }
});

// GET /api/pricing/busy/:modelId?channelId= — 忙闲时价格(时段 + 绝对价覆盖)
// 查询链路镜像 admin/channel-models.ts:model_prices → model_price_tiers(time_of_day) → price_tier_time_ranges。
// channelId 为空 / "null" 表示查官方兜底价记录(channel_id IS NULL,与列表 prices[] 的官方价维度对齐)。
router.get("/busy/:modelId", async (req: Request, res: Response) => {
  const { modelId } = req.params;
  const rawChannel = String(req.query.channelId ?? "").trim();
  const channelId =
    rawChannel === "" || rawChannel === "null" || !/^\d+$/.test(rawChannel)
      ? null
      : Number(rawChannel);
  try {
    // 注意:gwQuery 直接返回行数组,不能再用 [rows] 解构(解构会取到第一行,导致永远查不到)
    // 渠道价仅在渠道启用(status=1)且渠道-模型关联启用(is_enabled=1)时返回;官方兜底价(channel_id IS NULL)不受影响
    const priceRows = await gwQuery(
      `SELECT id FROM model_prices
        WHERE model_id = ? AND status = 1 AND (channel_id <=> ?)
          AND (channel_id IS NULL OR EXISTS (
            SELECT 1 FROM proxy_channels pc
              JOIN proxy_channel_models pcm
                ON pcm.channel_id = pc.id AND pcm.model_id = model_prices.model_id
             WHERE pc.id = model_prices.channel_id AND pc.status = 1 AND pcm.is_enabled = 1))
        ORDER BY token_group_code = 'default' DESC LIMIT 1`,
      [modelId, channelId]
    );
    const price = (priceRows as PriceRow[])[0];
    if (!price) {
      res.json({ success: true, message: "ok", data: { has_busy: false, ranges: [] } });
      return;
    }

    const tierRows = await gwQuery(
      `SELECT id, tier_name FROM model_price_tiers
        WHERE price_id = ? AND tier_type = 'time_of_day' AND status = 1
        ORDER BY priority DESC LIMIT 1`,
      [price.id]
    );
    const tier = (tierRows as { id: number; tier_name: string | null }[])[0];
    if (!tier) {
      res.json({ success: true, message: "ok", data: { has_busy: false, ranges: [] } });
      return;
    }

    const rangeRows = await gwQuery(
      `SELECT tier_name, time_start, time_end, timezone, days_of_week, priority, price_overrides
         FROM price_tier_time_ranges
        WHERE tier_id = ?
        ORDER BY priority DESC, id ASC`,
      [tier.id]
    );

    const ranges = (rangeRows as Record<string, unknown>[]).map((r) => ({
      tier_name: r.tier_name,
      time_start: fmtTime(r.time_start),
      time_end: fmtTime(r.time_end),
      timezone: r.timezone || "Asia/Shanghai",
      days_of_week: r.days_of_week ? String(r.days_of_week) : null,
      priority: r.priority != null ? r.priority : 0,
      price_overrides: parseJson<Record<string, unknown>>(r.price_overrides) || {},
    }));

    res.json({
      success: true,
      message: "ok",
      data: {
        has_busy: ranges.length > 0,
        ranges,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "获取忙闲时价格失败" });
  }
});

export default router;
