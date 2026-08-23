/**
 * 修复版：将 Redis 统计数据同步到 MySQL unified_stats 表
 * 处理方式：
 * 1. 只处理 hash 类型的 key（过滤掉 tau/mau/cau 结尾的 string 类型 key）
 * 2. 支持从环境变量或命令行参数获取数据库密码
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

loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, '.env.production'));

// 日期参数
const targetDate = process.argv[2] || new Date().toISOString().split('T')[0];
console.log(`🔄 准备同步日期: ${targetDate}\n`);

// 创建 MySQL 连接
async function createDbConnection() {
  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.DB_NAME || 'silievo_prod',
  };
  console.log(`[MySQL] Connecting to ${config.host}:${config.port}/${config.database} as ${config.user}`);
  return mysql.createConnection(config);
}

// 创建 Redis 连接
async function createRedisConnection() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const Redis = require('ioredis');

  // 解析密码
  let password = '';
  const match = redisUrl.match(/redis:\/\/:(.*)@/);
  if (match) {
    password = match[1];
  }

  const redis = new Redis({
    host: redisUrl.match(/@([^:]+):/)?.[1] || 'localhost',
    port: parseInt(redisUrl.match(/:(\d+)$/)?.[1] || '6379'),
    password: password,
    retryStrategy: (times) => null,
  });

  return redis;
}

// 从 Redis 获取数据 - 只处理 hash 类型的 key
async function getRedisData(date) {
  const data = {
    global: {},
    channels: [],
    tokens: [],
    models: []
  };

  const redis = await createRedisConnection();
  console.log('[Redis] 连接成功\n');

  try {
    // 1. 获取全局统计
    const globalKey = `stats:global:${date}`;
    const globalType = await redis.type(globalKey);
    if (globalType === 'hash') {
      data.global = await redis.hgetall(globalKey);
      console.log(`📊 全局统计: ${data.global.requests || 0} 请求, ${data.global.quota || 0} 额度`);
    } else {
      console.log(`⚠️  全局统计 key 类型: ${globalType}，跳过`);
    }

    // 2. 获取渠道统计 - 只匹配纯数字ID的key，排除 tau/mau/cau
    const allChannelKeys = await redis.keys(`stats:channel:*:${date}`);
    // 过滤：只保留 stats:channel:{数字}:{日期} 格式，排除 stats:channel:{数字}:tau:{日期}
    const channelKeys = allChannelKeys.filter(k => {
      const parts = k.split(':');
      return parts.length === 4; // stats:channel:8:2026-05-24
    });
    console.log(`📡 发现 ${channelKeys.length} 个有效渠道 (共 ${allChannelKeys.length} 个key)`);

    for (const key of channelKeys) {
      try {
        const type = await redis.type(key);
        if (type !== 'hash') {
          console.log(`   ⚠️  跳过 ${key}: 类型 ${type}`);
          continue;
        }
        const channelId = key.split(':')[2];
        const stats = await redis.hgetall(key);
        if (stats && Object.keys(stats).length > 0) {
          data.channels.push({ id: channelId, stats: stats });
          console.log(`   ✓ ch:${channelId} - ${stats.requests || 0} 请求`);
        }
      } catch (e) {
        console.log(`   ⚠️  跳过渠道 ${key}: ${e.message}`);
      }
    }

    // 3. 获取 Token 统计
    const allTokenKeys = await redis.keys(`stats:token:*:${date}`);
    const tokenKeys = allTokenKeys.filter(k => k.split(':').length === 4);
    console.log(`\n🔑 发现 ${tokenKeys.length} 个有效Token (共 ${allTokenKeys.length} 个key)`);

    for (const key of tokenKeys) {
      try {
        const type = await redis.type(key);
        if (type !== 'hash') continue;
        const tokenId = key.split(':')[2];
        const stats = await redis.hgetall(key);
        if (stats && Object.keys(stats).length > 0) {
          data.tokens.push({ id: tokenId, stats: stats });
          console.log(`   ✓ tk:${tokenId} - ${stats.requests || 0} 请求`);
        }
      } catch (e) {
        console.log(`   ⚠️  跳过 Token ${key}: ${e.message}`);
      }
    }

    // 4. 获取模型统计
    const allModelKeys = await redis.keys(`stats:model:*:${date}`);
    const modelKeys = allModelKeys.filter(k => k.split(':').length === 4);
    console.log(`\n🤖 发现 ${modelKeys.length} 个有效模型 (共 ${allModelKeys.length} 个key)`);

    for (const key of modelKeys) {
      try {
        const type = await redis.type(key);
        if (type !== 'hash') continue;
        const model = key.split(':')[2];
        const stats = await redis.hgetall(key);
        if (stats && Object.keys(stats).length > 0) {
          data.models.push({ id: model, stats: stats });
          console.log(`   ✓ md:${model} - ${stats.requests || 0} 请求`);
        }
      } catch (e) {
        console.log(`   ⚠️  跳过模型 ${key}: ${e.message}`);
      }
    }

  } finally {
    await redis.quit();
  }

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
    const value = stats[metric];
    if (value !== undefined && value !== null && parseFloat(value) > 0) {
      await conn.execute(`
        INSERT INTO unified_stats
          (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          metric_value = VALUES(metric_value),
          updated_at = NOW()
      `, [
        date,
        dimType,
        dim1Key,
        dim2Key || '',
        metric,
        parseFloat(value) || 0,
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
    console.log('⚠️  Redis 中没有找到该日期的有效数据');
    return;
  }

  // 连接 MySQL
  const conn = await createDbConnection();
  console.log('\n✅ MySQL 连接成功\n');

  try {
    let totalSaved = 0;

    // 1. 同步全局统计
    console.log('📊 同步全局统计...');
    const globalSaved = await saveMetrics(conn, targetDate, 'global', 'global', null, data.global);
    console.log(`   ✓ 保存了 ${globalSaved} 个指标\n`);
    totalSaved += globalSaved;

    // 2. 同步渠道统计
    if (data.channels.length > 0) {
      console.log('📡 同步渠道统计...');
      for (const channel of data.channels) {
        const saved = await saveMetrics(conn, targetDate, 'channel', `ch:${channel.id}`, null, channel.stats, {
          channel_name: channel.stats.channel_name || `渠道${channel.id}`
        });
        totalSaved += saved;
      }
      console.log(`   ✓ 共 ${data.channels.length} 个渠道\n`);
    }

    // 3. 同步 Token 统计
    if (data.tokens.length > 0) {
      console.log('🔑 同步 Token 统计...');
      for (const token of data.tokens) {
        const saved = await saveMetrics(conn, targetDate, 'token', `tk:${token.id}`, null, token.stats, {
          token_name: token.stats.token_name || `Token${token.id}`
        });
        totalSaved += saved;
      }
      console.log(`   ✓ 共 ${data.tokens.length} 个Token\n`);
    }

    // 4. 同步模型统计
    if (data.models.length > 0) {
      console.log('🤖 同步模型统计...');
      for (const model of data.models) {
        const saved = await saveMetrics(conn, targetDate, 'model', `md:${model.id}`, null, model.stats);
        totalSaved += saved;
      }
      console.log(`   ✓ 共 ${data.models.length} 个模型\n`);
    }

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
