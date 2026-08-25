/**
 * 管理端统计（挂载 /api/admin/stats）
 *
 *   GET /overview           运营总览（用户/车次/折扣/充值）
 *   GET /recharge-trend     近 N 天充值趋势
 *   GET /today              今日实时（Redis stats:global:{today}）
 *   GET /dimension/trend    维度趋势（global/channel/model/user × daily/monthly）
 *   GET /dimension/ranking  维度排行（channel/model/user × quota/requests）
 *   GET /rides/overview     车次概览（pt_rides + ride 维度统计）
 *   GET /discounts/overview 折扣效果概览（discount 维度）
 *
 * 维度查询统一读 unified_stats（pt_carpool，cpQuery）。
 * 关键口径：
 *   - stat_hour=-1 才是日/月粒度（0-23 是 hourly 行，不得混入趋势/排行）
 *   - user 维度只取 dim2_key=''（日粒度 global 行），排除 user×model 子行避免重复累计
 *   - metric_name 全部来自 metric_definitions 目录（§0.0-13）
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";
import redis from "../../utils/redis";

const router = Router();
router.use(adminAuth);

/** 上海时区 yyyy-MM-dd */
function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

/** 安全取数字 */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 1 元 = 100000 额度(与网关计费口径一致) */
const QUOTA_PER_YUAN = 100000;

router.get("/overview", async (_req: Request, res: Response) => {
  try {
    const [users, rides, members, payments, discountRows] = await Promise.all([
      cpQuery("SELECT COUNT(*) AS cnt FROM pt_users"),
      cpQuery("SELECT COUNT(*) AS total, SUM(status='ACTIVE') AS active_cnt FROM pt_rides"),
      cpQuery("SELECT COUNT(DISTINCT user_id) AS cnt FROM pt_ride_members WHERE status='ACTIVE'"),
      cpQuery("SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_yuan),0) AS total_yuan FROM pt_payments WHERE status='SUCCESS'"),
      cpQuery(
        `SELECT metric_name, metric_value FROM unified_stats
         WHERE dim_type='discount' AND dim1_key='discount' AND stat_date=? AND stat_hour=-1`,
        [todayStr()]
      ),
    ]);

    // 折扣维度今日:折扣请求 / 总请求
    const discByName: Record<string, number> = {};
    for (const r of (Array.isArray(discountRows) ? discountRows : []) as any[]) {
      discByName[r.metric_name] = Number(r.metric_value) || 0;
    }

    res.json({
      users: Number((users[0] as any).cnt || 0),
      rides: {
        total: Number((rides[0] as any).total || 0),
        active: Number((rides[0] as any).active_cnt || 0),
      },
      activeMembers: Number((members[0] as any).cnt || 0),
      recharge: {
        orderCount: Number((payments[0] as any).cnt || 0),
        amountYuan: Number((payments[0] as any).total_yuan || 0),
      },
      // 折扣维度今日:折扣请求 / 总请求(与下方折扣概览卡同源)
      discounts: { total: discByName.requests || 0, active: discByName.discounted_requests || 0 },
    });
  } catch (err) {
    console.error("Admin stats overview error:", err);
    res.status(500).json({ error: "获取统计失败" });
  }
});

router.get("/recharge-trend", async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "7"), 10)));
    const rows = await cpQuery(
      // DATE_FORMAT 返回纯本地日期串(YYYY-MM-DD),避免 mysql2 序列化成 UTC ISO 导致前端标签偏移一天
      `SELECT DATE_FORMAT(paid_at, '%Y-%m-%d') AS d, COUNT(*) AS cnt, COALESCE(SUM(amount_yuan),0) AS total_yuan
       FROM pt_payments
       WHERE status='SUCCESS' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE_FORMAT(paid_at, '%Y-%m-%d')
       ORDER BY d ASC`,
      [days - 1]
    );
    res.json({ days, trend: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error("Admin recharge trend error:", err);
    res.status(500).json({ error: "获取充值趋势失败" });
  }
});

