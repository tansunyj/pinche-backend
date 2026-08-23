const redis = require('../db/redis');
const mysql = require('../db/init');

/**
 * Dashboard 统计查询服务
 * 优先从 Redis 查询，未命中则从 MySQL 查询并回填
 */
class DashboardStatsService {
  constructor() {
    this.CACHE_TTL = 30 * 24 * 3600;
  }

  /**
   * 格式化日期 YYYY-MM-DD
   */
  formatDate(date = new Date()) {
    return date.toISOString().split('T')[0];
  }

  /**
   * 获取今日全局概览
   */
  async getDailyOverview(date = this.formatDate()) {
    // 1. 尝试从 Redis 获取
    let stats = await this.getDailyOverviewFromRedis(date);

    if (stats) {
      console.log(`[DashboardStats] Redis hit: dailyOverview ${date}`);
      return stats;
    }

    // 2. Redis 未命中，从 MySQL 查询
    console.log(`[DashboardStats] Redis miss, querying MySQL: dailyOverview ${date}`);
    stats = await this.getDailyOverviewFromMySQL(date);

    // 3. 回填 Redis（异步）
    if (stats) {
      this.backfillDailyOverviewToRedis(date, stats).catch(console.error);
    }

    return stats;
  }

  async getDailyOverviewFromRedis(date) {
    const key = `stats:global:${date}`;
    const data = await redis.hgetall(key);

    if (!data || !data.requests) {
      return null;
    }

    const latencyCount = parseInt(data.latency_count) || 1;
    const latencySum = parseInt(data.latency_sum) || 0;

    return {
      date,
      summary: {
        requests: parseInt(data.requests) || 0,
        promptTokens: parseInt(data.prompt_tokens) || 0,
        completionTokens: parseInt(data.completion_tokens) || 0,
        totalTokens: parseInt(data.total_tokens) || 0,
        quota: parseInt(data.quota) || 0,
        costYuan: ((parseInt(data.quota) || 0) / 100000).toFixed(2),
        successCount: parseInt(data.success) || 0,
        errorCount: parseInt(data.error) || 0,
        successRate: this.calculateSuccessRate(data.success, data.error)
      },
      latency: {
        avgMs: latencyCount ? Math.round(latencySum / latencyCount) : 0,
        minMs: parseInt(data.latency_min) || 0,
        maxMs: parseInt(data.latency_max) || 0
      },
      active: {
        uniqueUsers: await redis.pfcount(`stats:dau:${date}`),
        uniqueTokens: await redis.pfcount(`stats:tau:${date}`),
        uniqueChannels: await redis.pfcount(`stats:cau:${date}`)
      }
    };
  }

  async getDailyOverviewFromMySQL(date) {
    const [rows] = await mysql.query(`
      SELECT
        MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
        MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
        MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens,
        MAX(CASE WHEN metric_name = 'total_tokens' THEN metric_value END) as total_tokens,
        MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
        MAX(CASE WHEN metric_name = 'success' THEN metric_value END) as success,
        MAX(CASE WHEN metric_name = 'error' THEN metric_value END) as error,
        MAX(CASE WHEN metric_name = 'latency_count' THEN metric_value END) as latency_count,
        MAX(CASE WHEN metric_name = 'latency_sum' THEN metric_value END) as latency_sum,
        MAX(CASE WHEN metric_name = 'latency_min' THEN metric_value END) as latency_min,
        MAX(CASE WHEN metric_name = 'latency_max' THEN metric_value END) as latency_max,
        MAX(CASE WHEN metric_name = 'unique_users' THEN metric_value END) as unique_users,
        MAX(CASE WHEN metric_name = 'unique_tokens' THEN metric_value END) as unique_tokens,
        MAX(CASE WHEN metric_name = 'unique_channels' THEN metric_value END) as unique_channels
      FROM unified_stats
      WHERE stat_date = ? AND dim_type = 'global' AND dim1_key = 'global'
    `, [date]);

    if (!rows || !rows.requests) {
      return null;
    }

    const latencyCount = parseInt(rows.latency_count) || 1;
    const latencySum = parseInt(rows.latency_sum) || 0;

    return {
      date,
      summary: {
        requests: parseInt(rows.requests) || 0,
        promptTokens: parseInt(rows.prompt_tokens) || 0,
        completionTokens: parseInt(rows.completion_tokens) || 0,
        totalTokens: parseInt(rows.total_tokens) || 0,
        quota: parseInt(rows.quota) || 0,
        costYuan: ((parseInt(rows.quota) || 0) / 100000).toFixed(2),
        successCount: parseInt(rows.success) || 0,
        errorCount: parseInt(rows.error) || 0,
        successRate: this.calculateSuccessRate(rows.success, rows.error)
      },
      latency: {
        avgMs: latencyCount ? Math.round(latencySum / latencyCount) : 0,
        minMs: parseInt(rows.latency_min) || 0,
        maxMs: parseInt(rows.latency_max) || 0
      },
      active: {
        uniqueUsers: parseInt(rows.unique_users) || 0,
        uniqueTokens: parseInt(rows.unique_tokens) || 0,
        uniqueChannels: parseInt(rows.unique_channels) || 0
      }
    };
  }

