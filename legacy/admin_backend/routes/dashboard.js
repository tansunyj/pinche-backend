const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { authMiddleware, verifyToken } = require('../middleware/auth');
const { quotaToYuan } = require('../utils/billing');
const DashboardStatsService = require('../services/DashboardStatsService');

/**
 * 从 unified_stats 表获取今日全局指标
 */
async function getTodayGlobalMetrics() {
  const rows = await query(`
    SELECT
      metric_name,
      metric_value
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'global'
      AND dim1_key = 'global'
      AND stat_hour IS NULL
  `);

  const metrics = {};
  rows.forEach(row => {
    metrics[row.metric_name] = row.metric_value;
  });
  return metrics;
}

/**
 * 从 unified_stats 表获取渠道统计
 */
async function getTodayChannelStats() {
  const rows = await query(`
    SELECT
      dim1_key,
      MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
      MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
      MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
      MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens,
      MAX(CASE WHEN metric_name = 'success' THEN metric_value END) as success,
      MAX(CASE WHEN metric_name = 'error' THEN metric_value END) as error,
      MAX(CASE WHEN metric_name = 'latency_count' THEN metric_value END) as latency_count,
      MAX(CASE WHEN metric_name = 'latency_sum' THEN metric_value END) as latency_sum,
      MAX(CASE WHEN metric_name = 'online' THEN metric_value END) as online,
      MAX(meta_json) as meta_json
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'channel'
      AND stat_hour IS NULL
    GROUP BY dim1_key
    ORDER BY quota DESC
  `);
  return rows;
}

/**
 * 从 unified_stats 表获取模型统计
 */
async function getTodayModelStats() {
  const rows = await query(`
    SELECT
      SUBSTRING(dim1_key FROM 4) as model,
      MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
      MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
      MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
      MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens,
      MAX(CASE WHEN metric_name = 'unique_tokens' THEN metric_value END) as unique_tokens
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'model'
      AND stat_hour IS NULL
    GROUP BY dim1_key
    ORDER BY quota DESC
  `);
  return rows;
}

/**
 * 从 unified_stats 表获取Token统计
 */
async function getTodayTokenStats(limit = 10) {
  const rows = await query(`
    SELECT
      SUBSTRING(dim1_key FROM 4) as token_id,
      MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
      MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
      MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
      MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens,
      MAX(meta_json) as meta_json
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'token'
      AND stat_hour IS NULL
    GROUP BY dim1_key
    ORDER BY quota DESC
    LIMIT ${parseInt(limit) || 10}
  `);
  return rows;
}

/**
 * 获取历史统计数据（用于趋势图）
 */
async function getHistoricalStats(days = 7) {
  const rows = await query(`
    SELECT
      DATE_FORMAT(stat_date, '%Y-%m-%d') as date,
      MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
      MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
      MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
      MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens
    FROM unified_stats
    WHERE dim_type = 'global'
      AND dim1_key = 'global'
      AND stat_hour IS NULL
      AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ${parseInt(days) || 7} DAY)
    GROUP BY DATE_FORMAT(stat_date, '%Y-%m-%d')
    ORDER BY date ASC
  `);
  return rows;
}

/**
 * 获取延迟统计
 */
