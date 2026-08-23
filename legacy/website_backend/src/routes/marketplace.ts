/**
 * 模型广场（公开只读接口）
 * 数据源：MySQL silievo 数据库（与老后台 server/ 共用同一张表）
 *
 * 写操作请走 server/ 老后台的 /api/marketplace/admin/*（管理员后台 web/ 使用）
 * 此处仅暴露给普通用户站 silievo-site 浏览模型广场使用
 */

import { Router, type Request, type Response } from "express";
import pool from "../db/mysql";
import type { RowDataPacket } from "mysql2";
import redis from "../utils/redis";

const router = Router();

// ============== 工具 ==============

function parseJsonField<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === "object") return v as T;
  if (typeof v === "string") {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return fallback;
}

interface LibraryRow extends RowDataPacket {
  model_id: string;
  display_name: string;
  description: string | null;
  category: string;
  provider: string;
  capabilities: unknown;
  context_window: number | null;
  max_output_tokens: number | null;
  status: number;
  is_visible: number;
  is_hot: number;
  is_new: number;
  badge_text: string | null;
  badge_color: string | null;
  sort_order: number;
  icon_url: string | null;
  doc_url: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

interface EndpointRow extends RowDataPacket {
  id: number;
  model_id: string;
  endpoint_type: string;
  endpoint_path: string;
  is_default: number;
  status: number;
  sort_order: number;
}

interface PriceRow extends RowDataPacket {
  id: number;
  model_id: string;
  endpoint_type: string | null;
  token_group_code: string;
  channel_id: number | null;
  is_auto_derived: number;
  price_type: string;
  billing_mode: string;
  base_price: number;
  billing_params: unknown;
  status: number;
}

// 新增：渠道信息查询结果
interface ChannelRow extends RowDataPacket {
  id: number;
  name: string;
}

interface GroupRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  description: string | null;
  price_multiplier: number;
  color: string | null;
  sort_order: number;
  status: number;
}

// 忙闲时时段行（price_tier_time_ranges，经 model_price_tiers 关联）
interface BusyPricingRow extends RowDataPacket {
  tier_name: string | null;
  time_start: string;
  time_end: string;
  timezone: string | null;
  days_of_week: string | null;
  priority: number | null;
  price_overrides: unknown;
}

function shapeLibrary(r: LibraryRow) {
  return {
    model_id: r.model_id,
    display_name: r.display_name,
    description: r.description,
    category: r.category,
    provider: r.provider,
    capabilities: parseJsonField<string[]>(r.capabilities, []),
    context_window: r.context_window,
    max_output_tokens: r.max_output_tokens,
    is_hot: !!r.is_hot,
    is_new: !!r.is_new,
    badge_text: r.badge_text,
    badge_color: r.badge_color,
    icon_url: r.icon_url,
    sort_order: r.sort_order,
  };
}

/**
 * 根据模型 category 获取默认的 endpoint 配置
 * 当数据库中没有配置 endpoints 时使用
 */
function getDefaultEndpoint(category: string) {
  return {
    endpoint_type: getDefaultEndpointType(category),
    is_default: true,
  };
}

/**
 * 根据模型 category 获取默认的 endpoint_type
 */
function getDefaultEndpointType(category: string): string {
  switch (category) {
    case 'reasoning':
    case 'llm':
      return 'chat';
    case 'embedding':
      return 'embeddings';
    case 'audio':
      return 'audio';
    case 'image':
      return 'images';
    case 'video':
      return 'videos';
    default:
      return 'chat';
  }
}
function shapeEndpoint(r: EndpointRow, _category: string) {
  return {
    endpoint_type: r.endpoint_type,
    is_default: !!r.is_default,
  };
}

function shapePrice(r: PriceRow, channelName: string | null) {
  return {
    endpoint_type: r.endpoint_type,
    token_group_code: r.token_group_code,
    channel_id: r.channel_id,
    channel_name: channelName,
    is_auto_derived: !!r.is_auto_derived,
    billing_mode: r.billing_mode,
    billing_params: parseJsonField<Record<string, number>>(r.billing_params, {}),
  };
}