  async backfillDailyOverviewToRedis(date, stats) {
    const key = `stats:global:${date}`;
    const pipeline = redis.pipeline();

    pipeline.hset(key, 'requests', stats.summary.requests);
    pipeline.hset(key, 'prompt_tokens', stats.summary.promptTokens);
    pipeline.hset(key, 'completion_tokens', stats.summary.completionTokens);
    pipeline.hset(key, 'total_tokens', stats.summary.totalTokens);
    pipeline.hset(key, 'quota', stats.summary.quota);
    pipeline.hset(key, 'success', stats.summary.successCount);
    pipeline.hset(key, 'error', stats.summary.errorCount);
    pipeline.hset(key, 'latency_min', stats.latency.minMs);
    pipeline.hset(key, 'latency_max', stats.latency.maxMs);
    pipeline.expire(key, this.CACHE_TTL);

    await pipeline.exec();
  }

  /**
   * 获取渠道统计列表
   */
  async getChannelStats(date = this.formatDate()) {
    // 1. 尝试 Redis
    let channels = await this.getChannelStatsFromRedis(date);

    if (channels && channels.length > 0) {
      console.log(`[DashboardStats] Redis hit: channels ${date}, count=${channels.length}`);
      return channels;
    }

    // 2. MySQL 查询
    console.log(`[DashboardStats] Redis miss, querying MySQL: channels ${date}`);
    channels = await this.getChannelStatsFromMySQL(date);

    // 3. 回填
    if (channels.length > 0) {
      this.backfillChannelStatsToRedis(date, channels).catch(console.error);
    }

    return channels;
  }

  async getChannelStatsFromRedis(date) {
    const keys = await redis.keys(`stats:channel:*:${date}`);
    if (keys.length === 0) return null;

    const channels = [];

    for (const key of keys) {
      const channelId = key.split(':')[2];
      const data = await redis.hgetall(key);

      if (!data.requests) continue;

      const latencyCount = parseInt(data.latency_count) || 1;
      const uniqueTokens = await redis.pfcount(`stats:channel:${channelId}:tau:${date}`);

      channels.push({
        channelId: parseInt(channelId),
        channelName: data.channel_name || `渠道${channelId}`,
        channelType: data.channel_type || '',
        requests: parseInt(data.requests) || 0,
        quota: parseInt(data.quota) || 0,
        costYuan: ((parseInt(data.quota) || 0) / 100000).toFixed(2),
        promptTokens: parseInt(data.prompt_tokens) || 0,
        completionTokens: parseInt(data.completion_tokens) || 0,
        latencyAvgMs: Math.round((parseInt(data.latency_sum) || 0) / latencyCount),
        uniqueTokens,
        online: parseInt(data.online) || 1
      });
    }

    return channels.sort((a, b) => b.quota - a.quota);
  }