async function getLatencyStats(days = 7) {
  // 日级别延迟统计
  const dailyRows = await query(`
    SELECT
      DATE_FORMAT(stat_date, '%Y-%m-%d') as date,
      MAX(CASE WHEN metric_name = 'latency_count' THEN metric_value END) as latency_count,
      MAX(CASE WHEN metric_name = 'latency_sum' THEN metric_value END) as latency_sum,
      MAX(CASE WHEN metric_name = 'latency_min' THEN metric_value END) as latency_min,
      MAX(CASE WHEN metric_name = 'latency_max' THEN metric_value END) as latency_max,
      MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests
    FROM unified_stats
    WHERE dim_type = 'global'
      AND dim1_key = 'global'
      AND stat_hour IS NULL
      AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ${parseInt(days) || 7} DAY)
    GROUP BY DATE_FORMAT(stat_date, '%Y-%m-%d')
    ORDER BY date ASC
  `);

  // 整体延迟统计
  const overallRows = await query(`
    SELECT
      ROUND(SUM(CASE WHEN metric_name = 'latency_sum' THEN metric_value ELSE 0 END) /
        NULLIF(SUM(CASE WHEN metric_name = 'latency_count' THEN metric_value ELSE 0 END), 0)) as avg_latency,
      MIN(CASE WHEN metric_name = 'latency_min' THEN metric_value END) as min_latency,
      MAX(CASE WHEN metric_name = 'latency_max' THEN metric_value END) as max_latency,
      SUM(CASE WHEN metric_name = 'requests' THEN metric_value ELSE 0 END) as requests
    FROM unified_stats
    WHERE dim_type = 'global'
      AND dim1_key = 'global'
      AND stat_hour IS NULL
  `);

  // 延迟分布（今日）
  const distributionRows = await query(`
    SELECT
      metric_name,
      metric_value
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'global'
      AND dim1_key = 'global'
      AND metric_name LIKE 'latency_bucket_%'
  `);

  return { daily: dailyRows, overall: overallRows[0], distribution: distributionRows };
}

// ==================== 路由定义 ====================

/**
 * 日志查询接口（管理后台使用，无限制流）
 */
