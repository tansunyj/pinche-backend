/**
 * 将 Redis 统计数据同步到 MySQL unified_stats 表
 * 执行: node redis-to-mysql.js [日期，默认今天]
 */
const redis = require('../api-relay/db/redis');
const mysql = require('./db/init');

// 日期参数
const targetDate = process.argv[2] || new Date().toISOString().split('T')[0];

async function syncRedisToMySQL(date) {
  console.log(`🔄 开始同步 ${date} 的 Redis 数据到 MySQL...\n`);

  // 1. 同步全局统计
  const globalKey = `stats:global:${date}`;
  const globalStats = await redis.hgetall(globalKey);
  if (globalStats && globalStats.requests) {
    console.log(`📊 全局统计: ${globalStats.requests} 请求`);
    await saveMetrics(date, 'global', 'global', null, globalStats);
  }

  // 2. 同步渠道统计
  const channelKeys = await redis.keys(`stats:channel:*:${date}`);
  console.log(`\n📡 同步 ${channelKeys.length} 个渠道...`);
  for (const key of channelKeys) {
    const channelId = key.split(':')[2];
    const stats = await redis.hgetall(key);
    await saveMetrics(date, 'channel', `ch:${channelId}`, null, stats, {
      channel_name: stats.channel_name || `渠道${channelId}`
    });
  }

  // 3. 同步 Token 统计
  const tokenKeys = await redis.keys(`stats:token:*:${date}`);
  console.log(`\n🔑 同步 ${tokenKeys.length} 个 Token...`);
  for (const key of tokenKeys) {
    const tokenId = key.split(':')[2];
    const stats = await redis.hgetall(key);
    await saveMetrics(date, 'token', `tk:${tokenId}`, null, stats, {
      token_name: stats.token_name || `Token${tokenId}`
    });
  }

  // 4. 同步模型统计
  const modelKeys = await redis.keys(`stats:model:*:${date}`);
  console.log(`\n🤖 同步 ${modelKeys.length} 个模型...`);
  for (const key of modelKeys) {
    const model = key.split(':')[2];
    const stats = await redis.hgetall(key);
    await saveMetrics(date, 'model', `md:${model}`, null, stats);
  }

  console.log(`\n✅ 同步完成: ${date}`);
}

async function saveMetrics(date, dimType, dim1Key, dim2Key, stats, meta = {}) {
  const metrics = [
    'requests', 'prompt_tokens', 'completion_tokens', 'quota',
    'success', 'error', 'latency_count', 'latency_sum', 'latency_min', 'latency_max',
    'latency_bucket_0_100', 'latency_bucket_100_300', 'latency_bucket_300_500',
    'latency_bucket_500_1000', 'latency_bucket_1000_2000',
    'latency_bucket_2000_5000', 'latency_bucket_5000_plus',
    'online', 'health_score', 'unique_tokens', 'unique_users'
  ];

  for (const metric of metrics) {
    if (stats[metric] && stats[metric] !== '0') {
      await mysql.query(`
        INSERT INTO unified_stats
          (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          metric_value = VALUES(metric_value),
          updated_at = NOW()
      `, [date, dimType, dim1Key, dim2Key, metric, parseFloat(stats[metric]) || 0,
          Object.keys(meta).length > 0 ? JSON.stringify(meta) : null]);
    }
  }
}

// 执行
syncRedisToMySQL(targetDate)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ 同步失败:', err);
    process.exit(1);
  });