  async getChannelStatsFromMySQL(date) {
    const [rows] = await mysql.query(`
      SELECT
        dim1_key,
        MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
        MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
        MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
        MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens,
        MAX(CASE WHEN metric_name = 'latency_count' THEN metric_value END) as latency_count,
        MAX(CASE WHEN metric_name = 'latency_sum' THEN metric_value END) as latency_sum,
        MAX(CASE WHEN metric_name = 'online' THEN metric_value END) as online,
        MAX(CASE WHEN metric_name = 'unique_tokens' THEN metric_value END) as unique_tokens,
        meta_json
      FROM unified_stats
      WHERE stat_date = ? AND dim_type = 'channel'
      GROUP BY dim1_key
    `, [date]);

    return rows.map(row => {
      const channelId = parseInt(row.dim1_key.replace('ch:', ''));
      const latencyCount = parseInt(row.latency_count) || 1;
      let meta = {};
      try {
        meta = JSON.parse(row.meta_json || '{}');
      } catch (e) {}

      return {
        channelId,
        channelName: meta.channel_name || `渠道${channelId}`,
        channelType: meta.channel_type || '',
        requests: parseInt(row.requests) || 0,
        quota: parseInt(row.quota) || 0,
        costYuan: ((parseInt(row.quota) || 0) / 100000).toFixed(2),
        promptTokens: parseInt(row.prompt_tokens) || 0,
        completionTokens: parseInt(row.completion_tokens) || 0,
        latencyAvgMs: Math.round((parseInt(row.latency_sum) || 0) / latencyCount),
        uniqueTokens: parseInt(row.unique_tokens) || 0,
        online: parseInt(row.online) || 1
      };
    }).sort((a, b) => b.quota - a.quota);
  }

  async backfillChannelStatsToRedis(date, channels) {
    for (const ch of channels) {
      const key = `stats:channel:${ch.channelId}:${date}`;
      const pipeline = redis.pipeline();

      pipeline.hset(key, 'requests', ch.requests);
      pipeline.hset(key, 'quota', ch.quota);
      pipeline.hset(key, 'prompt_tokens', ch.promptTokens);
      pipeline.hset(key, 'completion_tokens', ch.completionTokens);
      pipeline.hset(key, 'channel_name', ch.channelName);
      pipeline.hset(key, 'channel_type', ch.channelType);
      pipeline.hset(key, 'online', ch.online);
      pipeline.expire(key, this.CACHE_TTL);

      await pipeline.exec();
    }
  }

  /**
   * 获取 Token 统计排行
   */
  async getTokenStats(date = this.formatDate(), limit = 10) {
    // 1. 尝试 Redis 排行
    let tokens = await this.getTokenStatsFromRedis(date, limit);

    if (tokens && tokens.length > 0) {
      console.log(`[DashboardStats] Redis hit: tokens ${date}, count=${tokens.length}`);
      return tokens;
    }

    // 2. MySQL 查询
    console.log(`[DashboardStats] Redis miss, querying MySQL: tokens ${date}`);
    tokens = await this.getTokenStatsFromMySQL(date, limit);

    return tokens;
  }

  async getTokenStatsFromRedis(date, limit) {
    const ranking = await redis.zrevrange(`stats:rank:token:quota:${date}`, 0, limit - 1, 'WITHSCORES');

    if (ranking.length === 0) return null;

    const tokens = [];

    for (let i = 0; i < ranking.length; i += 2) {
      const tokenKey = ranking[i];
      const tokenId = parseInt(tokenKey.split(':')[1]);
      const quota = parseInt(ranking[i + 1]);
      const data = await redis.hgetall(`stats:token:${tokenId}:${date}`);

      tokens.push({
        tokenId,
        tokenName: data.token_name || `Token${tokenId}`,
        userId: parseInt(data.user_id) || 0,
        quota,
        costYuan: (quota / 100000).toFixed(2),
        requests: parseInt(data.requests) || 0,
        promptTokens: parseInt(data.prompt_tokens) || 0,
        completionTokens: parseInt(data.completion_tokens) || 0
      });
    }

    return tokens;
  }

  async getTokenStatsFromMySQL(date, limit) {
    const [rows] = await mysql.query(`
      SELECT
        dim1_key,
        MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
        MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
        MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
        MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens,
        meta_json
      FROM unified_stats
      WHERE stat_date = ? AND dim_type = 'token'
      GROUP BY dim1_key
      ORDER BY quota DESC
      LIMIT ?
    `, [date, limit]);

    return rows.map(row => {
      const tokenId = parseInt(row.dim1_key.replace('tk:', ''));
      let meta = {};
      try {
        meta = JSON.parse(row.meta_json || '{}');
      } catch (e) {}

      return {
        tokenId,
        tokenName: meta.token_name || `Token${tokenId}`,
        userId: meta.user_id || 0,
        quota: parseInt(row.quota) || 0,
        costYuan: ((parseInt(row.quota) || 0) / 100000).toFixed(2),
        requests: parseInt(row.requests) || 0,
        promptTokens: parseInt(row.prompt_tokens) || 0,
        completionTokens: parseInt(row.completion_tokens) || 0
      };
    });
  }

