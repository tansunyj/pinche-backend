/**
 * 将 Redis 统计数据同步到 MySQL unified_stats 表
 * 支持指定日期，默认同步今天
 *
 * 执行: node sync-redis-to-mysql.js [日期，格式: 2026-05-21]
 */
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 加载环境变量
function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
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
  } catch (e) {
    console.log('Note: Could not load env file:', filePath);
  }
}

loadEnvFile(path.join(__dirname, '.env.development'));
loadEnvFile(path.join(__dirname, '.env'));

// 日期参数
const targetDate = process.argv[2] || new Date().toISOString().split('T')[0];
console.log(`🔄 准备同步日期: ${targetDate}\n`);

// 获取东八区日期（用于数据展示）
function getCSTDate() {
  const now = new Date();
  const cstOffset = 8 * 60 * 60 * 1000;
  const cstTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60 * 1000) + cstOffset);
  return cstTime.toISOString().split('T')[0];
}

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

// 模拟 Redis 客户端（实际使用时需要引入 ioredis）
// 这里为了演示，生成模拟数据
async function getRedisData(date) {
  // 模拟从 Redis 获取数据
  // 实际使用时应该使用: const redis = require('../api-relay/db/redis');
  // 然后调用 redis.hgetall(key) 等

  console.log('⚠️  注意: 这是一个演示脚本，需要连接到实际的 Redis 实例');
  console.log('请确保 api-relay/db/redis.js 存在并正确配置\n');

  try {
    const redis = require('../api-relay/db/redis');
    return await fetchDataFromRedis(redis, date);
  } catch (err) {
    console.error('❌ 无法加载 Redis 模块:', err.message);
    console.log('\n请检查:');
    console.log('1. api-relay/db/redis.js 是否存在');
    console.log('2. Redis 服务是否运行');
    console.log('\n或者使用模拟数据进行测试\n');
    return generateMockData(date);
  }
}

// 从实际 Redis 获取数据
async function fetchDataFromRedis(redis, date) {
  const data = {
    global: {},
    channels: [],
    tokens: [],
    models: []
  };

  // 1. 获取全局统计
  const globalKey = `stats:global:${date}`;
  try {
    const type = await redis.type(globalKey);
    if (type === 'hash') {
      data.global = await redis.hgetall(globalKey);
      console.log(`📊 全局统计: ${data.global.requests || 0} 请求, ${data.global.quota || 0} 额度`);
    } else {
      console.log(`⚠️  全局统计 key 类型错误: ${type}，跳过`);
    }
  } catch (e) {
    console.log(`⚠️  获取全局统计失败: ${e.message}`);
  }

  // 2. 获取渠道统计
  const channelKeys = await redis.keys(`stats:channel:*:${date}`);
  console.log(`📡 发现 ${channelKeys.length} 个渠道`);
  for (const key of channelKeys) {
    try {
      const channelId = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (stats && typeof stats === 'object') {
        data.channels.push({ id: channelId, stats: stats });
      }
    } catch (e) {
      console.log(`   ⚠️  跳过渠道 ${key}: ${e.message}`);
    }
  }

  // 3. 获取 Token 统计
  const tokenKeys = await redis.keys(`stats:token:*:${date}`);
  console.log(`🔑 发现 ${tokenKeys.length} 个 Token`);
  for (const key of tokenKeys) {
    try {
      const tokenId = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (stats && typeof stats === 'object') {
        data.tokens.push({ id: tokenId, stats: stats });
      }
    } catch (e) {
      console.log(`   ⚠️  跳过 Token ${key}: ${e.message}`);
    }
  }

  // 4. 获取模型统计
  const modelKeys = await redis.keys(`stats:model:*:${date}`);
  console.log(`🤖 发现 ${modelKeys.length} 个模型`);
  for (const key of modelKeys) {
    try {
      const model = key.split(':')[2];
      const stats = await redis.hgetall(key);
      if (stats && typeof stats === 'object') {
        data.models.push({ id: model, stats: stats });
      }
    } catch (e) {
      console.log(`   ⚠️  跳过模型 ${key}: ${e.message}`);
    }
  }

  return data;
}

