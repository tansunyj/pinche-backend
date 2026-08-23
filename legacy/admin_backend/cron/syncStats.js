/**
 * 统计同步任务 - 复用 admin_backend 现有的 Redis/MySQL 连接
 * 支持分布式锁，避免多实例同时执行
 * 详细日志输出用于排查问题
 */
const { query } = require('../db/init');
const redis = require('../db/redis');

// 分布式锁配置
const LOCK_KEY = 'cron:stats_sync:lock';
const LOCK_TTL_SECONDS = 300; // 5分钟锁过期时间

/**
 * 格式化数字，添加千分位
 */
function formatNumber(num) {
  return parseInt(num).toLocaleString('zh-CN');
}

/**
 * 尝试获取分布式锁
 * @returns {Promise<boolean>} 是否获取成功
 */
async function acquireLock() {
  const timestamp = Date.now();
  const lockValue = `${process.pid}-${timestamp}`;

  console.log(`[StatsSync] [${new Date().toISOString()}] 尝试获取分布式锁...`);

  // Redis SET key value EX seconds NX
  const result = await redis.set(LOCK_KEY, lockValue, 'EX', LOCK_TTL_SECONDS, 'NX');

  if (result === 'OK') {
    console.log(`[StatsSync] [${new Date().toISOString()}] ✅ 获取分布式锁成功: ${lockValue}`);
    return { acquired: true, value: lockValue };
  } else {
    const existingValue = await redis.get(LOCK_KEY);
    console.log(`[StatsSync] [${new Date().toISOString()}] ⏭️ 获取分布式锁失败，已有实例在执行: ${existingValue}`);
    return { acquired: false, value: null };
  }
}

/**
 * 释放分布式锁（使用 Lua 脚本确保原子性）
 */
async function releaseLock(lockValue) {
  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  const result = await redis.eval(luaScript, 1, LOCK_KEY, lockValue);
  if (result === 1) {
    console.log(`[StatsSync] [${new Date().toISOString()}] ✅ 释放分布式锁成功`);
  } else {
    console.log(`[StatsSync] [${new Date().toISOString()}] ⚠️ 分布式锁已被其他实例获取或已过期`);
  }
}