router.get('/logs', async (req, res) => {
  const isAdmin = true;
  const { model, token_name, status, start_date, end_date, username } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

  try {
    const where = [];
    const params = [];
    const needsTokenJoin = token_name || username;
    const needsUserJoin = true; // 始终关联用户表以显示用户名

    if (model) { where.push('l.model = ?'); params.push(model); }
    if (token_name) {
      // 同时匹配令牌名称或 API KEY（模糊查询）
      where.push('(l.token_name LIKE ? OR t.`key` LIKE ?)');
      const likePattern = `%${token_name}%`;
      params.push(likePattern, likePattern);
    }
    if (username) {
      where.push('(u.phone LIKE ? OR u.email LIKE ? OR u.name LIKE ?)');
      const likePattern = `%${username}%`;
      params.push(likePattern, likePattern, likePattern);
    }
    if (status) { where.push('l.status = ?'); params.push(status); }
    if (start_date) { where.push('l.created_at >= ?'); params.push(start_date); }
    if (end_date) { where.push('l.created_at <= ?'); params.push(end_date); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const fromTable = 'proxy_logs l LEFT JOIN proxy_tokens t ON l.token_id = t.id LEFT JOIN user_users u ON t.user_id = u.id';

    const totalRows = await query(`SELECT COUNT(*) as count FROM ${fromTable} ${whereClause}`, params);
    const total = totalRows[0].count;

    const limitVal = pageSize;
    const offsetVal = (page - 1) * pageSize;
    const selectFields = 'l.*, l.quota_consumed as quota_yuan, DATE_FORMAT(l.created_at, "%Y-%m-%d %H:%i:%s") as created_at, COALESCE(u.phone, u.email, u.name) as user_username';
    const logs = await query(
      `SELECT ${selectFields}
       FROM ${fromTable} ${whereClause} ORDER BY l.id DESC LIMIT ${limitVal} OFFSET ${offsetVal}`,
      params
    );

    const summaryRows = await query(
      `SELECT
         COALESCE(SUM(l.quota_consumed), 0) as total_quota,
         COALESCE(SUM(l.prompt_tokens), 0) as total_prompt,
         COALESCE(SUM(l.completion_tokens), 0) as total_completion,
         COUNT(*) as total_requests
       FROM ${fromTable} ${whereClause}`,
      params
    );
    const summary = summaryRows[0];

    res.json({
      logs: logs.map((l) => ({
        ...l,
        quota_yuan: quotaToYuan(l.quota_consumed),
        latency: l.latency_ms,
        channel_name: l.channel_name || '-',
        price_markup: l.price_markup || 1.0,
      })),
      total,
      page,
      pageSize,
      summary: {
        totalCost: quotaToYuan(summary.total_quota),
        totalPrompt: summary.total_prompt,
        totalCompletion: summary.total_completion,
        totalRequests: summary.total_requests,
      },
      isAdmin,
    });
  } catch (e) {
    console.error('[/dashboard/logs]', e);
    res.status(500).json({ error: '获取日志列表失败' });
  }
});

// ==================== 以下接口都需要管理员登录 ====================
router.use(authMiddleware);

/**
 * 详细请求/响应日志（保持原逻辑）
 */
router.get('/request-detail', async (req, res) => {
  try {
    const { request_id, log_id, id } = req.query;
    let resolvedReqId = request_id;

    if (!resolvedReqId && log_id) {
      const r = await query('SELECT request_id FROM proxy_logs WHERE id = ?', [log_id]);
      resolvedReqId = r[0]?.request_id;
      if (!resolvedReqId) {
        return res.status(404).json({ error: '该 proxy_logs 行未关联 request_id（可能是改造前的旧数据）' });
      }
    }

    let detailRows;
    if (id) {
      detailRows = await query(
        `SELECT *,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_fmt,
                DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at_fmt
           FROM proxy_request_logs WHERE id = ?`,
        [id]
      );
    } else if (resolvedReqId) {
      detailRows = await query(
        `SELECT *,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_fmt,
                DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at_fmt
           FROM proxy_request_logs WHERE request_id = ?
           ORDER BY id DESC LIMIT 1`,
        [resolvedReqId]
      );
    } else {
      return res.status(400).json({ error: '请提供 request_id / log_id / id 之一' });
    }

    if (!detailRows || detailRows.length === 0) {
      return res.status(404).json({ error: '未找到详细请求日志（可能未采样或已过期）' });
    }
    res.json({ success: true, data: detailRows[0] });
  } catch (e) {
    console.error('[/request-detail]', e);
    res.status(500).json({ error: '查询失败' });
  }
});

/**
 * 从 unified_stats 获取今日活跃渠道数（有请求的）
 */
async function getTodayActiveChannels() {
  const rows = await query(`
    SELECT COUNT(DISTINCT dim1_key) as count
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'channel'
      AND metric_name = 'requests'
      AND metric_value > 0
  `);
  return rows[0]?.count || 0;
}

/**
 * 从 unified_stats 获取今日活跃Token数（有请求的）
 */
async function getTodayActiveTokens() {
  const rows = await query(`
    SELECT COUNT(DISTINCT dim1_key) as count
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'token'
      AND metric_name = 'requests'
      AND metric_value > 0
  `);
  return rows[0]?.count || 0;
}

/**
 * 从 unified_stats 获取今日渠道总数（无论是否有请求）
 */
async function getTodayTotalChannels() {
  const rows = await query(`
    SELECT COUNT(DISTINCT dim1_key) as count
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'channel'
  `);
  return rows[0]?.count || 0;
}

/**
 * 从 unified_stats 获取今日Token总数（无论是否有请求）
 */
async function getTodayTotalTokens() {
  const rows = await query(`
    SELECT COUNT(DISTINCT dim1_key) as count
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'token'
  `);
  return rows[0]?.count || 0;
}

/**
 * 获取概览 - 从 unified_stats 表查询
 * 支持 ?date=2026-05-20 参数，默认查最新有数据的日期
 */
router.get('/overview', async (req, res) => {
  try {
    let date = req.query.date;

    // 如果没有指定日期，查最新的有数据的日期
    if (!date) {
      const [latestRow] = await query(`
        SELECT DATE_FORMAT(stat_date, '%Y-%m-%d') as date_str
        FROM unified_stats
        GROUP BY stat_date
        ORDER BY stat_date DESC
        LIMIT 1
      `);
      if (latestRow) {
        date = latestRow.date_str;
      } else {
        // 获取东八区当前日期
        const now = new Date();
        const cstDate = new Date(now.getTime() + (8 * 60 * 60 * 1000));
        date = cstDate.toISOString().split('T')[0];
      }
    }

    // 从 unified_stats 获取指定日期的全局指标
    const globalRows = await query(`
      SELECT metric_name, metric_value
      FROM unified_stats
      WHERE stat_date = ?
        AND dim_type = 'global'
        AND dim1_key = 'global'
        AND stat_hour IS NULL
    `, [date]);

    const metrics = {};
    (globalRows || []).forEach(row => {
      metrics[row.metric_name] = row.metric_value;
    });

    // 从 unified_stats 获取活跃渠道数（只在 proxy_channels 表中存在的渠道中统计）
    const channelRows = await query(`
      SELECT COUNT(DISTINCT s.dim1_key) as count
      FROM unified_stats s
      JOIN proxy_channels c ON s.dim1_key = CONCAT('ch:', c.id)
      WHERE s.stat_date = ?
        AND s.dim_type = 'channel'
        AND s.metric_name = 'requests'
        AND s.metric_value > 0
    `, [date]);

    // 从 unified_stats 获取活跃Token数（只在 proxy_tokens 表中存在的令牌中统计）
    const tokenRows = await query(`
      SELECT COUNT(DISTINCT s.dim1_key) as count
      FROM unified_stats s
      JOIN proxy_tokens t ON s.dim1_key = CONCAT('tk:', t.id)
      WHERE s.stat_date = ?
        AND s.dim_type = 'token'
        AND s.metric_name = 'requests'
        AND s.metric_value > 0
    `, [date]);

    // 获取累计消费（全部历史）
    const totalQuotaRows = await query(`
      SELECT SUM(metric_value) as total_quota
      FROM unified_stats
      WHERE dim_type = 'global'
        AND dim1_key = 'global'
        AND metric_name = 'quota'
        AND stat_hour IS NULL
    `);

    res.json({
      date: date,
      todayQuota: quotaToYuan(metrics.quota || 0),
      todayLogs: Math.round(metrics.requests || 0),
      todayPromptTokens: Math.round(metrics.prompt_tokens || 0),
      todayCompletionTokens: Math.round(metrics.completion_tokens || 0),
      totalQuotaUsed: quotaToYuan(totalQuotaRows[0]?.total_quota || 0),
      activeChannels: channelRows[0]?.count || 0,
      activeTokens: tokenRows[0]?.count || 0,
    });
  } catch (e) {
    console.error('[/dashboard/overview]', e);
    res.status(500).json({ error: '获取概览统计失败' });
  }
});

/**
 * 获取趋势图表（日级别）- 从 unified_stats 表查询
 */
router.get('/chart/daily', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    const rows = await getHistoricalStats(days);

    const result = [];
    for (const row of rows) {
      const dateStr = row.date;
      const cost = parseFloat(quotaToYuan(row.quota || 0));
      result.push({ date: dateStr, cost, type: '消费(¥)' });
      result.push({ date: dateStr, cost: row.prompt_tokens || 0, type: '输入Token' });
      result.push({ date: dateStr, cost: row.completion_tokens || 0, type: '输出Token' });
    }
    res.json(result);
  } catch (e) {
    console.error('[/dashboard/chart/daily]', e);
    res.status(500).json({ error: '获取趋势图表失败' });
  }
});

