/**
 * 每日统计归档任务
 * 将 Redis 数据归档到 MySQL unified_stats 表
 */
const mysql = require('../db/init');
const redis = require('../db/redis');

/**
 * 获取日期字符串 YYYY-MM-DD
 */
function formatDate(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/**
 * 获取昨天日期
 */
function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

/**
 * 保存或更新指标
 */
async function upsertMetric(date, hour, dimType, dim1Key, dim2Key, metricName, metricValue, metaJson = null) {
  await mysql.query(`
    INSERT INTO unified_stats
      (stat_date, stat_hour, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      metric_value = VALUES(metric_value),
      updated_at = NOW()
  `, [date, hour, dimType, dim1Key, dim2Key || '', metricName, metricValue, metaJson]);
}

/**
 * 归档全局统计
 */
async function archiveGlobalStats(date) {
  console.log(`[Archive] Archiving global stats for ${date}`);
  const data = await redis.hgetall(`stats:global:${date}`);

  if (!data || !data.requests) {
    console.log(`[Archive] No global stats for ${date}`);
    return;
  }

  const metrics = [
    'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'quota',
    'success', 'error', 'latency_count', 'latency_sum', 'latency_min', 'latency_max',
    'latency_bucket_0_100', 'latency_bucket_100_300', 'latency_bucket_300_500',
    'latency_bucket_500_1000', 'latency_bucket_1000_2000', 'latency_bucket_2000_5000',
    'latency_bucket_5000_plus'
  ];

  for (const metric of metrics) {
    if (data[metric] !== undefined) {
      await upsertMetric(date, null, 'global', 'global', null, metric, parseFloat(data[metric]));
    }
  }

  // 归档日活统计
  const uniqueUsers = await redis.pfcount(`stats:dau:${date}`);
  const uniqueTokens = await redis.pfcount(`stats:tau:${date}`);
  const uniqueChannels = await redis.pfcount(`stats:cau:${date}`);

  await upsertMetric(date, null, 'global', 'global', null, 'unique_users', uniqueUsers);
  await upsertMetric(date, null, 'global', 'global', null, 'unique_tokens', uniqueTokens);
  await upsertMetric(date, null, 'global', 'global', null, 'unique_channels', uniqueChannels);

  console.log(`[Archive] Global stats archived: requests=${data.requests}, quota=${data.quota}`);
}

/**
 * 归档渠道统计
 */
async function archiveChannelStats(date) {
  const keys = await redis.keys(`stats:channel:*:${date}`);
  console.log(`[Archive] Found ${keys.length} channel stats for ${date}`);

  for (const key of keys) {
    const channelId = key.split(':')[2];
    const data = await redis.hgetall(key);

    if (!data.requests) continue;

    const metaJson = JSON.stringify({
      channel_name: data.channel_name || `渠道${channelId}`,
      channel_type: data.channel_type || ''
    });

    const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'quota', 'success', 'error', 'latency_count', 'latency_sum', 'online'];
    for (const metric of metrics) {
      if (data[metric] !== undefined) {
        await upsertMetric(date, null, 'channel', `ch:${channelId}`, null, metric, parseFloat(data[metric]), metaJson);
      }
    }

    // 渠道维度的日活Token
    const uniqueTokens = await redis.pfcount(`stats:channel:${channelId}:tau:${date}`);
    await upsertMetric(date, null, 'channel', `ch:${channelId}`, null, 'unique_tokens', uniqueTokens, metaJson);
  }

  console.log(`[Archive] Channel stats archived`);
}

/**
 * 归档 Token 统计
 */
async function archiveTokenStats(date) {
  const keys = await redis.keys(`stats:token:*:${date}`);
  console.log(`[Archive] Found ${keys.length} token stats for ${date}`);

  for (const key of keys) {
    const tokenId = key.split(':')[2];
    const data = await redis.hgetall(key);

    if (!data.requests) continue;

    const metaJson = JSON.stringify({
      token_name: data.token_name || `Token${tokenId}`,
      user_id: parseInt(data.user_id) || 0
    });

    const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'quota', 'success', 'error', 'latency_count', 'latency_sum'];
    for (const metric of metrics) {
      if (data[metric] !== undefined) {
        await upsertMetric(date, null, 'token', `tk:${tokenId}`, null, metric, parseFloat(data[metric]), metaJson);
      }
    }
  }

  console.log(`[Archive] Token stats archived`);
}

/**
 * 归档模型统计
 */
