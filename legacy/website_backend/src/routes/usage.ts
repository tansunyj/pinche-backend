/**
 * 用户使用记录接口
 * 从 proxy_logs 表查询用户的 API 调用记录
 *
 * 设计：
 * - 列表只查 proxy_logs 单表字段，不做连表（轻量，适合缓存）
 * - 列表缓存：每个用户一个 key `usage:logs:{userId}`，只存最近 7 天日志（倒序）
 *   - 命中缓存时 EXPIRE 滑动续期：活跃用户缓存常驻，不活跃用户 TTL 到期自动清除
 *   - 命中缓存时做轻量增量合并（id > 缓存最新 id，id 单调递增无时区坑）
 *   - 缓存为空（用户近期无调用）时回源全量历史：缓存只是加速层，绝不把旧数据变没
 *   - 请求时间范围超出 7 天窗口（查历史）时直接回源 MySQL，不占缓存
 * - 详情：GET /api/usage/logs/:id 按需连表 proxy_request_logs 返回完整详情（流式/思考/首chunk/chunk数/报错等）
 */
import { createHash } from "crypto";
import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import redis from "../utils/redis";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// ==================== 缓存常量 ====================
const CACHE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 天窗口
const USAGE_CACHE_TTL_SECONDS = 15 * 60; // 15 分钟，命中滑动续期
const INCREMENTAL_MAX = 500; // 增量合并单次上限
const SUMMARY_CACHE_TTL_SECONDS = 60; // 聚合统计短缓存（日志实时写入，缓存不宜过长，60s 内最多聚合一次）

// ==================== 类型 ====================
/** 列表条目：仅 proxy_logs 单表字段（不连表） */
interface UsageCacheEntry {
  id: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  quotaConsumed: number;
  status: string;
  timestamp: string; // ISO
  latency: number;
  channelName: string | null;
  tokenName: string | null;
  priceMarkup: number | null;
}

interface UsageCache {
  latestId: number; // 缓存里最新一条的 id（id 单调递增，增量合并更可靠，避免时区/字符串比较坑）
  logs: UsageCacheEntry[];
}

// ==================== 缓存辅助 ====================
function cacheKey(userId: number | string): string {
  return `usage:logs:${userId}`;
}

/** 与 SQL 端一致的日期边界解析（纯日期按本地 00:00:00 / 23:59:59） */
function parseBoundaryMs(s: string, isEnd: boolean): number {
  const norm = s.includes("T")
    ? s.replace("T", " ")
    : isEnd ? `${s} 23:59:59` : `${s} 00:00:00`;
  return new Date(norm).getTime();
}

/** 列表行 → 缓存条目（只取 proxy_logs 单表字段） */
function rowToEntry(row: any): UsageCacheEntry {
  const tsRaw = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: row.id?.toString(),
    model: row.model,
    inputTokens: row.prompt_tokens || 0,
    outputTokens: row.completion_tokens || 0,
    totalTokens: (row.prompt_tokens || 0) + (row.completion_tokens || 0),
    quotaConsumed: row.quota_consumed || 0,
    status: row.status,
    timestamp: tsRaw,
    latency: row.latency_ms || 0,
    channelName: row.channel_name,
    tokenName: row.token_name,
    priceMarkup: row.price_markup != null ? Number(row.price_markup) : null,
  };
}

const USAGE_LOG_SELECT = `
  SELECT
    pl.id,
    pl.model,
    pl.prompt_tokens,
    pl.completion_tokens,
    pl.quota_consumed,
    pl.latency_ms,
    pl.status,
    pl.created_at,
    pl.channel_name,
    pl.token_name,
    pl.price_markup
  FROM proxy_logs pl
`;

/**
 * 拉取日志行
 * - afterId: 只拉 id 更大的（增量合并，id 单调递增，无时区问题）
 * - sinceMs: 只拉 created_at 在 sinceMs 之后（用 FROM_UNIXTIME 与 DATETIME 列同会话时区比较）
 */