/**
 * 获取模型统计排行 - 从 unified_stats 表查询
 */
router.get('/chart/models', async (req, res) => {
  try {
    const rows = await getTodayModelStats();

    const result = rows.map(r => ({
      model: r.model,
      cost: parseFloat(quotaToYuan(r.quota || 0)),
      prompt_tokens: Math.round(r.prompt_tokens || 0),
      completion_tokens: Math.round(r.completion_tokens || 0),
      requests: Math.round(r.requests || 0),
    }));
    res.json(result);
  } catch (e) {
    console.error('[/dashboard/chart/models]', e);
    res.status(500).json({ error: '获取模型统计失败' });
  }
});

/**
 * 获取渠道统计排行 - 从 unified_stats 表查询
 */
router.get('/chart/channels', async (req, res) => {
  try {
    const rows = await getTodayChannelStats();

    const result = rows.map(r => {
      let meta = {};
      try {
        meta = JSON.parse(r.meta_json || '{}');
      } catch (e) {}

      const latencyCount = r.latency_count || 1;
      const latencySum = r.latency_sum || 0;

      return {
        channel_id: parseInt(r.dim1_key.replace('ch:', '')),
        channel_name: meta.channel_name || `渠道${r.dim1_key}`,
        channel_type: meta.channel_type || '',
        requests: Math.round(r.requests || 0),
        cost: parseFloat(quotaToYuan(r.quota || 0)),
        prompt_tokens: Math.round(r.prompt_tokens || 0),
        completion_tokens: Math.round(r.completion_tokens || 0),
        latency_avg_ms: Math.round(latencySum / latencyCount),
        online: r.online === 1,
      };
    });
    res.json(result);
  } catch (e) {
    console.error('[/dashboard/chart/channels]', e);
    res.status(500).json({ error: '获取渠道统计失败' });
  }
});