async function archiveModelStats(date) {
  const keys = await redis.keys(`stats:model:*:${date}`);
  console.log(`[Archive] Found ${keys.length} model stats for ${date}`);

  for (const key of keys) {
    const model = key.split(':')[2];
    const data = await redis.hgetall(key);

    if (!data.requests) continue;

    const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'quota', 'latency_count', 'latency_sum'];
    for (const metric of metrics) {
      if (data[metric] !== undefined) {
        await upsertMetric(date, null, 'model', `md:${model}`, null, metric, parseFloat(data[metric]));
      }
    }

    // 模型维度的日活
    const uniqueTokens = await redis.pfcount(`stats:model:${model}:tau:${date}`);
    const uniqueChannels = await redis.pfcount(`stats:model:${model}:cau:${date}`);
    await upsertMetric(date, null, 'model', `md:${model}`, null, 'unique_tokens', uniqueTokens);
    await upsertMetric(date, null, 'model', `md:${model}`, null, 'unique_channels', uniqueChannels);
  }

  console.log(`[Archive] Model stats archived`);
}

/**
 * 归档组合维度统计
 */
async function archiveCompositeStats(date) {
  const keys = await redis.keys(`stats:composite:*:${date}`);
  console.log(`[Archive] Found ${keys.length} composite stats for ${date}`);

  for (const key of keys) {
    const parts = key.split(':');
    const dim1 = `${parts[2]}:${parts[3]}`;  // ch:1
    const dim2 = `${parts[4]}:${parts[5]}`;  // md:gpt-4
    const data = await redis.hgetall(key);

    if (!data.requests) continue;

    const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'quota'];
    for (const metric of metrics) {
      if (data[metric] !== undefined) {
        await upsertMetric(date, null, 'composite', dim1, dim2, metric, parseFloat(data[metric]));
      }
    }
  }

  console.log(`[Archive] Composite stats archived`);
}

/**
 * 归档小时级统计
 */
async function archiveHourlyStats(date) {
  console.log(`[Archive] Archiving hourly stats for ${date}`);

  for (let hour = 0; hour < 24; hour++) {
    const key = `stats:hourly:${date}:${hour}`;
    const data = await redis.hgetall(key);

    if (!data || !data.requests) continue;

    const metrics = ['requests', 'quota', 'success', 'error', 'latency_count', 'latency_sum'];
    for (const metric of metrics) {
      if (data[metric] !== undefined) {
        await upsertMetric(date, hour, 'global', 'global', null, metric, parseFloat(data[metric]));
      }
    }
  }

  console.log(`[Archive] Hourly stats archived`);
}

/**
 * 设置 Redis 过期时间（保留3天）
 */
async function setRedisExpiration(date) {
  const threeDays = 3 * 24 * 3600;
  const patterns = [
    `stats:global:${date}`,
    `stats:dau:${date}`,
    `stats:tau:${date}`,
    `stats:cau:${date}`,
    `stats:channel:*:${date}`,
    `stats:channel:*:tau:${date}`,
    `stats:channel:*:mau:${date}`,
    `stats:token:*:${date}`,
    `stats:model:*:${date}`,
    `stats:model:*:tau:${date}`,
    `stats:model:*:cau:${date}`,
    `stats:composite:*:${date}`,
    `stats:hourly:${date}:*`,
    `stats:rank:*:${date}`
  ];

  for (const pattern of patterns) {
    try {
      const keys = pattern.includes('*')
        ? await redis.keys(pattern)
        : [pattern];

      for (const key of keys) {
        await redis.expire(key, threeDays);
      }
    } catch (e) {
      console.error(`[Archive] Error setting expiration for ${pattern}:`, e.message);
    }
  }

  console.log(`[Archive] Redis expiration set for ${date}`);
}

/**
 * 主归档任务
 */
async function runDailyArchive(targetDate = getYesterday()) {
  console.log(`[Archive] Starting daily archive for ${targetDate}`);
  const startTime = Date.now();

  try {
    await archiveGlobalStats(targetDate);
    await archiveChannelStats(targetDate);
    await archiveTokenStats(targetDate);
    await archiveModelStats(targetDate);
    await archiveCompositeStats(targetDate);
    await archiveHourlyStats(targetDate);
    await setRedisExpiration(targetDate);

    const duration = Date.now() - startTime;
    console.log(`[Archive] Completed for ${targetDate} in ${duration}ms`);

    return { success: true, date: targetDate, duration };
  } catch (err) {
    console.error(`[Archive] Error for ${targetDate}:`, err);
    return { success: false, date: targetDate, error: err.message };
  }
}

module.exports = {
  runDailyArchive,
  getYesterday
};