  /**
   * 获取模型统计排行
   */
  async getModelStats(date = this.formatDate(), limit = 10) {
    // 1. 尝试 Redis
    let models = await this.getModelStatsFromRedis(date, limit);

    if (models && models.length > 0) {
      console.log(`[DashboardStats] Redis hit: models ${date}, count=${models.length}`);
      return models;
    }

    // 2. MySQL 查询
    console.log(`[DashboardStats] Redis miss, querying MySQL: models ${date}`);
    models = await this.getModelStatsFromMySQL(date, limit);

    return models;
  }

  async getModelStatsFromRedis(date, limit) {
    const ranking = await redis.zrevrange(`stats:rank:model:quota:${date}`, 0, limit - 1, 'WITHSCORES');

    if (ranking.length === 0) return null;

    const models = [];

    for (let i = 0; i < ranking.length; i += 2) {
      const model = ranking[i];
      const quota = parseInt(ranking[i + 1]);
      const data = await redis.hgetall(`stats:model:${model}:${date}`);
      const latencyCount = parseInt(data.latency_count) || 1;
      const uniqueTokens = await redis.pfcount(`stats:model:${model}:tau:${date}`);

      models.push({
        model,
        quota,
        costYuan: (quota / 100000).toFixed(2),
        requests: parseInt(data.requests) || 0,
        promptTokens: parseInt(data.prompt_tokens) || 0,
        completionTokens: parseInt(data.completion_tokens) || 0,
        latencyAvgMs: Math.round((parseInt(data.latency_sum) || 0) / latencyCount),
        uniqueTokens
      });
    }

    return models;
  }

  async getModelStatsFromMySQL(date, limit) {
    const [rows] = await mysql.query(`
      SELECT
        dim1_key,
        MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
        MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
        MAX(CASE WHEN metric_name = 'prompt_tokens' THEN metric_value END) as prompt_tokens,
        MAX(CASE WHEN metric_name = 'completion_tokens' THEN metric_value END) as completion_tokens,
        MAX(CASE WHEN metric_name = 'latency_count' THEN metric_value END) as latency_count,
        MAX(CASE WHEN metric_name = 'latency_sum' THEN metric_value END) as latency_sum,
        MAX(CASE WHEN metric_name = 'unique_tokens' THEN metric_value END) as unique_tokens
      FROM unified_stats
      WHERE stat_date = ? AND dim_type = 'model'
      GROUP BY dim1_key
      ORDER BY quota DESC
      LIMIT ?
    `, [date, limit]);

    return rows.map(row => {
      const model = row.dim1_key.replace('md:', '');
      const latencyCount = parseInt(row.latency_count) || 1;

      return {
        model,
        quota: parseInt(row.quota) || 0,
        costYuan: ((parseInt(row.quota) || 0) / 100000).toFixed(2),
        requests: parseInt(row.requests) || 0,
        promptTokens: parseInt(row.prompt_tokens) || 0,
        completionTokens: parseInt(row.completion_tokens) || 0,
        latencyAvgMs: Math.round((parseInt(row.latency_sum) || 0) / latencyCount),
        uniqueTokens: parseInt(row.unique_tokens) || 0
      };
    });
  }

  /**
   * 获取小时趋势
   */
  async getHourlyTrend(date = this.formatDate()) {
    // 1. 尝试 Redis
    let trend = await this.getHourlyTrendFromRedis(date);

    if (trend && trend.length > 0) {
      console.log(`[DashboardStats] Redis hit: hourlyTrend ${date}`);
      return trend;
    }

    // 2. MySQL 查询
    console.log(`[DashboardStats] Redis miss, querying MySQL: hourlyTrend ${date}`);
    trend = await this.getHourlyTrendFromMySQL(date);

    return trend;
  }