/**
 * 获取Token统计排行 - 从 unified_stats 表查询
 */
router.get('/chart/tokens', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const rows = await getTodayTokenStats(limit);

    const result = rows.map(r => {
      let meta = {};
      try {
        meta = JSON.parse(r.meta_json || '{}');
      } catch (e) {}

      return {
        token_id: parseInt(r.token_id) || 0,
        token_name: meta.token_name || `Token${r.token_id}`,
        user_id: meta.user_id || 0,
        requests: Math.round(r.requests || 0),
        cost: parseFloat(quotaToYuan(r.quota || 0)),
        prompt_tokens: Math.round(r.prompt_tokens || 0),
        completion_tokens: Math.round(r.completion_tokens || 0),
      };
    });
    res.json(result);
  } catch (e) {
    console.error('[/dashboard/chart/tokens]', e);
    res.status(500).json({ error: '获取Token统计失败' });
  }
});

/**
 * 从 proxy_logs 表计算今日延迟分布
 */
async function getLatencyDistributionFromLogs() {
  const rows = await query(`
    SELECT
      SUM(CASE WHEN latency_ms BETWEEN 0 AND 100 THEN 1 ELSE 0 END) as bucket_0_100,
      SUM(CASE WHEN latency_ms BETWEEN 100 AND 300 THEN 1 ELSE 0 END) as bucket_100_300,
      SUM(CASE WHEN latency_ms BETWEEN 300 AND 500 THEN 1 ELSE 0 END) as bucket_300_500,
      SUM(CASE WHEN latency_ms BETWEEN 500 AND 1000 THEN 1 ELSE 0 END) as bucket_500_1000,
      SUM(CASE WHEN latency_ms BETWEEN 1000 AND 2000 THEN 1 ELSE 0 END) as bucket_1000_2000,
      SUM(CASE WHEN latency_ms BETWEEN 2000 AND 5000 THEN 1 ELSE 0 END) as bucket_2000_5000,
      SUM(CASE WHEN latency_ms > 5000 THEN 1 ELSE 0 END) as bucket_5000_plus
    FROM proxy_logs
    WHERE latency_ms > 0
      AND created_at >= CURDATE()
      AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
  `);

  const row = rows[0] || {};
  return {
    '0-100ms': Math.round(row.bucket_0_100 || 0),
    '100-300ms': Math.round(row.bucket_100_300 || 0),
    '300-500ms': Math.round(row.bucket_300_500 || 0),
    '500-1000ms': Math.round(row.bucket_500_1000 || 0),
    '1000-2000ms': Math.round(row.bucket_1000_2000 || 0),
    '2000-5000ms': Math.round(row.bucket_2000_5000 || 0),
    '5000ms+': Math.round(row.bucket_5000_plus || 0),
  };
}

