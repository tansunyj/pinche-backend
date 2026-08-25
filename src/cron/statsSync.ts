/**
 * 统计同步器(§5.2 §5.6)
 *
 * 每 60s：SCAN 网关 Redis stats:* 键,把每个 Hash 字段映射为 unified_stats 行,
 * 覆盖写(Redis 为准):无该行则 INSERT,有该行用 Redis 当前值覆盖 SET。幂等、不扫表、无水位线。
 *
 * 每天 00:05：车次进度快照(current_count/min_count)入 unified_stats(来源 pt_rides,与 Redis 无关)。
 *
 * 覆盖语义要点:
 * - metric_value = 最近一次同步时的 Redis 累计值;今日行每轮刷新为当前累计,过去日期行停在当日终值。
 * - 进程内缓存最近写入值,未变则跳过(降无效写;值变化或 meta 变化都会重写)。
 * - 字段必须存在于 metric_definitions 目录(§0.0-13):目录外字段跳过并告警。
 * - discount_rate 用 discount_rate_sum / discounted_requests 求"请求数加权"均值(§9-5),内部字段不落库。
 * - 旧 Redis 字段名归一:quota_consumed→quota, success_count→success, error_count→error。
 */

import redis from "../utils/redis";
import { cpQuery } from "../config/db";

/** 指标目录(metric_definitions),同步字段须在目录内 */
let metricCatalog: Set<string> | null = null;
let catalogLoadedAt = 0;

/** meta 字段(Redis Hash 里非指标,进 meta_json) */
const META_FIELDS = new Set(["channel_name", "channel_type", "token_name", "user_id", "ride_name"]);

/** 旧字段名 → metric 目录名(归一) */
const FIELD_TO_METRIC: Record<string, string> = {
  quota_consumed: "quota",
  success_count: "success",
  error_count: "error",
};

/** 最近写入值缓存:key=(逻辑行+值+meta), 值未变则跳过该轮 */
const lastWritten = new Map<string, string>();
const CACHE_MAX = 100_000;