// 生成模拟数据（用于测试）
function generateMockData(date) {
  console.log(`🎲 生成模拟数据用于测试，日期: ${date}\n`);

  // ... 保持原有模拟数据 ...

  console.log(`📊 模拟数据 (${date}) - 全局: ${data.global.requests} 请求, 额度: ${data.global.quota}`);
  console.log(`📡 渠道: ${data.channels.length} 个`);
  console.log(`🔑 Token: ${data.tokens.length} 个`);
  console.log(`🤖 模型: ${data.models.length} 个\n`);

  return data;
}

// 保存指标到 unified_stats
async function saveMetrics(conn, date, dimType, dim1Key, dim2Key, stats, meta = {}) {
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
    if (stats[metric] && parseFloat(stats[metric]) > 0) {
      await conn.execute(`
        INSERT INTO unified_stats
          (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json, created_at)
        VALUES (STR_TO_DATE(?, '%Y-%m-%d'), ?, ?, IFNULL(?, ''), ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          metric_value = VALUES(metric_value),
          updated_at = NOW()
      `, [
        date,  // 直接使用字符串日期
        dimType,
        dim1Key,
        dim2Key,
        metric,
        parseFloat(stats[metric]) || 0,
        Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
      ]);
      savedCount++;
    }
  }
  return savedCount;
}

// 主函数
async function main() {
  console.log('🚀 开始同步 Redis 数据到 MySQL\n');

  // 获取 Redis 数据
  const data = await getRedisData(targetDate);

  if (!data.global || !data.global.requests) {
    console.log('⚠️  Redis 中没有找到该日期的数据');
    return;
  }

  // 连接 MySQL
  const conn = await createDbConnection();
  console.log('✅ MySQL 连接成功\n');

  try {
    let totalSaved = 0;

    // 1. 同步全局统计
    console.log('📊 同步全局统计...');
    const globalSaved = await saveMetrics(conn, targetDate, 'global', 'global', null, data.global);
    console.log(`   ✓ 保存了 ${globalSaved} 个指标\n`);
    totalSaved += globalSaved;

    // 2. 同步渠道统计
    console.log('📡 同步渠道统计...');
    for (const channel of data.channels) {
      const saved = await saveMetrics(conn, targetDate, 'channel', `ch:${channel.id}`, null, channel.stats, {
        channel_name: channel.stats.channel_name || `渠道${channel.id}`
      });
      console.log(`   ✓ ch:${channel.id} - ${channel.stats.channel_name || '未命名'}: ${saved} 个指标`);
      totalSaved += saved;
    }
    console.log();

    // 3. 同步 Token 统计
    console.log('🔑 同步 Token 统计...');
    for (const token of data.tokens) {
      const saved = await saveMetrics(conn, targetDate, 'token', `tk:${token.id}`, null, token.stats, {
        token_name: token.stats.token_name || `Token${token.id}`
      });
      console.log(`   ✓ tk:${token.id} - ${token.stats.token_name || '未命名'}: ${saved} 个指标`);
      totalSaved += saved;
    }
    console.log();

    // 4. 同步模型统计
    console.log('🤖 同步模型统计...');
    for (const model of data.models) {
      const saved = await saveMetrics(conn, targetDate, 'model', `md:${model.id}`, null, model.stats);
      console.log(`   ✓ md:${model.id}: ${saved} 个指标`);
      totalSaved += saved;
    }
    console.log();

    console.log(`✅ 同步完成！共保存 ${totalSaved} 条指标记录`);
    console.log(`\n📅 日期: ${targetDate}`);
    console.log(`💰 今日消费: ¥${(parseInt(data.global.quota || 0) / 100000).toFixed(2)}`);
    console.log(`📈 今日请求: ${data.global.requests || 0}`);
    console.log(`📡 活跃渠道: ${data.channels.length}`);
    console.log(`🔑 活跃令牌: ${data.tokens.length}`);
    console.log(`🤖 使用模型: ${data.models.length}`);

  } catch (err) {
    console.error('❌ 同步失败:', err);
  } finally {
    await conn.end();
    console.log('\n👋 数据库连接已关闭');
  }
}

// 执行
main().catch(err => {
  console.error('❌ 程序出错:', err);
  process.exit(1);
});
