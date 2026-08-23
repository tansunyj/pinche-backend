/**
 * 定时任务调度器
 * - 每天凌晨自动同步 Redis 统计数据到 MySQL
 * - 每 5 分钟同步当天的数据（保持实时性）
 */
const cron = require('node-cron');
const { query } = require('./db/init');

// 同步服务
class StatsSyncService {
  constructor() {
    this.isRunning = false;
    this.redis = null;
  }

  async initRedis() {
    if (this.redis) return this.redis;

    const Redis = require('ioredis');
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    // 解析密码
    let password = '';
    const match = redisUrl.match(/redis:\/\/:(.*)@/);
    if (match) password = match[1];

    this.redis = new Redis({
      host: redisUrl.match(/@([^:]+):/)?.[1] || 'localhost',
      port: parseInt(redisUrl.match(/:(\d+)$/)?.[1] || '6379'),
      password: password,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });

    return this.redis;
  }

  async closeRedis() {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  /**
   * 同步指定日期的数据
   */
  async syncDate(targetDate) {
    if (this.isRunning) {
      console.log(`[StatsSync] 已有同步任务在运行，跳过`);
      return { skipped: true };
    }

    this.isRunning = true;
    console.log(`[StatsSync] 开始同步 ${targetDate} 的数据`);

    try {
      const redis = await this.initRedis();
      const data = await this.fetchRedisData(redis, targetDate);

      if (!data.global?.requests) {
        console.log(`[StatsSync] ${targetDate} 无数据`);
        return { date: targetDate, records: 0 };
      }

      let totalSaved = 0;

      // 1. 同步全局统计
      totalSaved += await this.saveMetrics(targetDate, 'global', 'global', null, data.global);

      // 2. 同步渠道统计
      for (const channel of data.channels) {
        totalSaved += await this.saveMetrics(targetDate, 'channel', `ch:${channel.id}`, null, channel.stats);
      }

      // 3. 同步 Token 统计
      for (const token of data.tokens) {
        totalSaved += await this.saveMetrics(targetDate, 'token', `tk:${token.id}`, null, token.stats);
      }

      // 4. 同步模型统计
      for (const model of data.models) {
        totalSaved += await this.saveMetrics(targetDate, 'model', `md:${model.id}`, null, model.stats);
      }

      const result = {
        date: targetDate,
        records: totalSaved,
        requests: data.global.requests || 0,
        quota: data.global.quota || 0,
        channels: data.channels.length,
        tokens: data.tokens.length,
        models: data.models.length,
      };

      console.log(`[StatsSync] ✅ 完成: ${totalSaved} 条记录, ${result.requests} 请求, ¥${(result.quota / 100000).toFixed(2)}`);
      return result;

    } catch (err) {
      console.error(`[StatsSync] ❌ 同步失败:`, err.message);
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 从 Redis 获取数据 - 只处理 hash 类型
   */
  async fetchRedisData(redis, date) {
    const data = {
      global: {},
      channels: [],
      tokens: [],
      models: []
    };

    // 1. 获取全局统计
    const globalKey = `stats:global:${date}`;
    if (await redis.type(globalKey) === 'hash') {
      data.global = await redis.hgetall(globalKey);
    }

    // 2. 获取渠道统计 - 只匹配 stats:channel:{数字}:{日期} 格式
    const allChannelKeys = await redis.keys(`stats:channel:*:${date}`);
    const channelKeys = allChannelKeys.filter(k => k.split(':').length === 4);
    for (const key of channelKeys) {
      if (await redis.type(key) !== 'hash') continue;
      const id = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (Object.keys(stats).length > 0) {
        data.channels.push({ id, stats });
      }
    }

    // 3. 获取 Token 统计
    const allTokenKeys = await redis.keys(`stats:token:*:${date}`);
    const tokenKeys = allTokenKeys.filter(k => k.split(':').length === 4);
    for (const key of tokenKeys) {
      if (await redis.type(key) !== 'hash') continue;
      const id = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (Object.keys(stats).length > 0) {
        data.tokens.push({ id, stats });
      }
    }

    // 4. 获取模型统计
    const allModelKeys = await redis.keys(`stats:model:*:${date}`);
    const modelKeys = allModelKeys.filter(k => k.split(':').length === 4);
    for (const key of modelKeys) {
      if (await redis.type(key) !== 'hash') continue;
      const id = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (Object.keys(stats).length > 0) {
        data.models.push({ id, stats });
      }
    }

    return data;
  }

  /**
   * 保存指标到 unified_stats
   */
  async saveMetrics(date, dimType, dim1Key, dim2Key, stats) {
    const metrics = [
      'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'quota',
      'success', 'error', 'latency_count', 'latency_sum', 'latency_min', 'latency_max',
      'latency_bucket_0_100', 'latency_bucket_100_300', 'latency_bucket_300_500',
      'latency_bucket_500_1000', 'latency_bucket_1000_2000',
      'latency_bucket_2000_5000', 'latency_bucket_5000_plus',
      'online', 'health_score', 'unique_tokens', 'unique_users'
    ];

    let savedCount = 0;
    for (const metric of metrics) {
      const value = stats[metric];
      if (value !== undefined && value !== null && parseFloat(value) > 0) {
        await query(`
          INSERT INTO unified_stats
            (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            metric_value = VALUES(metric_value),
            updated_at = NOW()
        `, [date, dimType, dim1Key, dim2Key || '', metric, parseFloat(value) || 0]);
        savedCount++;
      }
    }
    return savedCount;
  }
}

// 单例实例
const syncService = new StatsSyncService();

/**
 * 初始化所有定时任务
 */
function initCronJobs() {
  console.log('[Cron] 初始化定时任务...');

  // 1. 每 5 分钟同步当天数据（保持看板实时性）
  cron.schedule('*/5 * * * *', async () => {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[Cron] 执行实时同步: ${new Date().toISOString()}`);
    try {
      await syncService.syncDate(today);
    } catch (err) {
      // 错误已在服务内记录
    }
  });

  // 2. 每天凌晨 1:00 同步昨天的完整数据
  cron.schedule('0 1 * * *', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    console.log(`[Cron] 执行昨日数据完整同步: ${yesterday}`);
    try {
      await syncService.syncDate(yesterday);
      // 同时再次同步今天（确保跨天数据准确）
      const today = new Date().toISOString().split('T')[0];
      await syncService.syncDate(today);
    } catch (err) {
      // 错误已在服务内记录
    }
  });

  // 3. 服务启动时立即同步一次
  setTimeout(async () => {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[Cron] 服务启动，立即同步今天数据`);
    try {
      await syncService.syncDate(today);
    } catch (err) {
      // 首次同步失败不阻断服务
    }
  }, 5000);

  console.log('[Cron] ✅ 定时任务已配置:');
  console.log('       - 每 5 分钟同步当天数据');
  console.log('       - 每天 01:00 同步昨天完整数据');
  console.log('       - 启动后 5 秒立即同步一次');
}

/**
 * 手动触发同步（供调试或手动调用）
 */
async function manualSync(date) {
  const targetDate = date || new Date().toISOString().split('T')[0];
  return await syncService.syncDate(targetDate);
}

module.exports = {
  initCronJobs,
  manualSync,
  StatsSyncService,
};
