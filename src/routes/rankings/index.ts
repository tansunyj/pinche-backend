/**
 * 用量排行榜（挂载 /api/rankings，公开）
 *
 *   GET /?days=N   用量排行榜（默认近 7 天）
 *
 * 数据源 unified_stats（pt_carpool，cpQuery）。口径与 admin/stats 一致：
 *   - stat_hour=-1 才是日粒度（0-23 是 hourly 行，不得混入趋势/排行）
 *   - user/model 维度只取 dim2_key=''（排除 user×model 子行避免重复累计）
 * 公开版脱敏：用户贡献榜只返回昵称（无昵称用「用户#id」），绝不返回手机/邮箱。
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";

const router = Router();

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

router.get("/", async (req: Request, res: Response) => {
  try {
    // days 解析必须兜底 NaN：非法/缺失值(如 ?days=undefined)一律回落默认 7 天，
    // 否则 NaN 会直接进 SQL INTERVAL ? DAY 抛异常 → 500。
    let days = parseInt(String(req.query.days ?? ""), 10);
    if (!Number.isFinite(days)) days = 7;
    days = Math.min(90, Math.max(1, days));
    const date = todayStr();

    // 注意：解构名必须与下方 5 个查询顺序一一对应，曾因错位导致
    // modelRows 拿到 saved_quota 单行、贡献榜混入模型数据、ride 统计恒 0。
    const [rideRows, kpiRows, savedRows, modelRows, userRows] = await Promise.all([
      // 拼车进度（公开车次在拼/已成团数）
      cpQuery(
        `SELECT
           COALESCE(SUM(CASE WHEN r.status='ACTIVE' AND r.enroll_type='PUBLIC'
                  AND (r.start_time IS NULL OR r.start_time > NOW())
                  AND (r.end_time IS NULL OR r.end_time > NOW()) THEN 1 ELSE 0 END),0) AS pooling,
           COALESCE(SUM(CASE WHEN r.status='ACTIVE' AND r.enroll_type='PUBLIC'
                  AND (r.start_time IS NULL OR r.start_time > NOW())
                  AND (r.end_time IS NULL OR r.end_time > NOW())
                  AND (r.established_at IS NOT NULL OR r.current_count >= r.min_count) THEN 1 ELSE 0 END),0) AS established
         FROM pt_rides r`
      ),
      // 今日全平台（global 维度）
      cpQuery(
        `SELECT metric_name, metric_value FROM unified_stats
         WHERE dim_type='global' AND dim1_key='global' AND stat_date=? AND stat_hour=-1`,
        [date]
      ),
      // 累计节省（discount 维度近 90 天）
      cpQuery(
        `SELECT COALESCE(SUM(metric_value),0) AS v FROM unified_stats
         WHERE dim_type='discount' AND dim1_key='discount' AND metric_name='saved_quota'
           AND stat_hour=-1 AND stat_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)`
      ),
      // 模型用量榜：近 N 天 token/请求/额度
      cpQuery(
        `SELECT dim1_key AS k,
                COALESCE(SUM(CASE WHEN metric_name='requests'          THEN metric_value END),0) AS requests,
                COALESCE(SUM(CASE WHEN metric_name='prompt_tokens'     THEN metric_value END),0) AS prompt_tokens,
                COALESCE(SUM(CASE WHEN metric_name='completion_tokens' THEN metric_value END),0) AS completion_tokens,
                COALESCE(SUM(CASE WHEN metric_name='quota'             THEN metric_value END),0) AS quota
         FROM unified_stats
         WHERE dim_type='model' AND stat_hour=-1 AND dim2_key=''
           AND dim1_key LIKE 'md:%' AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY dim1_key ORDER BY quota DESC LIMIT 20`,
        [days - 1]
      ),
      // 用户贡献榜：近 N 天额度/请求（带昵称脱敏）
      cpQuery(
        `SELECT u.dim1_key AS k, u.requests, u.quota,
                COALESCE(NULLIF(p.nickname,''), CONCAT('用户#', CAST(REPLACE(u.dim1_key,'user:','') AS UNSIGNED))) AS name
         FROM (
           SELECT dim1_key,
                  COALESCE(SUM(CASE WHEN metric_name='requests' THEN metric_value END),0) AS requests,
                  COALESCE(SUM(CASE WHEN metric_name='quota'     THEN metric_value END),0) AS quota
           FROM unified_stats
           WHERE dim_type='user' AND stat_hour=-1 AND dim2_key=''
             AND dim1_key LIKE 'user:%' AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
           GROUP BY dim1_key
           ORDER BY quota DESC LIMIT 20
         ) u
         LEFT JOIN pt_users p ON p.id = CAST(REPLACE(u.dim1_key,'user:','') AS UNSIGNED)
         ORDER BY u.quota DESC`,
        [days - 1]
      ),
    ]);

    const kpiByName: Record<string, number> = {};
    for (const r of (Array.isArray(kpiRows) ? kpiRows : []) as any[]) {
      kpiByName[r.metric_name] = num(r.metric_value);
    }

    const rideAgg = (Array.isArray(rideRows) ? rideRows[0] : {}) as Record<
      string,
      unknown
    >;

    res.json({
      days,
      kpi: {
        poolingRides: num(rideAgg.pooling),
        establishedRides: num(rideAgg.established),
        todayRequests: kpiByName.requests || 0,
        todayQuota: kpiByName.quota || 0,
        savedQuota: num((savedRows as any[])[0]?.v),
      },
      models: (Array.isArray(modelRows) ? modelRows : []).map((r: any) => {
        const prompt = num(r.prompt_tokens);
        const completion = num(r.completion_tokens);
        return {
          key: String(r.k),
          name: String(r.k).replace(/^md:/, ""),
          requests: num(r.requests),
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
          quotaYuan: Math.round((num(r.quota) / QUOTA_PER_YUAN) * 10000) / 10000,
        };
      }),
      contributors: (Array.isArray(userRows) ? userRows : []).map((r: any) => ({
        key: String(r.k),
        name: String(r.name),
        requests: num(r.requests),
        quotaYuan: Math.round((num(r.quota) / QUOTA_PER_YUAN) * 10000) / 10000,
      })),
    });
  } catch (err) {
    console.error("Rankings error:", err);
    res.status(500).json({ error: "获取用量排行榜失败" });
  }
});

export default router;
