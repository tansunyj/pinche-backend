/**
 * 用量统计（挂载 /api/user/stats）
 *
 * 数据源统一改为 unified_stats（pt_carpool，cpQuery）dim_type='user'：
 *   GET /          今日/本月/累计消费、请求量、节省额度（返回结构兼容旧版，前端零改动）
 *   GET /models    用户×模型消费分布（unified_stats user 维度 dim2='md:%'）
 *   GET /trend     近 N 天/月消费趋势（unified_stats user 维度按日/月聚合）
 *
 * 口径：
 *   - stat_hour=-1 才是日/月粒度；user 维度只取 dim2_key='' 的全局行，排除 user×model 子行避免重复
 *   - saved_quota 由网关在 user 维度写入（命中车次折扣时累计）；网关升级前该值为 0
 *   - 已废弃对 proxy_logs 的全表实时 SUM（数据量增长后扫表不可持续，§6.2）
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 聚合某用户的指标（dim2='' 全局行，跨全部历史） */
async function aggregateUser(userId: number) {
  const rows = (await cpQuery(
    `SELECT metric_name,
            SUM(CASE WHEN stat_date = CURDATE() THEN metric_value END) AS today_v,
            SUM(CASE WHEN YEAR(stat_date) = YEAR(CURDATE()) AND MONTH(stat_date) = MONTH(CURDATE())
                     THEN metric_value END) AS month_v,
            SUM(metric_value) AS total_v
     FROM unified_stats
     WHERE dim_type = 'user' AND dim1_key = ? AND dim2_key = '' AND stat_hour = -1
     GROUP BY metric_name`,
    [`user:${userId}`]
  )) as any[];

  const pick = (name: string) => {
    const row = (Array.isArray(rows) ? rows : []).find((r: any) => r.metric_name === name);
    return {
      today: row ? num(row.today_v) : 0,
      month: row ? num(row.month_v) : 0,
      total: row ? num(row.total_v) : 0,
    };
  };
  return {
    quota: pick("quota"),
    requests: pick("requests"),
    savedQuota: pick("saved_quota"),
  };
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const agg = await aggregateUser(userId);
    res.json({
      // 兼容旧字段（前端无需改动，§7.3）
      totalConsumption: agg.quota.total,
      todayConsumption: agg.quota.today,
      monthConsumption: agg.quota.month,
      totalRequests: agg.requests.total,
      // 新增：节省额度（网关写 user 维度 saved_quota，升级前为 0）
      savedQuota: agg.savedQuota.total,
      savedQuotaToday: agg.savedQuota.today,
      savedQuotaMonth: agg.savedQuota.month,
    });
  } catch (err) {
    console.error("Get stats error:", err);
    res.status(500).json({ error: "获取统计失败" });
  }
});

/** GET /models —— 用户×模型消费分布（unified_stats user 维度 dim2='md:%'，按消费降序） */
router.get("/models", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const rows = (await cpQuery(
      `SELECT dim2_key AS k,
              COALESCE(SUM(CASE WHEN metric_name='quota'    THEN metric_value END),0) AS quota,
              COALESCE(SUM(CASE WHEN metric_name='requests' THEN metric_value END),0) AS requests
       FROM unified_stats
       WHERE dim_type='user' AND dim1_key=? AND dim2_key LIKE 'md:%' AND stat_hour=-1
       GROUP BY dim2_key ORDER BY quota DESC LIMIT 50`,
      [`user:${userId}`]
    )) as any[];
    res.json({
      models: (Array.isArray(rows) ? rows : []).map((r: any) => ({
        name: String(r.k).replace(/^md:/, ""),
        quota: num(r.quota),
        requests: num(r.requests),
      })),
    });
  } catch (err) {
    console.error("Get stats models error:", err);
    res.status(500).json({ error: "获取模型分布失败" });
  }
});

/** GET /trend?days=N —— 近 N 天（或 N 月）消费趋势，读 unified_stats user 维度按日聚合 */
router.get("/trend", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const granularity = String(req.query.granularity || "daily");
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "7"), 10)));
    const dayExpr = granularity === "monthly" ? "DATE_FORMAT(stat_date, '%Y-%m')" : "DATE_FORMAT(stat_date, '%Y-%m-%d')";

    const rows = (await cpQuery(
      `SELECT ${dayExpr} AS d,
              COALESCE(SUM(CASE WHEN metric_name='quota'    THEN metric_value END),0) AS quota,
              COALESCE(SUM(CASE WHEN metric_name='requests' THEN metric_value END),0) AS requests
       FROM unified_stats
       WHERE dim_type='user' AND dim1_key=? AND dim2_key='' AND stat_hour=-1
         AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY d ORDER BY d ASC`,
      [`user:${userId}`, days - 1]
    )) as any[];
    res.json({
      granularity,
      days,
      trend: (Array.isArray(rows) ? rows : []).map((r: any) => ({
        date: r.d,
        quota: num(r.quota),
        requests: num(r.requests),
      })),
    });
  } catch (err) {
    console.error("Get stats trend error:", err);
    res.status(500).json({ error: "获取消费趋势失败" });
  }
});

export default router;