// ============ 今日实时（Redis） ============

/**
 * GET /today —— Redis 今日实时（全局维度）。
 * 读 stats:global:{today}，未命中返回全 0（今日尚无流量）。
 */
router.get("/today", async (_req: Request, res: Response) => {
  try {
    const date = todayStr();
    const h = (await redis.hgetall(`stats:global:${date}`).catch(() => null)) || {};
    const requests = num(h.requests);
    const success = num(h.success);
    const error = num(h.error);
    const latencyCount = num(h.latency_count);
    const latencySum = num(h.latency_sum);
    res.json({
      date,
      requests,
      quota: num(h.quota),
      success,
      error,
      errorRate: requests > 0 ? Math.round((error / requests) * 10000) / 100 : 0,
      latencyAvgMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
      uniqueRides: 0, // 今日实时车次数：Redis ride 维度若命中再补
    });
  } catch (err) {
    console.error("Admin stats today error:", err);
    res.status(500).json({ error: "获取今日统计失败" });
  }
});

// ============ 维度趋势 / 排行 ============

/** 维度 → unified_stats 查询参数（dim_type + dim1 前缀 + 是否限定 dim2=''） */
function dimSpec(dim: string): { dimType: string; prefix: string; dailyOnly: boolean } {
  switch (dim) {
    case "channel":
      return { dimType: "channel", prefix: "ch:%", dailyOnly: true };
    case "model":
      return { dimType: "model", prefix: "md:%", dailyOnly: true };
    case "user":
      // user 维度含 user×model 子行(dim2='md:%')，聚合全局行须限定 dim2=''
      return { dimType: "user", prefix: "user:%", dailyOnly: true };
    case "global":
    default:
      return { dimType: "global", prefix: "global", dailyOnly: true };
  }
}

/**
 * GET /dimension/trend?dim=global|channel|model|user&granularity=daily|monthly&from=yyyy-MM-dd&to=yyyy-MM-dd
 * 多天/多月趋势（请求量、消费、成功率、延迟）。按维度前缀聚合并行（同一维度的所有实体）。
 */
router.get("/dimension/trend", async (req: Request, res: Response) => {
  try {
    const dim = String(req.query.dim || "global");
    const granularity = String(req.query.granularity || "daily");
    const spec = dimSpec(dim);
    if (granularity !== "monthly" && granularity !== "daily") {
      res.status(400).json({ error: "granularity 仅支持 daily | monthly" });
      return;
    }

    // from/to 默认近 30 天；monthly 则近 12 个月
    const to = String(req.query.to || todayStr());
    const from = String(req.query.from || "");
    const fromDate =
      from ||
      (granularity === "monthly"
        ? new Date(new Date(`${to}T00:00:00+08:00`).setMonth(new Date(`${to}T00:00:00+08:00`).getMonth() - 11))
            .toISOString().slice(0, 10)
        : new Date(new Date(`${to}T00:00:00+08:00`).setDate(new Date(`${to}T00:00:00+08:00`).getDate() - 29))
            .toISOString().slice(0, 10));

    const dayExpr = granularity === "monthly" ? "DATE_FORMAT(stat_date, '%Y-%m')" : "DATE_FORMAT(stat_date, '%Y-%m-%d')";
    const dim2Filter = spec.dailyOnly ? "AND dim2_key = ''" : "";

    const rows = (await cpQuery(
      `SELECT ${dayExpr} AS d,
              COALESCE(SUM(CASE WHEN metric_name='requests' THEN metric_value END),0) AS requests,
              COALESCE(SUM(CASE WHEN metric_name='quota'     THEN metric_value END),0) AS quota,
              COALESCE(SUM(CASE WHEN metric_name='success'   THEN metric_value END),0) AS success,
              COALESCE(SUM(CASE WHEN metric_name='error'     THEN metric_value END),0) AS error,
              COALESCE(SUM(CASE WHEN metric_name='latency_sum'   THEN metric_value END),0) AS latency_sum,
              COALESCE(SUM(CASE WHEN metric_name='latency_count' THEN metric_value END),0) AS latency_count
       FROM unified_stats
       WHERE dim_type = ? AND stat_hour = -1 AND stat_date BETWEEN ? AND ?
         AND dim1_key LIKE ? ${dim2Filter}
       GROUP BY d ORDER BY d ASC`,
      [spec.dimType, fromDate, to, spec.prefix]
    )) as any[];

    res.json({
      dim,
      granularity,
      from: fromDate,
      to,
      trend: (Array.isArray(rows) ? rows : []).map((r) => {
        const reqs = num(r.requests);
        const errs = num(r.error);
        const lc = num(r.latency_count);
        const ls = num(r.latency_sum);
        return {
          date: r.d,
          requests: reqs,
          quota: num(r.quota),
          success: num(r.success),
          error: errs,
          successRate: reqs > 0 ? Math.round((num(r.success) / reqs) * 10000) / 100 : 0,
          errorRate: reqs > 0 ? Math.round((errs / reqs) * 10000) / 100 : 0,
          latencyAvgMs: lc > 0 ? Math.round(ls / lc) : 0,
        };
      }),
    });
  } catch (err) {
    console.error("Admin dimension trend error:", err);
    res.status(500).json({ error: "获取维度趋势失败" });
  }
});