async function fetchLogRows(
  userId: number | string,
  opts: { afterId?: number; sinceMs?: number; limit?: number } = {}
): Promise<any[]> {
  const conditions: string[] = ["pl.user_id = ?"];
  const params: any[] = [userId];
  if (opts.afterId) {
    conditions.push("pl.id > ?");
    params.push(opts.afterId);
  }
  if (opts.sinceMs) {
    conditions.push("pl.created_at >= FROM_UNIXTIME(?)");
    params.push(Math.floor(opts.sinceMs / 1000));
  }
  const limitSql = opts.limit ? "LIMIT ?" : "";
  if (opts.limit) params.push(opts.limit);
  const [rows] = await pool.query(
    `${USAGE_LOG_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY pl.created_at DESC ${limitSql}`,
    params
  );
  return rows as any[];
}

async function readCache(userId: number | string): Promise<UsageCache | null> {
  const raw = await redis.get(cacheKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UsageCache;
    if (parsed && Array.isArray(parsed.logs)) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(userId: number | string, cache: UsageCache): Promise<void> {
  await redis.set(cacheKey(userId), JSON.stringify(cache), "EX", USAGE_CACHE_TTL_SECONDS);
}

/** 增量合并：把 id 大于缓存最新 id 的记录补进缓存，剔除 7 天窗口外的旧记录 */
async function mergeIncremental(userId: number | string, cache: UsageCache): Promise<UsageCacheEntry[]> {
  try {
    const rows = await fetchLogRows(userId, { afterId: cache.latestId, limit: INCREMENTAL_MAX });
    if (rows.length === 0) return cache.logs;
    const fresh = rows.map(rowToEntry);
    const seen = new Set(cache.logs.map((e) => e.id));
    const merged = [...fresh.filter((e) => !seen.has(e.id)), ...cache.logs];
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const cutoff = Date.now() - CACHE_WINDOW_MS;
    return merged.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  } catch (err) {
    console.warn("[Usage] 增量合并失败，使用原缓存:", (err as Error)?.message);
    return cache.logs;
  }
}

/** 内存筛选（与 SQL WHERE 语义一致） */
function filterEntries(
  entries: UsageCacheEntry[],
  filter: { startDate?: string; endDate?: string; modelName?: string; status?: string }
): UsageCacheEntry[] {
  const startTs = filter.startDate ? parseBoundaryMs(filter.startDate, false) : null;
  const endTs = filter.endDate ? parseBoundaryMs(filter.endDate, true) : null;
  const modelQ = filter.modelName?.toLowerCase();
  return entries.filter((e) => {
    if (modelQ && !(e.model || "").toLowerCase().includes(modelQ)) return false;
    if (filter.status && e.status !== filter.status) return false;
    const t = new Date(e.timestamp).getTime();
    if (startTs != null && t < startTs) return false;
    if (endTs != null && t > endTs) return false;
    return true;
  });
}

function buildResponse(entries: UsageCacheEntry[], page: number, pageSize: number, total: number) {
  const offset = (page - 1) * pageSize;
  const pageEntries = entries.slice(offset, offset + pageSize);
  const totalCost = entries.reduce((sum, e) => sum + e.quotaConsumed, 0);
  const totalInputTokens = entries.reduce((sum, e) => sum + e.inputTokens, 0);
  const totalOutputTokens = entries.reduce((sum, e) => sum + e.outputTokens, 0);
  return {
    data: pageEntries,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    summary: {
      totalCost: totalCost / 100000,
      totalRequests: total,
      totalInputTokens,
      totalOutputTokens,
    },
  };
}

/**
 * GET /api/usage/logs
 * 获取当前用户的 API 调用记录（仅 proxy_logs 单表字段）
 * 支持筛选：startDate / endDate / modelName / status
 */
router.get("/logs", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 20;

    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const modelName = req.query.modelName as string;
    const status = req.query.status as string;

    // ========== 历史查询（超出 7 天窗口）直接回源 MySQL，不占缓存 ==========
    const queryStartTs = startDate ? parseBoundaryMs(startDate, false) : null;
    if (queryStartTs != null && queryStartTs < Date.now() - CACHE_WINDOW_MS) {
      const whereClause = ["pl.user_id = ?"];
      const params: any[] = [userId];

      if (startDate) {
        whereClause.push("pl.created_at >= ?");
        params.push(startDate.includes("T") ? startDate.replace("T", " ") : `${startDate} 00:00:00`);
      }
      if (endDate) {
        whereClause.push("pl.created_at <= ?");
        params.push(endDate.includes("T") ? endDate.replace("T", " ") : `${endDate} 23:59:59`);
      }
      if (modelName) {
        whereClause.push("pl.model LIKE ?");
        params.push(`%${modelName}%`);
      }
      if (status) {
        whereClause.push("pl.status = ?");
        params.push(status);
      }
      const wc = whereClause.join(" AND ");
      const offset = (page - 1) * pageSize;

      const [logsResult] = await pool.query(
        `${USAGE_LOG_SELECT} WHERE ${wc} ORDER BY pl.created_at DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      const [countResult] = await pool.query(
        `SELECT COUNT(*) as total FROM proxy_logs pl WHERE ${wc}`,
        params
      );
      const [summaryResult] = await pool.query(
        `SELECT
           COALESCE(SUM(pl.quota_consumed), 0) as totalQuotaConsumed,
           COALESCE(SUM(pl.prompt_tokens), 0) as totalInputTokens,
           COALESCE(SUM(pl.completion_tokens), 0) as totalOutputTokens
         FROM proxy_logs pl WHERE ${wc}`,
        params
      );
      const total = (countResult as any[])[0]?.total || 0;
      const summary = (summaryResult as any[])[0] || {};
      const logs = (logsResult as any[]).map(rowToEntry);

      res.json({
        data: logs,
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
        summary: {
          totalCost: (summary.totalQuotaConsumed || 0) / 100000,
          totalRequests: total,
          totalInputTokens: summary.totalInputTokens || 0,
          totalOutputTokens: summary.totalOutputTokens || 0,
        },
      });
      return;
    }

    // ========== 7 天窗口内：优先走缓存 ==========
    let cache = await readCache(userId);

    if (cache && cache.logs.length > 0) {
      // 命中：续期 TTL + 增量合并新日志
      try { await redis.expire(cacheKey(userId), USAGE_CACHE_TTL_SECONDS); } catch { /* ignore */ }
      const merged = await mergeIncremental(userId, cache);
      if (merged.length > 0) {
        // 窗口内确实有数据：回写合并结果，直接返回
        if (merged !== cache.logs) {
          const latestId = Math.max(0, Number(cache.latestId) || 0, ...merged.map((e) => Number(e.id) || 0));
          await writeCache(userId, { latestId, logs: merged });
        }
        const filtered = filterEntries(merged, { startDate, endDate, modelName, status });
        res.json(buildResponse(filtered, page, pageSize, filtered.length));
        return;
      }
      // 合并后为空（用户近期无调用，缓存里全是 7 天前的旧日志）→ 掉落到下方统一回源逻辑
    }

    // 未命中 / 缓存为空 / 窗口内无数据：
    // 1) 先按 7 天窗口拉最近数据（写缓存只用这一份）
    // 2) 窗口内没有日志时回源全量历史：缓存只是加速层，绝不能把旧数据变没
    const recentRows = await fetchLogRows(userId, { sinceMs: Date.now() - CACHE_WINDOW_MS });
    let entries = recentRows.map(rowToEntry);
    if (entries.length === 0) {
      const allRows = await fetchLogRows(userId);
      entries = allRows.map(rowToEntry);
    }
    // 只缓存最近 7 天子集（不把全量历史塞进 Redis）
    const cutoffMs = Date.now() - CACHE_WINDOW_MS;
    const cacheable = entries.filter((e) => new Date(e.timestamp).getTime() >= cutoffMs);
    const latestId = Math.max(0, ...entries.map((e) => Number(e.id) || 0));
    await writeCache(userId, { latestId, logs: cacheable });

    const filtered = filterEntries(entries, { startDate, endDate, modelName, status });
    res.json(buildResponse(filtered, page, pageSize, filtered.length));
  } catch (error) {
    console.error("[Usage] 获取使用记录失败:", error);
    res.status(500).json({ error: "获取使用记录失败" });
  }
});

/** 聚合统计缓存 key：用户 + 筛选条件哈希（同筛选 60s 内只聚合一次，不重复打 MySQL） */
function summaryCacheKey(
  userId: number | string,
  filter: { startDate?: string; endDate?: string; modelName?: string; status?: string }
): string {
  const sig = JSON.stringify([
    String(userId),
    filter.startDate || "",
    filter.endDate || "",
    filter.modelName || "",
    filter.status || "",
  ]);
  const hash = createHash("sha1").update(sig).digest("hex").slice(0, 16);
  return `usage:summary:${userId}:${hash}`;
}

/**
 * GET /api/usage/summary
 * 获取用户消费聚合统计（总消耗 / 总请求 / 输入Token / 输出Token）
 * - 与 /logs 使用同一套筛选（startDate / endDate / modelName / status）
 * - 一条 COUNT+SUM 聚合 SQL，走 (user_id, created_at) 复合索引，避免全表扫
 * - Redis 60s 短缓存：同用户同筛选 60s 内最多聚合一次，生产安全
 */
router.get("/summary", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const modelName = req.query.modelName as string;
    const status = req.query.status as string;
    const filter = { startDate, endDate, modelName, status };

    // 短缓存命中直接返回
    const key = summaryCacheKey(userId, filter);
    try {
      const cached = await redis.get(key);
      if (cached) {
        try { await redis.expire(key, SUMMARY_CACHE_TTL_SECONDS); } catch { /* 续期失败忽略 */ }
        return res.json(JSON.parse(cached));
      }
    } catch { /* 缓存故障不回源失败，继续查库 */ }

    // 与 /logs 一致的筛选条件
    const whereClause = ["pl.user_id = ?"];
    const params: any[] = [userId];
    if (startDate) {
      whereClause.push("pl.created_at >= ?");
      params.push(startDate.includes("T") ? startDate.replace("T", " ") : `${startDate} 00:00:00`);
    }
    if (endDate) {
      whereClause.push("pl.created_at <= ?");
      params.push(endDate.includes("T") ? endDate.replace("T", " ") : `${endDate} 23:59:59`);
    }
    if (modelName) {
      whereClause.push("pl.model LIKE ?");
      params.push(`%${modelName}%`);
    }
    if (status) {
      whereClause.push("pl.status = ?");
      params.push(status);
    }
    const wc = whereClause.join(" AND ");

    // 单条聚合 SQL：COUNT + SUM，走 (user_id, created_at) 复合索引
    const [summaryResult] = await pool.query(
      `SELECT
         COUNT(*) as totalRequests,
         COALESCE(SUM(pl.quota_consumed), 0) as totalQuotaConsumed,
         COALESCE(SUM(pl.prompt_tokens), 0) as totalInputTokens,
         COALESCE(SUM(pl.completion_tokens), 0) as totalOutputTokens
       FROM proxy_logs pl
       WHERE ${wc}`,
      params
    );
    const summary = (summaryResult as any[])[0] || {};

    const payload = {
      totalCost: (summary.totalQuotaConsumed || 0) / 100000,
      totalRequests: summary.totalRequests || 0,
      totalInputTokens: summary.totalInputTokens || 0,
      totalOutputTokens: summary.totalOutputTokens || 0,
    };

    try { await redis.set(key, JSON.stringify(payload), "EX", SUMMARY_CACHE_TTL_SECONDS); } catch { /* 写缓存失败忽略 */ }

    res.json(payload);
  } catch (error) {
    console.error("[Usage] 获取消费汇总失败:", error);
    res.status(500).json({ error: "获取消费汇总失败" });
  }
});

/**
 * 异步媒体任务的补充信息：按 request_id 前缀定位任务表
 * - media_job_{id} → media_jobs（kind: i2v/t2v，含 error_msg/时间）
 * - vid-{uuid}     → video_generation_tasks（含 error/时间）
 * - img-{uuid}     → 无专用任务表，仅推导请求地址
 * proxy_request_logs 可能没有对应记录（异步任务不走实时请求日志），这里把能补的字段都补上。
 * 注意：prompt/分辨率/比例/时长 属客户敏感内容，不对外返回。
 */
async function fetchMediaTaskInfo(requestId: string): Promise<{
  table: string | null;
  providerTaskId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestPath: string | null;
}> {
  const out = {
    table: null as string | null,
    providerTaskId: null as string | null,
    startedAt: null as string | null,
    completedAt: null as string | null,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    requestPath: null as string | null,
  };
  const rid = requestId || "";
  try {
    const mjMatch = /^media_job_(\d+)$/.exec(rid);
    if (mjMatch) {
      const [rows] = await pool.query("SELECT * FROM media_jobs WHERE id = ?", [mjMatch[1]]);
      const mj = (rows as any[])[0];
      if (mj) {
        out.table = "media_jobs";
        out.providerTaskId = mj.provider_task_id || null;
        out.errorMessage = mj.error_msg || null;
        out.startedAt = mj.started_at ? new Date(mj.started_at).toISOString() : null;
        out.completedAt = mj.finished_at ? new Date(mj.finished_at).toISOString() : null;
        out.requestPath = /i2v|t2v/.test(mj.kind || "") ? "/v1/videos/generations" : null;
      }
    } else if (rid.startsWith("vid-")) {
      const [rows] = await pool.query(
        "SELECT * FROM video_generation_tasks WHERE request_id = ? LIMIT 1",
        [rid]
      );
      const vgt = (rows as any[])[0];
      if (vgt) {
        out.table = "video_generation_tasks";
        out.providerTaskId = vgt.task_id || null;
        out.errorCode = vgt.error_code || null;
        out.errorMessage = vgt.error_message || null;
        out.startedAt = vgt.submitted_at ? new Date(vgt.submitted_at).toISOString() : null;
        out.completedAt = vgt.completed_at ? new Date(vgt.completed_at).toISOString() : null;
        out.requestPath = "/v1/videos/generations";
      }
    } else if (rid.startsWith("img-")) {
      out.requestPath = "/v1/images/generations";
    }
  } catch (err) {
    console.warn("[Usage] 媒体任务详情补充失败:", (err as Error)?.message);
  }
  return out;
}

/**
 * GET /api/usage/logs/:id
 * 获取单条调用日志的完整详情（连表 proxy_request_logs + 异步媒体任务表）
 * 返回：是否流式、是否思考、首chunk时间、chunk数量、报错信息、请求路径、IP、UA、媒体任务参数等
 */
router.get("/logs/:id", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }
    const logId = req.params.id;

    // 1. 查 proxy_logs 单行（校验归属）
    const [logRows] = await pool.query(
      `SELECT * FROM proxy_logs WHERE id = ? AND user_id = ?`,
      [logId, userId]
    );
    const log = (logRows as any[])[0];
    if (!log) {
      return res.status(404).json({ error: "调用记录不存在" });
    }

    // 2. 按 request_id 连表 proxy_request_logs（异步媒体任务可能无对应记录）
    let rl: any = null;
    if (log.request_id) {
      const [reqRows] = await pool.query(
        `SELECT * FROM proxy_request_logs WHERE request_id = ? LIMIT 1`,
        [log.request_id]
      );
      rl = (reqRows as any[])[0] || null;
    }

    // 3. 异步媒体任务补充信息（media_jobs / video_generation_tasks）
    const task = await fetchMediaTaskInfo(log.request_id || "");
    const isMediaTask = task.table !== null || /^(media_job_|vid-|img-)/.test(log.request_id || "");

    // 合并字段：rl（实时请求日志）优先，其次媒体任务表，其次 proxy_logs
    let isStream: boolean | null = rl ? (rl.is_stream != null ? Number(rl.is_stream) === 1 : null) : null;
    if (isStream == null && isMediaTask) isStream = false; // 异步媒体任务恒为非流式

    let requestPath: string | null = rl?.request_path ?? task.requestPath ?? null;
    let requestMethod: string | null = rl?.request_method ?? (isMediaTask ? "POST" : null);
    let errorMessage: string | null = rl?.error_message ?? log.error_msg ?? task.errorMessage ?? null;
    if (errorMessage === "") errorMessage = null; // 空串归一化为 null
    let errorCode: string | null = rl?.error_code ?? task.errorCode ?? null;
    let completedAt: string | null = rl?.completed_at ?? task.completedAt ?? null;

    res.json({
      data: {
        id: log.id?.toString(),
        requestId: log.request_id,
        model: log.model,
        status: log.status,
        timestamp: log.created_at,
        latency: log.latency_ms || 0,
        channelName: log.channel_name,
        tokenName: log.token_name,
        priceMarkup: log.price_markup != null ? Number(log.price_markup) : null,
        quotaConsumed: log.quota_consumed || 0,
        inputTokens: log.prompt_tokens || 0,
        outputTokens: log.completion_tokens || 0,
        totalTokens: (log.prompt_tokens || 0) + (log.completion_tokens || 0),
        // proxy_logs 单表字段
        isThinking: log.is_thinking != null ? Number(log.is_thinking) === 1 : null,
        // proxy_request_logs / 媒体任务表 合并字段
        isStream,
        streamChunks: rl ? rl.stream_chunks ?? null : null,
        firstChunkLatencyMs: rl ? rl.first_chunk_latency_ms ?? null : null,
        totalLatencyMs: rl ? rl.total_latency_ms ?? null : null,
        requestPath,
        requestMethod,
        responseStatus: rl ? rl.response_status ?? null : null,
        errorCode,
        errorMessage,
        completedAt,
        // 异步媒体任务补充字段（无则为 null）；prompt/分辨率/比例/时长 属客户敏感内容，不下发
        startedAt: task.startedAt,
        providerTaskId: task.providerTaskId,
      },
    });
  } catch (error) {
    console.error("[Usage] 获取调用详情失败:", error);
    res.status(500).json({ error: "获取调用详情失败" });
  }
});

/**
 * GET /api/usage/stats
 * 获取用户使用统计
 */
router.get("/stats", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    // 总统计
    const [totalResult] = await pool.query(
      `
      SELECT
        COUNT(*) as totalCalls,
        COALESCE(SUM(prompt_tokens), 0) as totalInputTokens,
        COALESCE(SUM(completion_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(quota_consumed), 0) as totalQuotaConsumed
      FROM proxy_logs
      WHERE user_id = ?
      `,
      [userId]
    );

    // 今日统计
    const [todayResult] = await pool.query(
      `
      SELECT
        COUNT(*) as todayCalls,
        COALESCE(SUM(prompt_tokens), 0) as todayInputTokens,
        COALESCE(SUM(completion_tokens), 0) as todayOutputTokens,
        COALESCE(SUM(quota_consumed), 0) as todayQuotaConsumed
      FROM proxy_logs
      WHERE user_id = ? AND DATE(created_at) = CURDATE()
      `,
      [userId]
    );

    const total = (totalResult as any[])[0];
    const today = (todayResult as any[])[0];

    res.json({
      totalCalls: total?.totalCalls || 0,
      totalInputTokens: total?.totalInputTokens || 0,
      totalOutputTokens: total?.totalOutputTokens || 0,
      totalTokens: (total?.totalInputTokens || 0) + (total?.totalOutputTokens || 0),
      totalQuotaConsumed: total?.totalQuotaConsumed || 0,
      todayCalls: today?.todayCalls || 0,
      todayInputTokens: today?.todayInputTokens || 0,
      todayOutputTokens: today?.todayOutputTokens || 0,
      todayTokens: (today?.todayInputTokens || 0) + (today?.todayOutputTokens || 0),
      todayQuotaConsumed: today?.todayQuotaConsumed || 0,
    });
  } catch (error) {
    console.error("[Usage] 获取使用统计失败:", error);
    res.status(500).json({ error: "获取使用统计失败" });
  }
});

export default router;