/**
 * 从 proxy_logs 表计算今日整体延迟统计
 */
async function getOverallLatencyFromLogs() {
  const rows = await query(`
    SELECT
      COUNT(*) as requests,
      AVG(latency_ms) as avg_latency,
      MIN(latency_ms) as min_latency,
      MAX(latency_ms) as max_latency
    FROM proxy_logs
    WHERE latency_ms > 0
      AND created_at >= CURDATE()
      AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
  `);

  const row = rows[0] || {};
  return {
    avg_latency: Math.round(row.avg_latency || 0),
    min_latency: Math.round(row.min_latency || 0),
    max_latency: Math.round(row.max_latency || 0),
    requests: Math.round(row.requests || 0),
  };
}

/**
 * 从 proxy_logs 表计算历史每日延迟趋势
 */
async function getDailyLatencyFromLogs(days = 7) {
  const rows = await query(`
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d') as date,
      COUNT(*) as requests,
      AVG(latency_ms) as avg_latency
    FROM proxy_logs
    WHERE latency_ms > 0
      AND created_at >= DATE_SUB(CURDATE(), INTERVAL ${parseInt(days)} DAY)
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date ASC
  `);

  return rows.map(row => ({
    date: row.date,
    avg_latency: Math.round(row.avg_latency || 0),
    requests: Math.round(row.requests || 0),
  }));
}

/**
 * 获取延迟统计 - 优先从 Redis 查询，Redis 无数据则查 proxy_logs 实时计算
 */
router.get('/latency', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    const today = new Date().toISOString().split('T')[0];

    // ========== 1. 获取延迟分布（优先 Redis，否则查 proxy_logs） ==========
    let distributionMap;
    try {
      distributionMap = await DashboardStatsService.getLatencyDistribution(today);
      // 检查是否有有效数据
      const hasData = Object.values(distributionMap).some(v => v > 0);
      if (!hasData) {
        throw new Error('Redis 无延迟分布数据');
      }
    } catch (redisErr) {
      // Redis 无数据，从 proxy_logs 实时计算
      console.log('[/dashboard/latency] Redis 无分布数据，从 proxy_logs 计算');
      distributionMap = await getLatencyDistributionFromLogs();
    }

    // ========== 2. 获取整体延迟统计（优先 Redis，否则查 proxy_logs） ==========
    let overall;
    try {
      const todayOverview = await DashboardStatsService.getDailyOverview(today);
      if (todayOverview?.summary?.requests > 0) {
        overall = {
          avg_latency: todayOverview.latency?.avgMs || 0,
          min_latency: todayOverview.latency?.minMs || 0,
          max_latency: todayOverview.latency?.maxMs || 0,
          requests: todayOverview.summary.requests,
        };
      } else {
        throw new Error('Redis 无今日概览数据');
      }
    } catch (redisErr) {
      // Redis 无数据，从 proxy_logs 实时计算
      console.log('[/dashboard/latency] Redis 无概览数据，从 proxy_logs 计算');
      overall = await getOverallLatencyFromLogs();
    }

    // ========== 3. 获取历史每日延迟趋势（优先 Redis，否则查 proxy_logs） ==========
    let dailyResult = [];
    try {
      // 尝试从 Redis 获取多日数据
      const dateList = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dateList.push(d.toISOString().split('T')[0]);
      }

      const dailyPromises = dateList.map(async (date) => {
        try {
          const overview = await DashboardStatsService.getDailyOverview(date);
          if (overview?.summary?.requests > 0) {
            return {
              date,
              avg_latency: overview.latency?.avgMs || 0,
              requests: overview.summary.requests,
            };
          }
          return null;
        } catch (err) {
          return null;
        }
      });

      const dailyResults = await Promise.all(dailyPromises);
      const validDailyResults = dailyResults.filter(r => r !== null);

      // 如果 Redis 数据足够，直接使用
      if (validDailyResults.length >= Math.min(days, 3)) {
        dailyResult = validDailyResults;
      } else {
        throw new Error('Redis 历史数据不足');
      }
    } catch (redisErr) {
      // Redis 数据不足，从 proxy_logs 实时计算
      console.log('[/dashboard/latency] Redis 历史数据不足，从 proxy_logs 计算');
      dailyResult = await getDailyLatencyFromLogs(days);
    }

    // 按日期排序
    dailyResult.sort((a, b) => a.date.localeCompare(b.date));

    // ========== 4. 获取近期延迟记录（从 proxy_logs，最近12小时） ==========
    let recent = [];
    try {
      recent = await query(`
        SELECT token_name, model, latency_ms, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') as created_at
        FROM proxy_logs
        WHERE latency_ms > 0
          AND created_at >= DATE_SUB(NOW(), INTERVAL 12 HOUR)
        ORDER BY id DESC
        LIMIT 5
      `);
    } catch (recentErr) {
      console.error('[/dashboard/latency] 获取近期延迟记录失败:', recentErr.message);
      recent = [];
    }

    res.json({
      overall,
      daily: dailyResult,
      distribution: distributionMap,
      recent: recent || [],
    });
  } catch (e) {
    console.error('[/dashboard/latency]', e);
    res.status(500).json({ error: '获取延迟统计失败' });
  }
});