/**
 * GET /dimension/ranking?dim=channel|model|user&metric=quota|requests&days=N（默认 1=今日）
 * 维度排行（最近 N 天累计 top 20）。saved_quota 排行见 /rides/overview（车次维度才有）。
 */
router.get("/dimension/ranking", async (req: Request, res: Response) => {
  try {
    const dim = String(req.query.dim || "model");
    const metric = String(req.query.metric || "quota");
    if (!["channel", "model", "user"].includes(dim)) {
      res.status(400).json({ error: "dim 仅支持 channel | model | user" });
      return;
    }
    if (!["quota", "requests"].includes(metric)) {
      res.status(400).json({ error: "metric 仅支持 quota | requests" });
      return;
    }
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "1"), 10)));
    const spec = dimSpec(dim);

    const rows = (await cpQuery(
      `SELECT dim1_key AS k, SUM(metric_value) AS v
       FROM unified_stats
       WHERE dim_type = ? AND metric_name = ? AND stat_hour = -1
         AND dim1_key LIKE ? AND dim2_key = ''
         AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY dim1_key ORDER BY v DESC LIMIT 20`,
      [spec.dimType, metric, spec.prefix, days - 1]
    )) as any[];

    // 去掉前缀，展示名友好（ch:5 → 5 / md:aliyun/qwen → aliyun/qwen / user:7 → 7）
    const items = (Array.isArray(rows) ? rows : []).map((r: any) => ({
      key: String(r.k),
      name: String(r.k).replace(/^(ch:|md:|user:)/, ""),
      value: num(r.v),
    }));
    res.json({ dim, metric, days, items });
  } catch (err) {
    console.error("Admin dimension ranking error:", err);
    res.status(500).json({ error: "获取维度排行失败" });
  }
});

/**
 * GET /dimension/consumption?dim=channel|model&days=N（默认 1=今日）
 * 各实体消耗明细：请求数、输入/输出/总 tokens、消耗(元)。
 * 渠道名经 proxy_channels.id 映射（ch:31 → 阿里云）；model 名去掉 md: 前缀。
 */