// 同步服务单例
class StatsSyncService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * 同步指定日期的数据（带分布式锁）
   */
  async syncDate(targetDate) {
    if (this.isRunning) {
      console.log(`[StatsSync] [${new Date().toISOString()}] ⏭️ 已有同步任务在运行，跳过`);
      return { skipped: true, reason: 'local_running' };
    }

    // 尝试获取分布式锁
    const lock = await acquireLock();
    if (!lock.acquired) {
      return { skipped: true, reason: 'distributed_lock_held' };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const startTimeStr = new Date().toISOString();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`[StatsSync] [${startTimeStr}] 🚀 开始同步 ${targetDate} 的数据`);
    console.log(`${'='.repeat(80)}`);

    try {
      // 阶段1: 从 Redis 读取数据
      console.log(`\n[StatsSync] [${new Date().toISOString()}] 📥 阶段1: 从 Redis 读取数据...`);
      const data = await this.fetchRedisData(targetDate);

      if (!data.global?.requests) {
        console.log(`[StatsSync] [${new Date().toISOString()}] ⚠️ ${targetDate} 无数据，跳过同步`);
        return { date: targetDate, records: 0 };
      }

      // 阶段2: 同步到 MySQL
      console.log(`\n[StatsSync] [${new Date().toISOString()}] 💾 阶段2: 同步到 MySQL...`);
      let totalSaved = 0;
      const details = [];

      // 2.1 同步全局统计
      console.log(`\n[StatsSync] [${new Date().toISOString()}] 📊 同步 [GLOBAL] 全局统计...`);
      const globalSaved = await this.saveMetricsWithLog(targetDate, 'global', 'global', null, data.global, 'GLOBAL');
      totalSaved += globalSaved.count;
      details.push({ type: 'global', name: '全局', saved: globalSaved.count, metrics: globalSaved.metrics });

      // 2.2 同步渠道统计
      console.log(`\n[StatsSync] [${new Date().toISOString()}] 📡 同步 [CHANNEL] 渠道统计 (${data.channels.length} 个渠道)...`);
      for (const channel of data.channels) {
        const channelName = channel.stats.channel_name || `渠道${channel.id}`;
        const saved = await this.saveMetricsWithLog(targetDate, 'channel', `ch:${channel.id}`, null, channel.stats, `CHANNEL[${channel.id}:${channelName}]`);
        totalSaved += saved.count;
        details.push({ type: 'channel', id: channel.id, name: channelName, saved: saved.count, metrics: saved.metrics });
      }

      // 2.3 同步 Token 统计
      console.log(`\n[StatsSync] [${new Date().toISOString()}] 🔑 同步 [TOKEN] Token统计 (${data.tokens.length} 个Token)...`);
      for (const token of data.tokens) {
        const tokenName = token.stats.token_name || `Token${token.id}`;
        const saved = await this.saveMetricsWithLog(targetDate, 'token', `tk:${token.id}`, null, token.stats, `TOKEN[${token.id}:${tokenName}]`);
        totalSaved += saved.count;
        details.push({ type: 'token', id: token.id, name: tokenName, saved: saved.count, metrics: saved.metrics });
      }

      // 2.4 同步模型统计
      console.log(`\n[StatsSync] [${new Date().toISOString()}] 🤖 同步 [MODEL] 模型统计 (${data.models.length} 个模型)...`);
      for (const model of data.models) {
        const saved = await this.saveMetricsWithLog(targetDate, 'model', `md:${model.id}`, null, model.stats, `MODEL[${model.id}]`);
        totalSaved += saved.count;
        details.push({ type: 'model', id: model.id, name: model.id, saved: saved.count, metrics: saved.metrics });
      }

      // 2.5 同步渠道+模型组合统计 (composite)
      console.log(`\n[StatsSync] [${new Date().toISOString()}] 🔗 同步 [COMPOSITE] 渠道+模型组合统计 (${data.composites.length} 个组合)...`);
      for (const composite of data.composites) {
        const dimKey = `ch:${composite.channelId}:md:${composite.modelId}`;
        const saved = await this.saveMetricsWithLog(targetDate, 'composite', dimKey, null, composite.stats, `COMPOSITE[ch:${composite.channelId}:md:${composite.modelId}]`);
        totalSaved += saved.count;
        details.push({ type: 'composite', channelId: composite.channelId, modelId: composite.modelId, saved: saved.count, metrics: saved.metrics });
      }

      const duration = Date.now() - startTime;

      // 阶段3: 输出汇总报告
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[StatsSync] [${new Date().toISOString()}] ✅ 同步完成 - 汇总报告`);
      console.log(`${'='.repeat(80)}`);
      console.log(`  📅 日期: ${targetDate}`);
      console.log(`  ⏱️  耗时: ${duration}ms`);
      console.log(`  📊 写入记录数: ${totalSaved} 条`);
      console.log(`  📈 总请求数: ${formatNumber(data.global.requests || 0)}`);
      console.log(`  💰 总消费额: ¥${((data.global.quota || 0) / 100000).toFixed(2)}`);
      console.log(`  🔤 输入Token: ${formatNumber(data.global.prompt_tokens || 0)}`);
      console.log(`  🔡 输出Token: ${formatNumber(data.global.completion_tokens || 0)}`);
      console.log(`  📡 活跃渠道: ${data.channels.length} 个`);
      console.log(`  🔑 活跃Token: ${data.tokens.length} 个`);
      console.log(`  🤖 使用模型: ${data.models.length} 个`);
      console.log(`  🔗 渠道+模型组合: ${data.composites.length} 个`);
      console.log(`${'='.repeat(80)}\n`);

      // 输出详细指标（DEBUG级别）
      this.logDetailedMetrics(details, data.global);

      const result = {
        date: targetDate,
        records: totalSaved,
        requests: data.global.requests || 0,
        quota: data.global.quota || 0,
        prompt_tokens: data.global.prompt_tokens || 0,
        completion_tokens: data.global.completion_tokens || 0,
        channels: data.channels.length,
        tokens: data.tokens.length,
        models: data.models.length,
        composites: data.composites.length,
        duration_ms: duration,
        details
      };

      return result;

    } catch (err) {
      console.error(`[StatsSync] [${new Date().toISOString()}] ❌ 同步失败:`, err.message);
      console.error(`[StatsSync] 错误堆栈:`, err.stack);
      throw err;
    } finally {
      this.isRunning = false;
      await releaseLock(lock.value);
    }
  }

  /**
   * 输出详细指标日志
   */
  logDetailedMetrics(details, globalStats) {
    console.log(`[StatsSync] [${new Date().toISOString()}] 📋 详细指标数据:`);

    // 全局指标
    if (globalStats) {
      console.log(`\n  [GLOBAL] 全局指标:`);
      Object.entries(globalStats)
        .filter(([k, v]) => !isNaN(parseFloat(v)) && parseFloat(v) > 0)
        .forEach(([k, v]) => {
          if (k === 'quota') {
            console.log(`    - ${k}: ${formatNumber(v)} (¥${(parseFloat(v) / 100000).toFixed(2)})`);
          } else {
            console.log(`    - ${k}: ${formatNumber(v)}`);
          }
        });
    }

    // 各维度前3名
    const topChannels = details.filter(d => d.type === 'channel').slice(0, 3);
    if (topChannels.length > 0) {
      console.log(`\n  [CHANNEL] TOP ${topChannels.length} 渠道:`);
      topChannels.forEach(c => {
        const quota = c.metrics?.quota || 0;
        const requests = c.metrics?.requests || 0;
        console.log(`    - ${c.name}: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      });
    }

    const topTokens = details.filter(d => d.type === 'token').slice(0, 3);
    if (topTokens.length > 0) {
      console.log(`\n  [TOKEN] TOP ${topTokens.length} Token:`);
      topTokens.forEach(t => {
        const quota = t.metrics?.quota || 0;
        const requests = t.metrics?.requests || 0;
        console.log(`    - ${t.name}: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      });
    }

    const topModels = details.filter(d => d.type === 'model').slice(0, 3);
    if (topModels.length > 0) {
      console.log(`\n  [MODEL] TOP ${topModels.length} 模型:`);
      topModels.forEach(m => {
        const quota = m.metrics?.quota || 0;
        const requests = m.metrics?.requests || 0;
        console.log(`    - ${m.name}: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      });
    }

    // 渠道+模型组合 TOP 3
    const topComposites = details.filter(d => d.type === 'composite').slice(0, 3);
    if (topComposites.length > 0) {
      console.log(`\n  [COMPOSITE] TOP ${topComposites.length} 渠道+模型组合:`);
      topComposites.forEach(c => {
        const quota = c.metrics?.quota || 0;
        const requests = c.metrics?.requests || 0;
        console.log(`    - 渠道${c.channelId}+${c.modelId}: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      });
    }

    console.log(''); // 空行分隔
  }

  /**
   * 从 Redis 获取数据 - 使用已有的 redis 连接
   * 只处理 hash 类型，过滤 tau/mau/cau key
   */
  async fetchRedisData(date) {
    const data = {
      global: {},
      channels: [],
      tokens: [],
      models: [],
      composites: []  // 新增：渠道+模型组合统计
    };

    console.log(`[StatsSync] [${new Date().toISOString()}]   🔍 查询 Redis keys...`);

    // 1. 获取全局统计
    const globalKey = `stats:global:${date}`;
    console.log(`[StatsSync] [${new Date().toISOString()}]   📍 检查 key: ${globalKey}`);
    if (await redis.type(globalKey) === 'hash') {
      data.global = await redis.hgetall(globalKey);
      const requests = parseInt(data.global.requests) || 0;
      const quota = parseInt(data.global.quota) || 0;
      console.log(`[StatsSync] [${new Date().toISOString()}]   ✅ 全局统计: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
    } else {
      console.log(`[StatsSync] [${new Date().toISOString()}]   ⚠️  全局统计 key 不存在或类型错误`);
    }

    // 2. 获取渠道统计 - 只匹配 stats:channel:{数字}:{日期} 格式
    console.log(`[StatsSync] [${new Date().toISOString()}]   🔍 查询渠道 keys...`);
    const allChannelKeys = await redis.keys(`stats:channel:*:${date}`);
    const channelKeys = allChannelKeys.filter(k => k.split(':').length === 4);
    console.log(`[StatsSync] [${new Date().toISOString()}]   📊 发现 ${allChannelKeys.length} 个渠道key，过滤后 ${channelKeys.length} 个有效`);

    for (const key of channelKeys) {
      const keyType = await redis.type(key);
      if (keyType !== 'hash') {
        console.log(`[StatsSync] [${new Date().toISOString()}]   ⚠️  跳过 ${key}: 类型 ${keyType}`);
        continue;
      }
      const id = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (Object.keys(stats).length > 0) {
        data.channels.push({ id, stats });
        const requests = parseInt(stats.requests) || 0;
        const quota = parseInt(stats.quota) || 0;
        const name = stats.channel_name || `渠道${id}`;
        console.log(`[StatsSync] [${new Date().toISOString()}]   ✅ 渠道[${id}] ${name}: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      }
    }

    // 3. 获取 Token 统计
    console.log(`[StatsSync] [${new Date().toISOString()}]   🔍 查询 Token keys...`);
    const allTokenKeys = await redis.keys(`stats:token:*:${date}`);
    const tokenKeys = allTokenKeys.filter(k => k.split(':').length === 4);
    console.log(`[StatsSync] [${new Date().toISOString()}]   📊 发现 ${allTokenKeys.length} 个Token key，过滤后 ${tokenKeys.length} 个有效`);

    for (const key of tokenKeys) {
      const keyType = await redis.type(key);
      if (keyType !== 'hash') continue;
      const id = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (Object.keys(stats).length > 0) {
        data.tokens.push({ id, stats });
        const requests = parseInt(stats.requests) || 0;
        const quota = parseInt(stats.quota) || 0;
        const name = stats.token_name || `Token${id}`;
        console.log(`[StatsSync] [${new Date().toISOString()}]   ✅ Token[${id}] ${name}: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      }
    }

    // 4. 获取模型统计
    console.log(`[StatsSync] [${new Date().toISOString()}]   🔍 查询模型 keys...`);
    const allModelKeys = await redis.keys(`stats:model:*:${date}`);
    const modelKeys = allModelKeys.filter(k => k.split(':').length === 4);
    console.log(`[StatsSync] [${new Date().toISOString()}]   📊 发现 ${allModelKeys.length} 个模型key，过滤后 ${modelKeys.length} 个有效`);

    for (const key of modelKeys) {
      const keyType = await redis.type(key);
      if (keyType !== 'hash') continue;
      const id = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (Object.keys(stats).length > 0) {
        data.models.push({ id, stats });
        const requests = parseInt(stats.requests) || 0;
        const quota = parseInt(stats.quota) || 0;
        console.log(`[StatsSync] [${new Date().toISOString()}]   ✅ 模型[${id}]: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      }
    }

    // 5. 获取渠道+模型组合统计 (composite)
    console.log(`[StatsSync] [${new Date().toISOString()}]   🔍 查询渠道+模型组合 keys...`);
    const allCompositeKeys = await redis.keys(`stats:composite:ch:*:md:*:${date}`);
    console.log(`[StatsSync] [${new Date().toISOString()}]   📊 发现 ${allCompositeKeys.length} 个组合key`);

    for (const key of allCompositeKeys) {
      const keyType = await redis.type(key);
      if (keyType !== 'hash') continue;
      // key格式: stats:composite:ch:{channelId}:md:{model}:{date}
      const parts = key.split(':');
      if (parts.length !== 7) continue;
      const channelId = parts[3];
      const modelId = parts[5];
      const stats = await redis.hgetall(key);
      if (Object.keys(stats).length > 0) {
        data.composites.push({ channelId, modelId, stats });
        const requests = parseInt(stats.requests) || 0;
        const quota = parseInt(stats.quota) || 0;
        console.log(`[StatsSync] [${new Date().toISOString()}]   ✅ 组合[ch:${channelId}:md:${modelId}]: ${formatNumber(requests)}请求, ¥${(quota / 100000).toFixed(2)}`);
      }
    }

    console.log(`[StatsSync] [${new Date().toISOString()}]   📥 Redis 数据读取完成`);
    return data;
  }

  /**
   * 保存指标到 unified_stats - 带详细日志
   */
  async saveMetricsWithLog(date, dimType, dim1Key, dim2Key, stats, label) {
    const metrics = [
      'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'quota',
      'success', 'error', 'latency_count', 'latency_sum', 'latency_min', 'latency_max',
      'latency_bucket_0_100', 'latency_bucket_100_300', 'latency_bucket_300_500',
      'latency_bucket_500_1000', 'latency_bucket_1000_2000',
      'latency_bucket_2000_5000', 'latency_bucket_5000_plus',
      'online', 'health_score', 'unique_tokens', 'unique_users'
    ];

    let savedCount = 0;
    const savedMetrics = {};

    for (const metric of metrics) {
      const value = stats[metric];
      if (value !== undefined && value !== null && parseFloat(value) > 0) {
        try {
          await query(`
            INSERT INTO unified_stats
              (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
              metric_value = VALUES(metric_value),
              updated_at = NOW()
          `, [date, dimType, dim1Key, dim2Key || '', metric, parseFloat(value) || 0]);

          savedMetrics[metric] = parseFloat(value);
          savedCount++;
        } catch (err) {
          console.error(`[StatsSync] [${new Date().toISOString()}]   ❌ 写入失败 [${label}][${metric}]: ${err.message}`);
        }
      }
    }

    // 输出该维度的关键指标
    const requests = savedMetrics.requests || 0;
    const quota = savedMetrics.quota || 0;
    const promptTokens = savedMetrics.prompt_tokens || 0;
    const completionTokens = savedMetrics.completion_tokens || 0;

    if (savedCount > 0) {
      console.log(`[StatsSync] [${new Date().toISOString()}]   ✅ ${label}: ${savedCount}个指标` +
        (requests ? ` | ${formatNumber(requests)}请求` : '') +
        (quota ? ` | ¥${(quota / 100000).toFixed(2)}` : '') +
        (promptTokens ? ` | ${formatNumber(promptTokens)}输入token` : '') +
        (completionTokens ? ` | ${formatNumber(completionTokens)}输出token` : '')
      );
    }

    return { count: savedCount, metrics: savedMetrics };
  }
}

// 单例实例
const syncService = new StatsSyncService();

/**
 * 同步指定日期的数据（手动触发或补数据时用）
 * @param {string} date - 格式: 2026-05-24，不传则同步今天
 */
async function runStatsSync(date) {
  const targetDate = date || new Date().toISOString().split('T')[0];

  console.log(`[Cron] [${new Date().toISOString()}] 手动触发同步: ${targetDate}`);

  try {
    const result = await syncService.syncDate(targetDate);
    if (result.skipped) {
      console.log(`[Cron] [${new Date().toISOString()}] 同步被跳过: ${result.reason}`);
      return { success: true, skipped: true, ...result };
    }
    console.log(`[Cron] [${new Date().toISOString()}] 同步完成`);
    return { success: true, ...result };
  } catch (error) {
    console.error('[Cron] 同步失败:', error.message);
    return { success: false, error: error.message, date: targetDate };
  }
}

/**
 * 同步今天的数据（每分钟自动执行，实时看板）
 */
async function runTodaySync() {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  try {
    const result = await syncService.syncDate(today);
    if (result.skipped) {
      return { success: true, skipped: true, ...result };
    }
    return { success: true, ...result };
  } catch (error) {
    console.error(`[Cron] [${now}] 同步失败:`, error.message);
    return { success: false, error: error.message, date: today };
  }
}

module.exports = {
  runStatsSync,    // 手动触发或补数据
  runTodaySync,    // 每分钟自动执行
  syncService,
};