/**
 * 手动触发 Redis 统计同步
 * 默认同步今天的数据，可通过 date 参数指定日期
 */
router.post('/metrics/sync', authMiddleware, async (req, res) => {
  try {
    const { runStatsSync, runTodaySync } = require('../cron/syncStats');
    const { date } = req.body;

    let result;
    if (date) {
      // 同步指定日期
      result = await runStatsSync(date);
    } else {
      // 同步今天
      result = await runTodaySync();
    }

    if (result.success) {
      res.json({
        code: 0,
        message: `统计同步成功，日期: ${result.date}`,
        data: result
      });
    } else {
      res.status(500).json({
        code: 500,
        error: '同步失败',
        message: result.error
      });
    }
  } catch (e) {
    console.error('[/dashboard/metrics/sync]', e);
    res.status(500).json({ error: '触发同步失败: ' + e.message });
  }
});

/**
 * 获取指标定义列表（从 metric_definitions 表）
 */
router.get('/metrics/definitions', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM metric_definitions ORDER BY id');
    res.json({
      code: 0,
      data: rows,
    });
  } catch (e) {
    console.error('[/dashboard/metrics/definitions]', e);
    res.status(500).json({ error: '获取指标定义失败' });
  }
});

/**
 * 获取指定指标的历史数据
 */
router.get('/metrics/history', async (req, res) => {
  const { metric, dim_type, dim_key, days = 7 } = req.query;

  if (!metric) {
    return res.status(400).json({ error: '请提供 metric 参数' });
  }

  try {
    const dKey = dim_key || (dim_type === 'global' ? 'global' : '%');
    const numDays = parseInt(days) || 7;
    const sql = `
      SELECT
        stat_date as date,
        stat_hour as hour,
        dim_type,
        dim1_key,
        metric_value
      FROM unified_stats
      WHERE metric_name = ?
        AND dim_type = ?
        AND dim1_key ${dim_key ? '= ?' : 'LIKE ?'}
        AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ${numDays} DAY)
      ORDER BY stat_date DESC, stat_hour DESC
    `;
    const params = dim_key ? [metric, dim_type, dKey] : [metric, dim_type, dKey];
    const rows = await query(sql, params);

    res.json({
      code: 0,
      data: rows,
    });
  } catch (e) {
    console.error('[/dashboard/metrics/history]', e);
    res.status(500).json({ error: '获取指标历史数据失败' });
  }
});

module.exports = router;