router.get("/dimension/consumption", async (req: Request, res: Response) => {
  try {
    const dim = String(req.query.dim || "model");
    if (!["channel", "model"].includes(dim)) {
      res.status(400).json({ error: "dim 仅支持 channel | model" });
      return;
    }
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "1"), 10)));
    const spec = dimSpec(dim);

    const rows = (await cpQuery(
      `SELECT dim1_key AS k,
              COALESCE(SUM(CASE WHEN metric_name='requests'          THEN metric_value END),0) AS requests,
              COALESCE(SUM(CASE WHEN metric_name='prompt_tokens'     THEN metric_value END),0) AS prompt_tokens,
              COALESCE(SUM(CASE WHEN metric_name='completion_tokens' THEN metric_value END),0) AS completion_tokens,
              COALESCE(SUM(CASE WHEN metric_name='quota'             THEN metric_value END),0) AS quota
       FROM unified_stats
       WHERE dim_type = ? AND stat_hour = -1 AND dim2_key = ''
         AND dim1_key LIKE ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY dim1_key ORDER BY quota DESC LIMIT 50`,
      [spec.dimType, spec.prefix, days - 1]
    )) as any[];

    // channel 维度:映射渠道名(proxy_channels 只取 id/name，绝不取 api_key)
    const nameMap = new Map<string, string>();
    if (dim === "channel") {
      const ids = (Array.isArray(rows) ? rows : [])
        .map((r) => parseInt(String(r.k).replace(/^ch:/, ""), 10))
        .filter((n) => Number.isFinite(n));
      if (ids.length > 0) {
        const chRows = (await cpQuery(
          `SELECT id, name FROM proxy_channels WHERE id IN (${ids.join(",")})`,
          []
        )) as any[];
        for (const c of Array.isArray(chRows) ? chRows : []) {
          nameMap.set(`ch:${c.id}`, String(c.name));
        }
      }
    }

    const items = (Array.isArray(rows) ? rows : []).map((r: any) => {
      const key = String(r.k);
      const prompt = num(r.prompt_tokens);
      const completion = num(r.completion_tokens);
      return {
        key,
        name: nameMap.get(key) ?? key.replace(/^(ch:|md:)/, ""),
        requests: num(r.requests),
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        quotaYuan: Math.round((num(r.quota) / QUOTA_PER_YUAN) * 10000) / 10000,
      };
    });

    res.json({ dim, days, items });
  } catch (err) {
    console.error("Admin dimension consumption error:", err);
    res.status(500).json({ error: "获取维度消耗明细失败" });
  }
});

/**
 * GET /dimension/token-trend?dim=channel|model|global&days=N（默认 global、7）
 * 每日 tokens 消耗：输入/输出/总 tokens + 请求数 + 消耗(元)。
 * global = 全站；channel/model = 该维度所有实体每日聚合（与 /dimension/consumption 同口径）。
 * DATE_FORMAT 返回纯日期串，避免 mysql2 序列化成 UTC ISO 导致前端标签偏移一天。
 */
router.get("/dimension/token-trend", async (req: Request, res: Response) => {
  try {
    const dim = String(req.query.dim || "global");
    if (!["channel", "model", "global"].includes(dim)) {
      res.status(400).json({ error: "dim 仅支持 channel | model | global" });
      return;
    }
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "7"), 10)));
    const spec = dimSpec(dim);
    const rows = (await cpQuery(
      `SELECT DATE_FORMAT(stat_date, '%Y-%m-%d') AS d,
              COALESCE(SUM(CASE WHEN metric_name='requests'          THEN metric_value END),0) AS requests,
              COALESCE(SUM(CASE WHEN metric_name='prompt_tokens'     THEN metric_value END),0) AS prompt_tokens,
              COALESCE(SUM(CASE WHEN metric_name='completion_tokens' THEN metric_value END),0) AS completion_tokens,
              COALESCE(SUM(CASE WHEN metric_name='quota'             THEN metric_value END),0) AS quota
       FROM unified_stats
       WHERE dim_type = ? AND stat_hour = -1 AND dim2_key = ''
         AND dim1_key LIKE ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY d ORDER BY d ASC`,
      [spec.dimType, spec.prefix, days - 1]
    )) as any[];

    res.json({
      dim,
      days,
      trend: (Array.isArray(rows) ? rows : []).map((r) => {
        const prompt = num(r.prompt_tokens);
        const completion = num(r.completion_tokens);
        return {
          date: r.d,
          requests: num(r.requests),
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
          quotaYuan: Math.round((num(r.quota) / QUOTA_PER_YUAN) * 10000) / 10000,
        };
      }),
    });
  } catch (err) {
    console.error("Admin dimension token trend error:", err);
    res.status(500).json({ error: "获取每日 tokens 消耗失败" });
  }
});

