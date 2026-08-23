#!/usr/bin/env node
/**
 * 初始化统计数据同步
 * 用于首次部署或重建环境时，将 Redis 中所有历史数据同步到 MySQL
 *
 * 执行: node scripts/init-stats-sync.js
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 加载环境变量
function loadEnv() {
  const envFile = process.env.NODE_ENV === 'production'
    ? path.join(__dirname, '..', '.env.production')
    : path.join(__dirname, '..', '.env');

  try {
    const content = fs.readFileSync(envFile, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
    console.log(`[InitSync] 已加载环境变量: ${envFile}`);
  } catch (e) {
    console.log('[InitSync] 使用默认配置');
  }
}

loadEnv();

// 创建 MySQL 连接
async function createDbConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'silievo',
  });
}

// 加载 Redis
async function loadRedis() {
  const redisPath = path.join(__dirname, '..', '..', 'api-relay', 'db', 'redis.js');
  try {
    return require(redisPath);
  } catch (err) {
    console.error('[InitSync] 无法加载 Redis 模块:', err.message);
    throw err;
  }
}

// 获取所有有数据的日期
async function getAllDates(redis) {
  const keys = await redis.keys('stats:global:*');
  return keys.map(k => k.split(':')[2]).sort();
}

// 同步指定日期的数据
async function syncDate(redis, conn, date) {
  console.log(`\n[InitSync] 正在同步 ${date}...`);

  const globalKey = `stats:global:${date}`;
  const global = await redis.hgetall(globalKey);

  if (!global || !global.requests) {
    console.log(`  ⚠️  ${date} 无数据`);
    return 0;
  }

  // 同步全局统计
  let totalSaved = 0;
  const metrics = [
    'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'quota',
    'success', 'error', 'latency_count', 'latency_sum', 'latency_min', 'latency_max',
    'latency_bucket_0_100', 'latency_bucket_100_300', 'latency_bucket_300_500',
    'latency_bucket_500_1000', 'latency_bucket_1000_2000',
    'latency_bucket_2000_5000', 'latency_bucket_5000_plus'
  ];

  for (const metric of metrics) {
    if (global[metric] && parseFloat(global[metric]) > 0) {
      await conn.execute(`
        INSERT INTO unified_stats
          (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, created_at)
        VALUES (STR_TO_DATE(?, '%Y-%m-%d'), 'global', 'global', '', ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          metric_value = VALUES(metric_value),
          updated_at = NOW()
      `, [date, metric, parseFloat(global[metric]) || 0]);
      totalSaved++;
    }
  }

  // 同步渠道统计
  const channelKeys = await redis.keys(`stats:channel:*:${date}`);
  for (const key of channelKeys) {
    const channelId = key.split(':')[2];
    const stats = await redis.hgetall(key);
    if (!stats.requests) continue;

    for (const metric of metrics) {
      if (stats[metric] && parseFloat(stats[metric]) > 0) {
        await conn.execute(`
          INSERT INTO unified_stats
            (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json, created_at)
          VALUES (STR_TO_DATE(?, '%Y-%m-%d'), 'channel', ?, '', ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            metric_value = VALUES(metric_value),
            updated_at = NOW()
        `, [date, `ch:${channelId}`, metric, parseFloat(stats[metric]) || 0,
            JSON.stringify({ channel_name: stats.channel_name || `渠道${channelId}` })]);
        totalSaved++;
      }
    }
  }

  // 同步 Token 统计
  const tokenKeys = await redis.keys(`stats:token:*:${date}`);
  for (const key of tokenKeys) {
    const tokenId = key.split(':')[2];
    const stats = await redis.hgetall(key);
    if (!stats.requests) continue;

    for (const metric of metrics) {
      if (stats[metric] && parseFloat(stats[metric]) > 0) {
        await conn.execute(`
          INSERT INTO unified_stats
            (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json, created_at)
          VALUES (STR_TO_DATE(?, '%Y-%m-%d'), 'token', ?, '', ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            metric_value = VALUES(metric_value),
            updated_at = NOW()
        `, [date, `tk:${tokenId}`, metric, parseFloat(stats[metric]) || 0,
            JSON.stringify({ token_name: stats.token_name || `Token${tokenId}` })]);
        totalSaved++;
      }
    }
  }

  // 同步模型统计
  const modelKeys = await redis.keys(`stats:model:*:${date}`);
  for (const key of modelKeys) {
    const model = key.split(':')[2];
    const stats = await redis.hgetall(key);
    if (!stats.requests) continue;

    for (const metric of metrics) {
      if (stats[metric] && parseFloat(stats[metric]) > 0) {
        await conn.execute(`
          INSERT INTO unified_stats
            (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, created_at)
          VALUES (STR_TO_DATE(?, '%Y-%m-%d'), 'model', ?, '', ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            metric_value = VALUES(metric_value),
            updated_at = NOW()
        `, [date, `md:${model}`, metric, parseFloat(stats[metric]) || 0]);
        totalSaved++;
      }
    }
  }

  console.log(`  ✅ ${date}: ${global.requests} 请求, ${global.quota} 额度, ${totalSaved} 条指标`);
  return totalSaved;
}

// 主函数
async function main() {
  console.log('========================================');
  console.log('🚀 初始化统计数据同步');
  console.log('========================================\n');

  const redis = await loadRedis();
  const conn = await createDbConnection();

  console.log('[InitSync] Redis 连接成功');
  console.log('[InitSync] MySQL 连接成功');

  try {
    const dates = await getAllDates(redis);
    console.log(`[InitSync] 发现 ${dates.length} 个日期需要同步: ${dates.join(', ')}`);

    let totalSaved = 0;
    for (const date of dates) {
      totalSaved += await syncDate(redis, conn, date);
    }

    console.log('\n========================================');
    console.log(`✅ 同步完成！共 ${dates.length} 天, ${totalSaved} 条指标`);
    console.log('========================================');

  } catch (err) {
    console.error('\n❌ 同步失败:', err.message);
    console.error(err.stack);
  } finally {
    await conn.end();
    process.exit(0);
  }
}

main();
