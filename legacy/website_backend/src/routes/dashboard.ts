/**
 * 企业数据大盘接口 - 拆分为多个独立接口
 * 从 Redis 读取实时统计数据（由 api-relay 写入）
 */
import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";
import StatsService from "../services/StatsService";

const router = Router();

/**
 * GET /api/dashboard/realtime
 * 获取实时 QPS
 */
router.get("/realtime", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const realtimeQps = await StatsService.getUserRealtimeQps(userId);

    res.json({
      realtime_qps: realtimeQps,
      qps_limit: 150, // 可从用户配置表读取
    });
  } catch (error) {
    console.error("[Dashboard/realtime] 获取实时QPS失败:", error);
    res.status(500).json({ error: "获取实时QPS失败" });
  }
});

/**
 * GET /api/dashboard/overview
 * 获取今日概览（tokens、requests、错误率）
 */
router.get("/overview", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const today = new Date().toISOString().split("T")[0];
    const todayStats = await StatsService.getUserDailyOverview(userId, today);

    // 获取分类统计（文字聊天、生图、生视频）
    const requestBreakdown = await StatsService.getUserRequestBreakdown(userId, today);

    res.json({
      today_tokens: todayStats.totalTokens,
      today_requests: todayStats.requests,
      today_error_rate: todayStats.errorRate,
      today_error_count: todayStats.errorCount,
      today_prompt_tokens: todayStats.promptTokens,
      today_completion_tokens: todayStats.completionTokens,
      today_quota_consumed: todayStats.quotaConsumed,
      // 分类统计
      chat_requests: requestBreakdown.chat,
      image_requests: requestBreakdown.image,
      video_requests: requestBreakdown.video,
    });
  } catch (error) {
    console.error("[Dashboard/overview] 获取今日概览失败:", error);
    res.status(500).json({ error: "获取今日概览失败" });
  }
});

/**
 * GET /api/dashboard/estimate
 * 获取资源预估（预估可用天数）
 */
router.get("/estimate", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const today = new Date().toISOString().split("T")[0];

    const [totalBalanceYuan, todayConsumedYuan] = await Promise.all([
      getUserTotalBalanceYuan(userId),
      getTodayConsumptionYuan(userId),
    ]);

    // 计算预估可用天数（总余额 / 今日消耗）
    let estimatedDays = 0;
    if (totalBalanceYuan > 0 && todayConsumedYuan > 0) {
      estimatedDays = Math.floor(totalBalanceYuan / todayConsumedYuan);
    }
    // 最低显示1天（只要有余额）
    if (totalBalanceYuan > 0 && estimatedDays < 1) {
      estimatedDays = 1;
    }

    res.json({
      total_balance: totalBalanceYuan,
      today_consumed: todayConsumedYuan,
      estimated_days: estimatedDays,
    });
  } catch (error) {
    console.error("[Dashboard/estimate] 获取资源预估失败:", error);
    res.status(500).json({ error: "获取资源预估失败" });
  }
});

/**
 * GET /api/dashboard/trend
 * 获取过去24小时趋势（从当前时间往前推24小时）
 */
router.get("/trend", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const hourlyTrend = await StatsService.getUserLast24hTrend(userId);

    res.json({
      trend_24h: hourlyTrend.map((h) => h.requests),
      trend_tokens_24h: hourlyTrend.map((h) => h.totalTokens),
      trend_quota_24h: hourlyTrend.map((h) => h.quotaConsumed),
      trend_error_24h: hourlyTrend.map((h) => h.errorCount),
      hours: hourlyTrend.map((h) => h.hour),
      datetimes: hourlyTrend.map((h) => h.datetime),
    });
  } catch (error) {
    console.error("[Dashboard/trend] 获取24小时趋势失败:", error);
    res.status(500).json({ error: "获取24小时趋势失败" });
  }
});

/**
 * GET /api/dashboard/models
 * 获取模型使用占比
 */
router.get("/models", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const today = new Date().toISOString().split("T")[0];
    const limit = parseInt(req.query.limit as string) || 10;
    const modelDistribution = await StatsService.getUserModelDistribution(userId, today, limit);

    res.json({
      model_distribution: modelDistribution,
    });
  } catch (error) {
    console.error("[Dashboard/models] 获取模型使用占比失败:", error);
    res.status(500).json({ error: "获取模型使用占比失败" });
  }
});

/**
 * GET /api/dashboard/logs
 * 获取最近消费记录
 */
router.get("/logs", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const limit = parseInt(req.query.limit as string) || 10;
    const recentLogs = await getRecentLogsFromMySQL(userId, limit);

    res.json({
      recent_logs: recentLogs,
    });
  } catch (error) {
    console.error("[Dashboard/logs] 获取最近消费记录失败:", error);
    res.status(500).json({ error: "获取最近消费记录失败" });
  }
});

/**
 * GET /api/dashboard/total-balance
 * 获取用户总余额（账户余额 + 所有API KEY余额，单位：元）
 */
router.get("/total-balance", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const totalBalance = await getUserTotalBalanceYuan(userId);

    res.json({
      total_balance: totalBalance,
    });
  } catch (error) {
    console.error("[Dashboard/total-balance] 获取总余额失败:", error);
    res.status(500).json({ error: "获取总余额失败" });
  }
});

/**
 * GET /api/dashboard
 * 【兼容旧接口】获取数据大盘所有统计数据（聚合所有子接口）
 * @deprecated 建议使用拆分后的独立接口
 */