/**
 * GET /dimension/entity-token-trend?dim=channel|model&days=N（默认 model、7）
 * 按实体返回每日输入/输出 tokens（实体内逐日，非跨实体聚合）。模型 tab 用：每个实体一条折线。
 * 渠道名经 proxy_channels 映射；model 名去掉 md: 前缀。按近 N 天总 tokens 降序。
 */
router.get("/dimension/entity-token-trend", async (req: Request, res: Response) => {
  try {
    const dim = String(req.query.dim || "model");
    if (!["channel", "model"].includes(dim)) {
      res.status(400).json({ error: "dim 仅支持 channel | model" });
      return;
    }
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "7"), 10)));
    const spec = dimSpec(dim);

    const rows = (await cpQuery(
      `SELECT dim1_key AS k, DATE_FORMAT(stat_date, '%Y-%m-%d') AS d,
              COALESCE(SUM(CASE WHEN metric_name='requests'          THEN metric_value END),0) AS requests,
              COALESCE(SUM(CASE WHEN metric_name='prompt_tokens'     THEN metric_value END),0) AS prompt_tokens,
              COALESCE(SUM(CASE WHEN metric_name='completion_tokens' THEN metric_value END),0) AS completion_tokens,
              COALESCE(SUM(CASE WHEN metric_name='quota'             THEN metric_value END),0) AS quota
       FROM unified_stats
       WHERE dim_type = ? AND stat_hour = -1 AND dim2_key = ''
         AND dim1_key LIKE ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY dim1_key, stat_date ORDER BY dim1_key ASC, stat_date ASC`,
      [spec.dimType, spec.prefix, days - 1]
    )) as any[];

    // channel 维度:映射渠道名(proxy_channels 只取 id/name，绝不取 api_key)
    const nameMap = new Map<string, string>();
    if (dim === "channel") {
      const ids = (Array.isArray(rows) ? rows : [])
        .map((r) => parseInt(String(r.k).replace(/^ch:/, ""), 10))
        .filter((n) => Number.isFinite(n));
      if (ids.length > 0) {
        const chRows = (await cpQuery(
          `SELECT id, name FROM proxy_channels WHERE id IN (${ids.join(",")})`,
          []
        )) as any[];
        for (const c of Array.isArray(chRows) ? chRows : []) {
          nameMap.set(`ch:${c.id}`, String(c.name));
        }
      }
    }

    const byKey = new Map<string, { total: number; trend: any[] }>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const key = String(r.k);
      const prompt = num(r.prompt_tokens);
      const completion = num(r.completion_tokens);
      let e = byKey.get(key);
      if (!e) {
        e = { total: 0, trend: [] };
        byKey.set(key, e);
      }
      e.total += prompt + completion;
      e.trend.push({
        date: String(r.d),
        requests: num(r.requests),
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      });
    }

    const entities = [...byKey.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([key, e]) => ({
        key,
        name: nameMap.get(key) ?? key.replace(/^(ch:|md:)/, ""),
        trend: e.trend,
      }));

    res.json({ dim, days, entities });
  } catch (err) {
    console.error("Admin entity token trend error:", err);
    res.status(500).json({ error: "获取实体 token 趋势失败" });
  }
});

// ============ 车次 / 折扣 概览 ============

/**
 * GET /rides/overview —— 每个车次：达成进度 + 近 30 天 ride 维度消费/节省/折扣率。
 * 数据源 pt_rides（实时进度）+ unified_stats ride 维度（统计）。无统计数据的车次显示 0。
 */