// ============== Redis 缓存（模型列表） ==============

/**
 * 模型列表 TTL：model_library / model_prices / model_endpoints 由老后台维护、
 * 改动频率低，5 分钟内生效可接受。前端 models 页一次性拉 200 条并本地过滤，
 * 命中缓存后不再触碰任何 DB 查询。
 */
const MODELS_CACHE_TTL_SECONDS = 300;
const MODELS_CACHE_PREFIX = "marketplace:models:v1:";

/**
 * 用规范化后的查询参数生成缓存 key：
 * 只取已知参数、去掉空值、按 key 排序，避免同义参数组合产生重复 key。
 */
function buildModelsCacheKey(query: Record<string, string>): string {
  const known = ["q", "provider", "category", "capability", "endpoint_type", "page", "page_size"];
  const parts: string[] = [];
  for (const k of known) {
    const raw = query[k];
    if (raw == null) continue;
    const v = String(raw).trim();
    if (v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return MODELS_CACHE_PREFIX + parts.sort().join("&");
}

/**
 * 模型列表查询（无缓存，直接从 MySQL 聚合 endpoints + prices）。
 * 抽出为独立函数以便缓存命中时跳过、未命中时回源。
 */
async function queryModels(query: Record<string, string>) {
  const {
    q,
    provider,
    category,
    capability,
    endpoint_type,
    page = "1",
    page_size = "100",
  } = query;

  const conds: string[] = ["ml.status = 1", "ml.is_visible = 1"];
  const params: any[] = [];

  if (q && q.trim()) {
    conds.push("(ml.display_name LIKE ? OR ml.model_id LIKE ? OR ml.description LIKE ?)");
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  if (provider) { conds.push("ml.provider = ?"); params.push(provider); }
  if (category) { conds.push("ml.category = ?"); params.push(category); }
  if (capability) {
    conds.push("JSON_CONTAINS(ml.capabilities, ?)");
    params.push(JSON.stringify(capability));
  }
  if (endpoint_type) {
    conds.push(
      "EXISTS (SELECT 1 FROM model_endpoints me WHERE me.model_id = ml.model_id AND me.endpoint_type = ? AND me.status = 1)"
    );
    params.push(endpoint_type);
  }

  // 只返回有真实价格的模型：
  //   token 计费看 base_price；image/video 计费看 billing_params 里的对应字段
  conds.push(`EXISTS (SELECT 1 FROM model_prices mp WHERE mp.model_id = ml.model_id AND mp.status = 1 AND ${HAS_REAL_PRICE})`);

  // mysql2 的 pool.execute() 不支持把 LIMIT/OFFSET 作为预编译参数传入
  // （会报 ER_WRONG_ARGUMENTS），所以用整数校验后直接拼接到 SQL 里
  const limit = Math.min(500, Math.max(1, parseInt(page_size) || 100));
  const offset = Math.max(0, (Math.max(1, parseInt(page) || 1) - 1) * limit);

  const [libraryRows] = await pool.execute<LibraryRow[]>(
    `SELECT ml.* FROM model_library ml
     WHERE ${conds.join(" AND ")}
     ORDER BY ml.is_hot DESC, ml.sort_order ASC, ml.id ASC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  if (libraryRows.length === 0) {
    return { success: true, data: [], total: 0 };
  }

  const ids = libraryRows.map((r) => r.model_id);
  const placeholders = ids.map(() => "?").join(",");

  const [endpointRows] = await pool.execute<EndpointRow[]>(
    `SELECT * FROM model_endpoints WHERE model_id IN (${placeholders}) AND status = 1 ORDER BY sort_order ASC`,
    ids
  );
  const [priceRows] = await pool.execute<PriceRow[]>(
    `SELECT mp.* FROM model_prices mp WHERE mp.model_id IN (${placeholders}) AND mp.status = 1 AND ${HAS_REAL_PRICE}`,
    ids
  );

  // 查询所有相关的渠道信息
  const [channelRows] = await pool.execute<ChannelRow[]>(
    `SELECT id, name FROM proxy_channels WHERE id IN (SELECT DISTINCT channel_id FROM model_prices WHERE model_id IN (${placeholders}) AND channel_id IS NOT NULL)`,
    [...ids]
  );

  // 构建渠道 ID -> 名称 的映射
  const channelMap = new Map<number, string>();
  for (const c of channelRows) {
    channelMap.set(c.id, c.name);
  }

  const endpointsByModel: Record<string, ReturnType<typeof shapeEndpoint>[]> = {};
  for (const e of endpointRows) {
    // 查找对应的 model_library 记录获取 category
    const modelLib = libraryRows.find(r => r.model_id === e.model_id);
    const category = modelLib ? modelLib.category : '';
    (endpointsByModel[e.model_id] ||= []).push(shapeEndpoint(e, category));
  }
  const pricesByModel: Record<string, ReturnType<typeof shapePrice>[]> = {};
  for (const p of priceRows) {
    const channelName = p.channel_id ? channelMap.get(p.channel_id) || null : null;
    (pricesByModel[p.model_id] ||= []).push(shapePrice(p, channelName));
  }

  const data = libraryRows.map((r) => {
    // 如果数据库中没有配置 endpoints，根据 category 生成默认的 endpoint
    let modelEndpoints = endpointsByModel[r.model_id] || [];
    if (modelEndpoints.length === 0) {
      modelEndpoints = [getDefaultEndpoint(r.category)];
    }

    return {
      ...shapeLibrary(r),
      endpoints: modelEndpoints,
      prices: pricesByModel[r.model_id] || [],
    };
  });

  const [countRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) as cnt FROM model_library ml WHERE ${conds.join(" AND ")}`,
    params
  );

  return {
    success: true,
    data,
    total: (countRows[0] as any).cnt,
  };
}

// ============== 忙闲时价格（按需懒加载） ==============

/**
 * 忙闲时缓存 TTL：配置由管理后台维护、改动频率低，5 分钟内生效可接受。
 * key 按 (modelId, channelId) 独立，用户点击「忙闲时」Tab 时才查询，避免列表批量下发。
 */
const BUSY_CACHE_TTL_SECONDS = 300;
const BUSY_CACHE_PREFIX = "marketplace:models:busy:v1:";

/**
 * 查询单个模型 + 单个渠道的忙闲时配置。
 * 链路：model_prices（model_id + channel_id → price_id）→ model_price_tiers（time_of_day）→ price_tier_time_ranges。
 * channelId 为 null 时用 NULL 安全等值（<=>）匹配全局兜底价记录（channel_id IS NULL）。
 */
async function queryBusyPricing(modelId: string, channelId: number | null) {
  const [priceRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM model_prices
     WHERE model_id = ? AND status = 1 AND (channel_id <=> ?)
     ORDER BY token_group_code = 'default' DESC LIMIT 1`,
    [modelId, channelId]
  );
  if (priceRows.length === 0) {
    return { has_busy: false, ranges: [] };
  }
  const priceId = (priceRows[0] as any).id;

  const [rangeRows] = await pool.execute<BusyPricingRow[]>(
    `SELECT
       r.tier_name,
       TIME_FORMAT(r.time_start, '%H:%i:%s') AS time_start,
       TIME_FORMAT(r.time_end, '%H:%i:%s') AS time_end,
       r.timezone, r.days_of_week, r.priority, r.price_overrides
     FROM model_price_tiers t
     JOIN price_tier_time_ranges r ON r.tier_id = t.id
     WHERE t.price_id = ? AND t.tier_type = 'time_of_day' AND t.status = 1
     ORDER BY r.priority DESC, r.id ASC`,
    [priceId]
  );
  if (rangeRows.length === 0) {
    return { has_busy: false, ranges: [] };
  }

  return {
    has_busy: true,
    ranges: rangeRows.map((r) => ({
      tier_name: r.tier_name,
      time_start: r.time_start,
      time_end: r.time_end,
      timezone: r.timezone,
      days_of_week: r.days_of_week,
      priority: r.priority,
      price_overrides: parseJsonField<Record<string, number>>(r.price_overrides, {}),
    })),
  };
}

// ============== 路由 ==============

/**
 * "有真实价格"的 SQL 判定片段（含表别名前缀 mp.）
 * token 计费看 base_price；image / video 计费看 billing_params 里的对应字段。
 * video_token 计费看 8 个分辨率价格字段。
 * 任一 > 0 即视为有真实价格。
 */
const HAS_REAL_PRICE = `(mp.base_price > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.image_per_call')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.video_per_second_720p')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.video_per_second_1080p')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.input_text_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.input_image_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.output_text_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.output_image_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.thinking_output_per_m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.text_tokens_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.image_tokens_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.vector_tokens_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.characters_per_1k')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(mp.billing_params, '$.audio_per_second')) AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."480p_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."480p_withInput"' AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."720p_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."720p_withInput"' AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."1080p_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."1080p_withInput"' AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."4k_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(mp.billing_params->>'$."4k_withInput"' AS DECIMAL(20,6)) > 0
)`;

const HAS_REAL_PRICE_COND = `(base_price > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.image_per_call')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.video_per_second_720p')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.video_per_second_1080p')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.input_text_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.input_image_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.output_text_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.output_image_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.thinking_output_per_m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.text_tokens_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.image_tokens_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.vector_tokens_per_1m')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.characters_per_1k')) AS DECIMAL(20,6)) > 0
  OR CAST(JSON_UNQUOTE(JSON_EXTRACT(billing_params, '$.audio_per_second')) AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."480p_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."480p_withInput"' AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."720p_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."720p_withInput"' AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."1080p_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."1080p_withInput"' AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."4k_noInput"' AS DECIMAL(20,6)) > 0
  OR CAST(billing_params->>'$."4k_withInput"' AS DECIMAL(20,6)) > 0
)`;

router.get("/groups", async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute<GroupRow[]>(
      `SELECT * FROM model_token_groups WHERE status = 1 ORDER BY sort_order ASC, id ASC`
    );
    res.json({ success: true, data: rows });
  } catch (e: any) {
    console.error("[marketplace] groups error:", e);
    res.status(500).json({ success: false, error: "获取令牌组失败" });
  }
});

/** 筛选项字典 */
router.get("/filters", async (_req: Request, res: Response) => {
  try {
    const [providers] = await pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT provider FROM model_library WHERE status=1 AND is_visible=1 AND provider IS NOT NULL`
    );
    const [categories] = await pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT category FROM model_library WHERE status=1 AND is_visible=1 AND category IS NOT NULL`
    );
    const [endpoints] = await pool.execute<RowDataPacket[]>(
      `SELECT DISTINCT endpoint_type FROM model_endpoints WHERE status=1`
    );
    const [groups] = await pool.execute<GroupRow[]>(
      `SELECT * FROM model_token_groups WHERE status=1 ORDER BY sort_order ASC`
    );
    res.json({
      success: true,
      data: {
        providers: providers.map((r: any) => r.provider),
        categories: categories.map((r: any) => r.category),
        endpoints: endpoints.map((r: any) => r.endpoint_type),
        token_groups: groups,
      },
    });
  } catch (e: any) {
    console.error("[marketplace] filters error:", e);
    res.status(500).json({ success: false, error: "获取筛选项失败" });
  }
});

/** 模型列表（含 search / filter / 聚合 endpoints + prices，带 Redis 缓存） */
router.get("/models", async (req: Request, res: Response) => {
  try {
    const query = req.query as Record<string, string>;

    // 搜索关键字 q 是自由文本，缓存会被一次性搜索词撑爆，带 q 时直接回源
    const cacheable = !(query.q && query.q.trim());
    if (cacheable) {
      const cacheKey = buildModelsCacheKey(query);
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          res.setHeader("X-Marketplace-Cache", "HIT");
          return res.json(JSON.parse(cached));
        }
      } catch (e: any) {
        console.error("[marketplace] redis get error:", e);
      }

      const payload = await queryModels(query);
      try {
        await redis.setex(cacheKey, MODELS_CACHE_TTL_SECONDS, JSON.stringify(payload));
        res.setHeader("X-Marketplace-Cache", "MISS");
      } catch (e: any) {
        console.error("[marketplace] redis set error:", e);
      }
      return res.json(payload);
    }

    res.json(await queryModels(query));
  } catch (e: any) {
    console.error("[marketplace] models error:", e);
    res.status(500).json({ success: false, error: "获取模型列表失败", detail: e.message });
  }
});

/** 忙闲时价格：按 modelId + channelId 查询（用户点击「忙闲时」Tab 时懒加载调用） */
router.get("/models/:modelId/busy-pricing", async (req: Request, res: Response) => {
  try {
    const { modelId } = req.params;
    const rawChannel = String(req.query.channelId ?? "").trim();
    // channelId 为空 / "null" 表示查全局兜底价记录（channel_id IS NULL）
    const channelId = rawChannel === "" || rawChannel === "null" ? null : Number(rawChannel);
    const cacheKey = `${BUSY_CACHE_PREFIX}${modelId}:${channelId ?? "global"}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: JSON.parse(cached) });
    }

    const data = await queryBusyPricing(modelId, channelId);
    try {
      await redis.setex(cacheKey, BUSY_CACHE_TTL_SECONDS, JSON.stringify(data));
    } catch (e: any) {
      console.error("[marketplace] busy-pricing redis set error:", e);
    }
    res.json({ success: true, data });
  } catch (e: any) {
    console.error("[marketplace] busy-pricing error:", e);
    res.status(500).json({ success: false, error: "获取忙闲时价格失败", detail: e.message });
  }
});