router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "未登录" });
    }

    const today = new Date().toISOString().split("T")[0];

    // 并行查询所有统计数据
    const [
      realtimeQps,
      todayStats,
      hourlyTrend,
      modelDistribution,
      recentLogs,
      totalBalance,
      avgDailyConsumption,
    ] = await Promise.all([
      StatsService.getUserRealtimeQps(userId),
      StatsService.getUserDailyOverview(userId, today),
      StatsService.getUserHourlyTrend(userId, today),
      StatsService.getUserModelDistribution(userId, today, 10),
      getRecentLogsFromMySQL(userId),
      getUserTotalBalance(userId),
      getAvgDailyConsumption(userId),
    ]);

    // 计算预估可用天数
    const weeklyAvgConsumption = avgDailyConsumption || 0;
    const estimatedDays =
      totalBalance > 0 && weeklyAvgConsumption > 0
        ? Math.floor(totalBalance / weeklyAvgConsumption)
        : 0;

    res.json({
      realtime_qps: realtimeQps,
      qps_limit: 150,
      estimated_days: estimatedDays > 999 ? 999 : estimatedDays,
      today_tokens: todayStats.totalTokens,
      today_requests: todayStats.requests,
      today_error_rate: todayStats.errorRate,
      today_error_count: todayStats.errorCount,
      trend_24h: hourlyTrend.map((h) => h.requests),
      trend_tokens_24h: hourlyTrend.map((h) => h.totalTokens),
      model_distribution: modelDistribution,
      recent_logs: recentLogs,
    });
  } catch (error) {
    console.error("[Dashboard] 获取数据大盘失败:", error);
    res.status(500).json({ error: "获取数据大盘失败" });
  }
});

// ==================== 辅助函数 ====================

/**
 * 获取用户总余额（单位：元）
 * 直接从 user_users.balance 读取，不再累加 API Key 余额
 */
async function getUserTotalBalanceYuan(userId: number): Promise<number> {
  try {
    const [userResult] = await pool.query(
      `SELECT COALESCE(balance, 0) as balance FROM user_users WHERE id = ?`,
      [userId]
    );
    const balance = ((userResult as any[])[0]?.balance || 0) / 100000;
    console.log(`[Dashboard] 用户${userId}余额: ${balance.toFixed(2)}元`);
    return balance;
  } catch (err) {
    console.error("[Dashboard] 获取用户余额失败:", err);
    return 0;
  }
}

/**
 * 获取今日消耗（单位：元）
 */
async function getTodayConsumptionYuan(userId: number): Promise<number> {
  try {
    const today = new Date().toISOString().split("T")[0];
    const [result] = await pool.query(
      `SELECT COALESCE(SUM(quota_consumed), 0) as today_consumption
       FROM proxy_logs
       WHERE user_id = ? AND DATE(created_at) = ?`,
      [userId, today]
    );
    const todayQuota = (result as any[])[0]?.today_consumption || 0;
    // 额度转换为元
    const todayYuan = todayQuota / 100000;
    console.log(`[Dashboard] 用户${userId}今日消耗: ${todayQuota}额度 = ${todayYuan.toFixed(2)}元`);
    return todayYuan;
  } catch (err) {
    console.error("[Dashboard] 获取今日消耗失败:", err);
    return 0;
  }
}

/**
 * 获取用户余额（单位：元）- 旧函数，保持兼容
 * 账户余额 + 所有API Key余额（额度/100000）
 */
async function getUserTotalBalance(userId: number): Promise<number> {
  return getUserTotalBalanceYuan(userId);
}

/**
 * 获取近7日平均日消耗（元）
 */
async function getAvgDailyConsumption(userId: number): Promise<number> {
  try {
    const [result] = await pool.query(
      `
      SELECT
        AVG(daily_consumption) as avg_consumption
      FROM (
        SELECT
          DATE(created_at) as date,
          COALESCE(SUM(quota_consumed), 0) as daily_consumption
        FROM proxy_logs
        WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY DATE(created_at)
      ) daily_stats
      `,
      [userId]
    );
    const row = (result as any[])[0];
    // 额度转换为元
    return (row?.avg_consumption || 0) / 100000;
  } catch {
    return 0;
  }
}

/**
 * 获取最近调用日志（从 MySQL 明细表）
 */
async function getRecentLogsFromMySQL(
  userId: number,
  limit: number = 10
): Promise<
  Array<{
    id: number;
    time: string;
    apiKey: string;
    model: string;
    status: number;
    latency: number;
    tokens: number;
    costYuan: number;
  }>
> {
  const [result] = await pool.query(
    `
    SELECT
      l.id,
      DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') as time,
      l.token_name as apiKey,
      l.model,
      l.status,
      l.latency_ms as latency,
      (l.prompt_tokens + l.completion_tokens) as tokens,
      l.quota_consumed
    FROM proxy_logs l
    WHERE l.user_id = ?
    ORDER BY l.created_at DESC
    LIMIT ?
    `,
    [userId, limit]
  );

  const rows = result as any[];
  return rows.map((row) => ({
    id: row.id || 0,
    time: row.time || "—",
    apiKey: row.apiKey || "—",
    model: row.model || "—",
    status: row.status === 'success' ? 200 : 500,
    latency: row.latency || 0,
    tokens: row.tokens || 0,
    costYuan: Number(((row.quota_consumed || 0) / 100000).toFixed(4)),
  }));
}

export default router;