router.get("/rides/overview", async (_req: Request, res: Response) => {
  try {
    const rows = (await cpQuery(
      `SELECT r.id, r.name, r.status, r.current_count, r.min_count,
              r.start_time, r.end_time, r.established_at,
              COALESCE(SUM(CASE WHEN u.metric_name='ride_requests'       THEN u.metric_value END),0) AS ride_requests,
              COALESCE(SUM(CASE WHEN u.metric_name='ride_saved_quota'    THEN u.metric_value END),0) AS saved_quota,
              COALESCE(SUM(CASE WHEN u.metric_name='discounted_requests' THEN u.metric_value END),0) AS discounted_requests,
              COALESCE(MAX(CASE WHEN u.metric_name='discount_rate'  THEN u.metric_value END),1) AS discount_rate
       FROM pt_rides r
       LEFT JOIN unified_stats u
         ON u.dim_type='ride' AND u.dim1_key=CONCAT('ride:', r.id)
            AND u.stat_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND u.stat_hour=-1
       GROUP BY r.id
       ORDER BY (r.status='ACTIVE') DESC, r.id DESC`
    )) as any[];

    res.json({
      rides: (Array.isArray(rows) ? rows : []).map((r: any) => {
        const current = num(r.current_count);
        const min = num(r.min_count);
        return {
          id: num(r.id),
          name: r.name,
          status: r.status,
          currentCount: current,
          minCount: min,
          remainingToUnlock: Math.max(min - current, 0), // 再进 N 人解锁折扣
          progress: min > 0 ? Math.min(100, Math.round((current / min) * 100)) : 0,
          establishedAt: r.established_at,
          startTime: r.start_time,
          endTime: r.end_time,
          rideRequests: num(r.ride_requests),
          savedQuota: num(r.saved_quota),
          discountedRequests: num(r.discounted_requests),
          discountRate: num(r.discount_rate) || 1,
        };
      }),
    });
  } catch (err) {
    console.error("Admin rides overview error:", err);
    res.status(500).json({ error: "获取车次概览失败" });
  }
});

/**
 * GET /discounts/overview —— 折扣效果概览（discount 维度）。
 * 今日：当日行直接读；累计：近 90 天聚合（discount_rate 是 gauge，累计取各日平均）。
 */
router.get("/discounts/overview", async (_req: Request, res: Response) => {
  try {
    const date = todayStr();
    const todayRows = (await cpQuery(
      `SELECT metric_name, metric_value FROM unified_stats
       WHERE dim_type='discount' AND dim1_key='discount' AND stat_date=? AND stat_hour=-1`,
      [date]
    )) as any[];
    const totalRows = (await cpQuery(
      `SELECT metric_name,
              CASE WHEN metric_name='discount_rate' THEN AVG(metric_value)
                   ELSE SUM(metric_value) END AS v
       FROM unified_stats
       WHERE dim_type='discount' AND dim1_key='discount' AND stat_hour=-1
         AND stat_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
       GROUP BY metric_name`
    )) as any[];

    const pick = (rows: any[], name: string): number => {
      const row = (Array.isArray(rows) ? rows : []).find((r: any) => r.metric_name === name);
      return row ? num(row.v ?? row.metric_value) : 0;
    };
    const fmt = (rows: any[]) => {
      const requests = pick(rows, "requests");
      const discounted = pick(rows, "discounted_requests");
      return {
        requests,
        discountedRequests: discounted,
        discountedRate: requests > 0 ? Math.round((discounted / requests) * 10000) / 100 : 0,
        savedQuota: pick(rows, "saved_quota"),
        discountRate: pick(rows, "discount_rate") || 1,
        discountRateMin: pick(rows, "discount_rate_min") || 1,
      };
    };

    res.json({ date, today: fmt(todayRows), total: fmt(totalRows) });
  } catch (err) {
    console.error("Admin discounts overview error:", err);
    res.status(500).json({ error: "获取折扣效果失败" });
  }
});

export default router;
