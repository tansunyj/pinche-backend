/**
 * 获取概览数据 - 支持指定日期
 * GET /api/dashboard/overview?date=2026-05-20
 */
router.get('/overview', async (req, res) => {
  try {
    // 支持指定日期，默认今天（东八区）
    let date = req.query.date;
    if (!date) {
      // 获取东八区当前日期
      const now = new Date();
      const cstDate = new Date(now.getTime() + (8 * 60 * 60 * 1000));
      date = cstDate.toISOString().split('T')[0];
    }

    // 1. 获取全局指标
    const [globalRows] = await query(`
      SELECT metric_name, metric_value
      FROM unified_stats
      WHERE stat_date = ?
        AND dim_type = 'global'
        AND dim1_key = 'global'
        AND stat_hour IS NULL
    `, [date]);

    const metrics = {};
    globalRows.forEach(row => {
      metrics[row.metric_name] = row.metric_value;
    });

    // 2. 获取活跃渠道数（只在 proxy_channels 表中存在的渠道中统计）
    const [channelRows] = await query(`
      SELECT COUNT(DISTINCT s.dim1_key) as count
      FROM unified_stats s
      JOIN proxy_channels c ON s.dim1_key = CONCAT('ch:', c.id)
      WHERE s.stat_date = ?
        AND s.dim_type = 'channel'
        AND s.metric_name = 'requests'
        AND s.metric_value > 0
    `, [date]);

    // 3. 获取活跃Token数（只在 proxy_tokens 表中存在的令牌中统计）
    const [tokenRows] = await query(`
      SELECT COUNT(DISTINCT s.dim1_key) as count
      FROM unified_stats s
      JOIN proxy_tokens t ON s.dim1_key = CONCAT('tk:', t.id)
      WHERE s.stat_date = ?
        AND s.dim_type = 'token'
        AND s.metric_name = 'requests'
        AND s.metric_value > 0
    `, [date]);

    // 4. 获取累计消费（全部历史）
    const [totalRows] = await query(`
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
      totalQuotaUsed: quotaToYuan(totalRows[0]?.total_quota || 0),
      activeChannels: channelRows[0]?.count || 0,
      activeTokens: tokenRows[0]?.count || 0,
    });
  } catch (e) {
    console.error('[/dashboard/overview]', e);
    res.status(500).json({ error: '获取概览统计失败' });
  }
});