// 扫描模式(注意顺序无要求,parseStatsKey 各自判定)
const SCAN_PATTERNS = [
  "stats:global:*",
  "stats:channel:*",
  "stats:token:*",
  "stats:model:*",
  "stats:user:*",
  "stats:composite:*",
  "stats:hourly:*",
  "stats:ride:*",
  "stats:discount:*",
  "stats:monthly:*",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{2}$/;

interface ParsedKey {
  dim: string;      // global/channel/.../hourly/monthly
  dim1: string;
  dim2: string;
  date: string;     // yyyy-MM-dd(monthly 用当月首日)
  hour: number;     // -1=日/月粒度, 0-23=小时
}

let syncing = false;

// ==================== 对外任务 ====================

/** 每 60s 同步一轮;重入保护(上一轮未跑完则跳过本 tick) */
export async function syncStatsOnce(): Promise<number> {
  if (syncing) return 0;
  syncing = true;
  try {
    const catalog = await getMetricCatalog();
    if (!catalog) {
      console.error("[Cron] 统计同步: metric_definitions 目录读取失败,本轮跳过");
      return 0;
    }

    let writes = 0;
    const rideCountByDate = new Map<string, Set<string>>(); // date -> rideIds(算 unique_rides)

    for (const pattern of SCAN_PATTERNS) {
      for await (const key of scanKeys(pattern)) {
        const parsed = parseStatsKey(key);
        if (!parsed) continue;

        const entries = await redis.hgetall(key).catch(() => null);
        if (!entries || Object.keys(entries).length === 0) continue;

        // meta_json:Hash 里的非指标字段
        const meta: Record<string, unknown> = {};
        for (const [f, v] of Object.entries(entries)) {
          if (META_FIELDS.has(f)) meta[f] = v;
        }
        const metaJson = Object.keys(meta).length ? JSON.stringify(meta) : null;

        if (parsed.dim === "ride") {
          const set = rideCountByDate.get(parsed.date) ?? new Set<string>();
          set.add(parsed.dim1);
          rideCountByDate.set(parsed.date, set);
        }

        const discountedRequests = parseIntSafe(entries["discounted_requests"]);
        const rateSum = parseFloatSafe(entries["discount_rate_sum"]);

        for (const [field, rawValue] of Object.entries(entries)) {
          if (field === "discount_rate_sum") continue; // 内部累积字段,不落库
          if (META_FIELDS.has(field)) continue;        // meta 已进 meta_json

          const metricName = FIELD_TO_METRIC[field] ?? field;
          if (!catalog.has(metricName)) {
            // §0.0-13:新指标必须先 INSERT metric_definitions
            console.error(`[Cron] 统计同步: 字段 "${field}" 不在 metric_definitions 目录,跳过(新增指标需先 INSERT 目录)`);
            continue;
          }

          writes += await upsertRow(parsed, metricName, parseFloatSafe(rawValue), metaJson);
        }

        // discount_rate 不在 Redis Hash 字段中(内部存 sum+count),此处显式计算补写(§9-5 请求数加权)
        // 浮点 sum/count 会得 0.7999999...,舍入到 4 位小数落库
        if (discountedRequests > 0 && rateSum > 0 && catalog.has("discount_rate")) {
          const avgRate = Math.round((rateSum / discountedRequests) * 10000) / 10000;
          writes += await upsertRow(parsed, "discount_rate", avgRate, metaJson);
        }
      }
    }

    // unique_rides:当日有消费的车次数(§4.2),dim1='' 一行当日终值
    if (catalog.has("unique_rides")) {
      for (const [date, ids] of rideCountByDate) {
        writes += await upsertRow(
          { dim: "ride", dim1: "", dim2: "", date, hour: -1 },
          "unique_rides",
          ids.size,
          null
        );
      }
    }

    return writes;
  } catch (e) {
    console.error("[Cron] 统计同步失败:", e);
    return 0;
  } finally {
    syncing = false;
  }
}

/** 每天 00:05 车次进度快照(§5.6):pt_rides 活跃车次 current_count/min_count 落库 */
export async function snapshotRideProgress(): Promise<number> {
  const date = todayStr();
  const rows = await cpQuery(
    `SELECT id, name, current_count, min_count, status, established_at
     FROM pt_rides WHERE status = 'ACTIVE'`
  );
  let writes = 0;
  for (const r of rows as any[]) {
    const meta = JSON.stringify({
      ride_name: r.name ?? null,
      status: r.status ?? null,
      established_at: r.established_at ? formatDateTime(r.established_at) : null,
    });
    for (const [metric, value] of [["current_count", r.current_count], ["min_count", r.min_count]] as const) {
      writes += await upsertRow(
        { dim: "ride", dim1: `ride:${r.id}`, dim2: "", date, hour: -1 },
        metric,
        Number(value) || 0,
        meta
      );
    }
  }
  if (writes > 0) console.log(`[Cron] 车次进度快照: ${date}, ${(rows as any[]).length} 个车次, ${writes} 行`);
  return writes;
}

// ==================== Redis → unified_stats 行映射 ====================

async function getMetricCatalog(): Promise<Set<string> | null> {
  const now = Date.now();
  if (metricCatalog && now - catalogLoadedAt < 5 * 60 * 1000) return metricCatalog;
  try {
    const rows = await cpQuery("SELECT metric_name FROM metric_definitions");
    metricCatalog = new Set((rows as any[]).map((r) => String(r.metric_name)));
    catalogLoadedAt = now;
    return metricCatalog;
  } catch (e) {
    console.error("[Cron] 统计同步: 读取指标目录失败:", e);
    return metricCatalog; // 保留上次目录,首轮失败返回 null
  }
}

/** 单行覆盖写:无行 INSERT,有行用 Redis 值覆盖 */
async function upsertRow(
  parsed: ParsedKey,
  metricName: string,
  value: number,
  metaJson: string | null
): Promise<number> {
  const valueStr = String(value);
  const cacheKey = `${parsed.dim}|${parsed.dim1}|${parsed.dim2}|${metricName}|${parsed.date}|${parsed.hour}|${metaJson ?? ""}`;
  if (lastWritten.get(cacheKey) === valueStr) return 0; // 未变,跳过

  await cpQuery(
    `INSERT INTO unified_stats (stat_date, stat_hour, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE metric_value = VALUES(metric_value), meta_json = COALESCE(VALUES(meta_json), meta_json)`,
    [parsed.date, parsed.hour, parsed.dim, parsed.dim1, parsed.dim2, metricName, value, metaJson]
  );

  lastWritten.set(cacheKey, valueStr);
  if (lastWritten.size > CACHE_MAX) lastWritten.clear();
  return 1;
}

/** SCAN 键(游标遍历,不阻塞) */
async function* scanKeys(pattern: string): AsyncGenerator<string> {
  const stream = redis.scanStream({ match: pattern, count: 500 });
  for await (const keys of stream) {
    for (const k of keys) yield k as string;
  }
}

/** Redis key → unified_stats 行(维度/日期/小时);不匹配的可同步形态返回 null */
function parseStatsKey(key: string): ParsedKey | null {
  if (key.startsWith("stats:monthly:")) return parseMonthly(key);
  if (key.startsWith("stats:composite:")) return parseComposite(key);

  if (key.startsWith("stats:global:")) {
    const date = key.slice("stats:global:".length);
    if (!DATE_RE.test(date)) return null;
    return { dim: "global", dim1: "global", dim2: "", date, hour: -1 };
  }
  if (key.startsWith("stats:channel:")) {
    const parts = key.slice("stats:channel:".length).split(":");
    if (parts.length !== 2 || !DATE_RE.test(parts[1])) return null;
    return { dim: "channel", dim1: `ch:${parts[0]}`, dim2: "", date: parts[1], hour: -1 };
  }
  if (key.startsWith("stats:token:")) {
    const parts = key.slice("stats:token:".length).split(":");
    if (parts.length !== 2 || !DATE_RE.test(parts[1])) return null;
    return { dim: "token", dim1: `tk:${parts[0]}`, dim2: "", date: parts[1], hour: -1 };
  }
  if (key.startsWith("stats:model:")) {
    // 模型ID可含 ':'(如 claude:sonnet),日期是末段;tau/cau HLL 键不入库
    const rest = key.slice("stats:model:".length);
    const m = rest.match(/^(.+):(\d{4}-\d{2}-\d{2})$/);
    if (!m) return null;
    if (m[1].endsWith(":tau") || m[1].endsWith(":cau")) return null;
    return { dim: "model", dim1: `md:${m[1]}`, dim2: "", date: m[2], hour: -1 };
  }
  if (key.startsWith("stats:user:")) {
    // 仅同步 user 全局 Hash 与 user×model 子键;halfhour/hour/rank/qps/requests/tokens 等不入库
    const rest = key.slice("stats:user:".length);
    const g = rest.match(/^(\d+):(\d{4}-\d{2}-\d{2}):global$/);
    if (g) return { dim: "user", dim1: `user:${g[1]}`, dim2: "", date: g[2], hour: -1 };
    // user×model: {uid}:{date}:model:{model}(model 可含 ':'),dim2='md:{model}' 供 /stats/models 读
    const m = rest.match(/^(\d+):(\d{4}-\d{2}-\d{2}):model:(.+)$/);
    if (m) return { dim: "user", dim1: `user:${m[1]}`, dim2: `md:${m[3]}`, date: m[2], hour: -1 };
    return null;
  }
  if (key.startsWith("stats:hourly:")) {
    const parts = key.slice("stats:hourly:".length).split(":");
    if (parts.length !== 2 || !DATE_RE.test(parts[0]) || !HOUR_RE.test(parts[1])) return null;
    return { dim: "hourly", dim1: "global", dim2: "", date: parts[0], hour: parseInt(parts[1], 10) };
  }
  if (key.startsWith("stats:ride:")) {
    const parts = key.slice("stats:ride:".length).split(":");
    if (parts.length !== 2 || !DATE_RE.test(parts[1])) return null;
    return { dim: "ride", dim1: `ride:${parts[0]}`, dim2: "", date: parts[1], hour: -1 };
  }
  if (key.startsWith("stats:discount:")) {
    const date = key.slice("stats:discount:".length);
    if (!DATE_RE.test(date)) return null;
    return { dim: "discount", dim1: "discount", dim2: "", date, hour: -1 };
  }
  return null;
}

/** stats:composite:ch:{ch}:md:{model}:{date}(model 可含 ':',首段 md: 处拆) */
function parseComposite(key: string): ParsedKey | null {
  const rest = key.slice("stats:composite:".length);
  const m = rest.match(/^(.+):(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  const mdIdx = m[1].indexOf(":md:");
  if (mdIdx < 0) return null;
  return {
    dim: "composite",
    dim1: m[1].slice(0, mdIdx),          // ch:{ch}
    dim2: "md:" + m[1].slice(mdIdx + 4), // md:{model}
    date: m[2],
    hour: -1,
  };
}

/** stats:monthly:{yyyy-MM}:{dim}:{rest}(stat_date=当月首日) */
function parseMonthly(key: string): ParsedKey | null {
  const parts = key.slice("stats:monthly:".length).split(":");
  if (parts.length < 3) return null;
  const month = parts[0];
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const dim = parts[1];
  const tail = parts.slice(2).join(":");
  const date = month + "-01";
  if (dim === "composite") {
    const mdIdx = tail.indexOf(":md:");
    if (mdIdx < 0) return null;
    return { dim: "monthly", dim1: tail.slice(0, mdIdx), dim2: "md:" + tail.slice(mdIdx + 4), date, hour: -1 };
  }
  return { dim: "monthly", dim1: tail, dim2: "", date, hour: -1 };
}

// ==================== 工具 ====================

/** 上海时区 yyyy-MM-dd */
function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

/** mysql2 Date → "YYYY-MM-DD HH:mm:ss"(上海时区,+08:00) */
function formatDateTime(d: unknown): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d as any);
  if (isNaN(date.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function parseIntSafe(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseFloatSafe(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