/** 模型详情 */
router.get("/models/:modelId", async (req: Request, res: Response) => {
  try {
    const { modelId } = req.params;
    const [rows] = await pool.execute<LibraryRow[]>(
      `SELECT * FROM model_library WHERE model_id = ? AND status = 1 AND is_visible = 1`,
      [modelId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: "模型不存在" });
    }

    const [endpoints] = await pool.execute<EndpointRow[]>(
      `SELECT * FROM model_endpoints WHERE model_id = ? AND status = 1 ORDER BY sort_order ASC`,
      [modelId]
    );
    const [priceRows] = await pool.execute<PriceRow[]>(
      `SELECT mp.* FROM model_prices mp WHERE mp.model_id = ? AND mp.status = 1 AND (${HAS_REAL_PRICE_COND}) ORDER BY token_group_code, endpoint_type`,
      [modelId]
    );

    // 查询渠道信息
    const [channelRows] = await pool.execute<ChannelRow[]>(
      `SELECT id, name FROM proxy_channels WHERE id IN (SELECT DISTINCT channel_id FROM model_prices WHERE model_id = ? AND channel_id IS NOT NULL)`,
      [modelId]
    );

    // 构建渠道 ID -> 名称 的映射
    const channelMap = new Map<number, string>();
    for (const c of channelRows) {
      channelMap.set(c.id, c.name);
    }

    // 使用 channelMap 获取实时渠道名称
    const prices = priceRows.map((p) => {
      const channelName = p.channel_id ? channelMap.get(p.channel_id) || null : null;
      return shapePrice(p, channelName);
    });

    // 如果数据库中没有配置 endpoints，根据 category 生成默认的 endpoint
    let modelEndpoints = endpoints.map(e => shapeEndpoint(e, rows[0].category));
    if (modelEndpoints.length === 0) {
      modelEndpoints = [getDefaultEndpoint(rows[0].category)];
    }

    res.json({
      success: true,
      data: {
        ...shapeLibrary(rows[0]),
        endpoints: modelEndpoints,
        prices,
      },
    });
  } catch (e: any) {
    console.error("[marketplace] detail error:", e);
    res.status(500).json({ success: false, error: "获取模型详情失败" });
  }
});

export default router;
