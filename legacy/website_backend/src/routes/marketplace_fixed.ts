/**
 * 模型广场（公开只读接口）- 修复版
 * 修复：channel_name 从 proxy_channels 表实时查询，而非使用冗余字段
 *
 * 数据源：MySQL silievo 数据库（与老后台 server/ 共用同一张表）
 * 写操作请走 server/ 老后台的 /api/marketplace/admin/*（管理员后台 web/ 使用）
 * 此处仅暴露给普通用户站 silievo-site 浏览模型广场使用
 */

import { Router, type Request, type Response } from "express";
import pool from "../db/mysql";
import type { RowDataPacket } from "mysql2";

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

// 修复：PriceRow 不再包含冗余的 channel_name，改为从 proxy_channels 表查询
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

function shapeEndpoint(r: EndpointRow) {
  return {
    endpoint_type: r.endpoint_type,
    endpoint_path: r.endpoint_path,
    is_default: !!r.is_default,
  };
}

// 修复：shapePrice 接收 channel_name 参数，从外部传入
function shapePrice(r: PriceRow, channelName: string | null) {
  return {
    endpoint_type: r.endpoint_type,
    token_group_code: r.token_group_code,
    channel_id: r.channel_id,
    channel_name: channelName, // 从 proxy_channels 表实时查询
    is_auto_derived: !!r.is_auto_derived,
    billing_mode: r.billing_mode,
    billing_params: parseJsonField<Record<string, number>>(r.billing_params, {}),
  };
}

// ============== 路由 ==============

/**
 * "有真实价格"的 SQL 判定片段（不含表别名前缀的列引用需外部拼接）。
 * token 计费看 base_price；image / video 计费看 billing_params 里的对应字段。
 * 任一 > 0 即视为有真实价格。NULL 字段 > 0 结果为 NULL（非真），安全。
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

/** 模型列表（含 search / filter / 聚合 endpoints + prices） */
router.get("/models", async (req: Request, res: Response) => {
  try {
    const {
      q,
      provider,
      category,
      capability,
      endpoint_type,
      page = "1",
      page_size = "100",
    } = req.query as Record<string, string>;

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
      return res.json({ success: true, data: [], total: 0 });
    }

    const ids = libraryRows.map((r) => r.model_id);
    const placeholders = ids.map(() => "?").join(",");

    const [endpointRows] = await pool.execute<EndpointRow[]>(
      `SELECT * FROM model_endpoints WHERE model_id IN (${placeholders}) AND status = 1 ORDER BY sort_order ASC`,
      ids
    );

    // 修复：从 model_prices 表查询价格信息，同时 LEFT JOIN proxy_channels 表获取实时渠道名称
    const [priceRows] = await pool.execute<PriceRow[]>(
      `SELECT mp.* FROM model_prices mp WHERE mp.model_id IN (${placeholders}) AND mp.status = 1 AND ${HAS_REAL_PRICE}`,
      ids
    );

    // 修复：查询所有相关的渠道信息
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
      (endpointsByModel[e.model_id] ||= []).push(shapeEndpoint(e));
    }

    // 修复：使用 channelMap 获取实时渠道名称
    const pricesByModel: Record<string, ReturnType<typeof shapePrice>[]> = {};
    for (const p of priceRows) {
      const channelName = p.channel_id ? channelMap.get(p.channel_id) || null : null;
      (pricesByModel[p.model_id] ||= []).push(shapePrice(p, channelName));
    }

    const data = libraryRows.map((r) => ({
      ...shapeLibrary(r),
      endpoints: endpointsByModel[r.model_id] || [],
      prices: pricesByModel[r.model_id] || [],
    }));

    const [countRows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM model_library ml WHERE ${conds.join(" AND ")}`,
      params
    );

    res.json({
      success: true,
      data,
      total: (countRows[0] as any).cnt,
    });
  } catch (e: any) {
    console.error("[marketplace] models error:", e);
    res.status(500).json({ success: false, error: "获取模型列表失败", detail: e.message });
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

    // 修复：从 model_prices 表查询价格信息，同时 LEFT JOIN proxy_channels 表获取实时渠道名称
    const [priceRows] = await pool.execute<PriceRow[]>(
      `SELECT mp.* FROM model_prices mp WHERE mp.model_id = ? AND mp.status = 1 AND (${HAS_REAL_PRICE_COND}) ORDER BY token_group_code, endpoint_type`,
      [modelId]
    );

    // 修复：查询渠道信息
    const [channelRows] = await pool.execute<ChannelRow[]>(
      `SELECT id, name FROM proxy_channels WHERE id IN (SELECT DISTINCT channel_id FROM model_prices WHERE model_id = ? AND channel_id IS NOT NULL)`,
      [modelId]
    );

    // 构建渠道 ID -> 名称 的映射
    const channelMap = new Map<number, string>();
    for (const c of channelRows) {
      channelMap.set(c.id, c.name);
    }

    // 修复：使用 channelMap 获取实时渠道名称
    const prices = priceRows.map((p) => {
      const channelName = p.channel_id ? channelMap.get(p.channel_id) || null : null;
      return shapePrice(p, channelName);
    });

    res.json({
      success: true,
      data: {
        ...shapeLibrary(rows[0]),
        endpoints: endpoints.map(shapeEndpoint),
        prices,
      },
    });
  } catch (e: any) {
    console.error("[marketplace] detail error:", e);
    res.status(500).json({ success: false, error: "获取模型详情失败" });
  }
});

export default router;