  async getHourlyTrendFromRedis(date) {
    const results = [];
    let hasData = false;

    for (let hour = 0; hour < 24; hour++) {
      const key = `stats:hourly:${date}:${hour}`;
      const data = await redis.hgetall(key);

      if (data && data.requests) {
        hasData = true;
        const latencyCount = parseInt(data.latency_count) || 1;
        results.push({
          hour,
          requests: parseInt(data.requests) || 0,
          quota: parseInt(data.quota) || 0,
          latencyAvgMs: Math.round((parseInt(data.latency_sum) || 0) / latencyCount)
        });
      } else {
        results.push({ hour, requests: 0, quota: 0, latencyAvgMs: 0 });
      }
    }

    return hasData ? results : null;
  }

  async getHourlyTrendFromMySQL(date) {
    const [rows] = await mysql.query(`
      SELECT
        stat_hour,
        MAX(CASE WHEN metric_name = 'requests' THEN metric_value END) as requests,
        MAX(CASE WHEN metric_name = 'quota' THEN metric_value END) as quota,
        MAX(CASE WHEN metric_name = 'latency_count' THEN metric_value END) as latency_count,
        MAX(CASE WHEN metric_name = 'latency_sum' THEN metric_value END) as latency_sum
      FROM unified_stats
      WHERE stat_date = ? AND dim_type = 'global' AND dim1_key = 'global' AND stat_hour IS NOT NULL
      GROUP BY stat_hour
      ORDER BY stat_hour
    `, [date]);

    const hourMap = new Map();
    rows.forEach(row => {
      const latencyCount = parseInt(row.latency_count) || 1;
      hourMap.set(row.stat_hour, {
        hour: row.stat_hour,
        requests: parseInt(row.requests) || 0,
        quota: parseInt(row.quota) || 0,
        latencyAvgMs: Math.round((parseInt(row.latency_sum) || 0) / latencyCount)
      });
    });

    // 填充所有小时
    const results = [];
    for (let hour = 0; hour < 24; hour++) {
      results.push(hourMap.get(hour) || { hour, requests: 0, quota: 0, latencyAvgMs: 0 });
    }

    return results;
  }

  /**
   * 获取延迟分布
   */
  async getLatencyDistribution(date = this.formatDate()) {
    // 1. 尝试 Redis
    const key = `stats:global:${date}`;
    const data = await redis.hgetall(key);

    if (data && (data.latency_bucket_0_100 || data.latency_bucket_100_300)) {
      console.log(`[DashboardStats] Redis hit: latencyDistribution ${date}`);
      return {
        '0-100ms': parseInt(data.latency_bucket_0_100) || 0,
        '100-300ms': parseInt(data.latency_bucket_100_300) || 0,
        '300-500ms': parseInt(data.latency_bucket_300_500) || 0,
        '500-1000ms': parseInt(data.latency_bucket_500_1000) || 0,
        '1000-2000ms': parseInt(data.latency_bucket_1000_2000) || 0,
        '2000-5000ms': parseInt(data.latency_bucket_2000_5000) || 0,
        '5000ms+': parseInt(data.latency_bucket_5000_plus) || 0
      };
    }

    // 2. MySQL 查询
    console.log(`[DashboardStats] Redis miss, querying MySQL: latencyDistribution ${date}`);
    const [rows] = await mysql.query(`
      SELECT metric_name, metric_value
      FROM unified_stats
      WHERE stat_date = ? AND dim_type = 'global' AND dim1_key = 'global'
        AND metric_name LIKE 'latency_bucket_%'
    `, [date]);

    const distribution = {
      '0-100ms': 0, '100-300ms': 0, '300-500ms': 0,
      '500-1000ms': 0, '1000-2000ms': 0, '2000-5000ms': 0, '5000ms+': 0
    };

    rows.forEach(row => {
      const bucket = row.metric_name.replace('latency_bucket_', '').replace('_', '-').replace('plus', '+').replace('-plus', '+') + 'ms';
      if (distribution.hasOwnProperty(bucket)) {
        distribution[bucket] = parseInt(row.metric_value) || 0;
      }
    });

    return distribution;
  }

  /**
   * 工具方法：计算成功率
   */
  calculateSuccessRate(success, error) {
    const s = parseInt(success) || 0;
    const e = parseInt(error) || 0;
    const total = s + e;
    return total > 0 ? ((s / total) * 100).toFixed(1) + '%' : '100.0%';
  }
}

module.exports = new DashboardStatsService();
