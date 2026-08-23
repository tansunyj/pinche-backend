/**
 * 手动执行归档任务（将Redis数据归档到MySQL）
 */
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  db: 0
});

const DB_CONFIG = {
  host: 'localhost',
  user: 'root',
  password: '123456',
  database: 'silievo'
};

async function upsertMetric(conn, date, hour, dimType, dim1Key, dim2Key, metricName, metricValue, metaJson = null) {
  // 确保 dim2Key 不为 NULL，使用空字符串作为默认值
  const safeDim2Key = dim2Key || '';
  await conn.execute(`
    INSERT INTO unified_stats
      (stat_date, stat_hour, dim_type, dim1_key, dim2_key, metric_name, metric_value, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      metric_value = VALUES(metric_value),
      updated_at = NOW()
  `, [date, hour, dimType, dim1Key, safeDim2Key, metricName, metricValue, metaJson]);
}

async function archive() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`\n========== 归档数据: ${today} ==========\n`);

  const conn = await mysql.createConnection(DB_CONFIG);

  try {
    // 1. 归档全局统计
    console.log('1. 归档全局统计...');
    const global = await redis.hgetall(`stats:global:${today}`);
    if (global.requests) {
      const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'quota',
        'success', 'error', 'latency_count', 'latency_sum', 'latency_min', 'latency_max'];
      for (const metric of metrics) {
        if (global[metric]) {
          await upsertMetric(conn, today, null, 'global', 'global', null, metric, parseFloat(global[metric]));
        }
      }

      // 日活统计
      const dau = await redis.pfcount(`stats:dau:${today}`);
      const tau = await redis.pfcount(`stats:tau:${today}`);
      const cau = await redis.pfcount(`stats:cau:${today}`);
      await upsertMetric(conn, today, null, 'global', 'global', null, 'unique_users', dau);
      await upsertMetric(conn, today, null, 'global', 'global', null, 'unique_tokens', tau);
      await upsertMetric(conn, today, null, 'global', 'global', null, 'unique_channels', cau);

      // 延迟分桶
      const buckets = [
        { key: 'latency_bucket_0_100', name: '0_100' },
        { key: 'latency_bucket_100_300', name: '100_300' },
        { key: 'latency_bucket_300_500', name: '300_500' },
        { key: 'latency_bucket_500_1000', name: '500_1000' },
        { key: 'latency_bucket_1000_2000', name: '1000_2000' },
        { key: 'latency_bucket_2000_5000', name: '2000_5000' },
        { key: 'latency_bucket_5000_plus', name: '5000_plus' }
      ];
      for (const bucket of buckets) {
        if (global[bucket.key]) {
          await upsertMetric(conn, today, null, 'global', 'global', null, bucket.key, parseFloat(global[bucket.key]));
        }
      }

      console.log('   ✓ 全局统计已归档');
    } else {
      console.log('   ⚠️ 无全局统计数据');
    }

    // 2. 归档渠道统计
    console.log('\n2. 归档渠道统计...');
    const channelKeys = (await redis.keys(`stats:channel:*:${today}`))
      .filter(key => key.split(':').length === 4); // 排除 tau/mau/cau HyperLogLog keys
    for (const key of channelKeys) {
      const channelId = key.split(':')[2];
      const data = await redis.hgetall(key);
      if (!data.requests) continue;

      const metaJson = JSON.stringify({
        channel_name: data.channel_name || `渠道${channelId}`,
        channel_type: data.channel_type || ''
      });

      const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'quota', 'success', 'error', 'latency_count', 'latency_sum'];
      for (const metric of metrics) {
        if (data[metric]) {
          await upsertMetric(conn, today, null, 'channel', `ch:${channelId}`, null, metric, parseFloat(data[metric]), metaJson);
        }
      }

      // 日活Token
      const uniqueTokens = await redis.pfcount(`stats:channel:${channelId}:tau:${today}`);
      await upsertMetric(conn, today, null, 'channel', `ch:${channelId}`, null, 'unique_tokens', uniqueTokens, metaJson);
    }
    console.log(`   ✓ ${channelKeys.length} 个渠道已归档`);

    // 3. 归档Token统计
    console.log('\n3. 归档Token统计...');
    const tokenKeys = (await redis.keys(`stats:token:*:${today}`))
      .filter(key => key.split(':').length === 4);
    for (const key of tokenKeys) {
      const tokenId = key.split(':')[2];
      const data = await redis.hgetall(key);
      if (!data.requests) continue;

      const metaJson = JSON.stringify({
        token_name: data.token_name || `Token${tokenId}`,
        user_id: parseInt(data.user_id) || 0
      });

      const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'quota', 'success', 'error', 'latency_count', 'latency_sum'];
      for (const metric of metrics) {
        if (data[metric]) {
          await upsertMetric(conn, today, null, 'token', `tk:${tokenId}`, null, metric, parseFloat(data[metric]), metaJson);
        }
      }
    }
    console.log(`   ✓ ${tokenKeys.length} 个Token已归档`);

    // 4. 归档模型统计
    console.log('\n4. 归档模型统计...');
    const modelKeys = (await redis.keys(`stats:model:*:${today}`))
      .filter(key => key.split(':').length === 4);
    for (const key of modelKeys) {
      const model = key.split(':')[2];
      const data = await redis.hgetall(key);
      if (!data.requests) continue;

      const metrics = ['requests', 'prompt_tokens', 'completion_tokens', 'quota', 'latency_count', 'latency_sum'];
      for (const metric of metrics) {
        if (data[metric]) {
          await upsertMetric(conn, today, null, 'model', `md:${model}`, null, metric, parseFloat(data[metric]));
        }
      }

      // 日活
      const uniqueTokens = await redis.pfcount(`stats:model:${model}:tau:${today}`);
      const uniqueChannels = await redis.pfcount(`stats:model:${model}:cau:${today}`);
      await upsertMetric(conn, today, null, 'model', `md:${model}`, null, 'unique_tokens', uniqueTokens);
      await upsertMetric(conn, today, null, 'model', `md:${model}`, null, 'unique_channels', uniqueChannels);
    }
    console.log(`   ✓ ${modelKeys.length} 个模型已归档`);

    // 5. 归档小时级统计
    console.log('\n5. 归档小时级统计...');
    let hourlyCount = 0;
    for (let hour = 0; hour < 24; hour++) {
      const data = await redis.hgetall(`stats:hourly:${today}:${hour}`);
      if (!data || !data.requests) continue;

      const metrics = ['requests', 'quota', 'success', 'error', 'latency_count', 'latency_sum'];
      for (const metric of metrics) {
        if (data[metric]) {
          await upsertMetric(conn, today, hour, 'global', 'global', null, metric, parseFloat(data[metric]));
        }
      }
      hourlyCount++;
    }
    console.log(`   ✓ ${hourlyCount} 个小时段已归档`);

    console.log('\n========== 归档完成 ==========\n');

    // 显示归档结果
    const [rows] = await conn.execute(`
      SELECT dim_type, COUNT(*) as count
      FROM unified_stats
      WHERE stat_date = ?
      GROUP BY dim_type
    `, [today]);

    console.log('今日归档统计:');
    for (const row of rows) {
      console.log(`  ${row.dim_type}: ${row.count} 条记录`);
    }

  } catch (err) {
    console.error('归档失败:', err);
  } finally {
    await conn.end();
    await redis.quit();
    process.exit(0);
  }
}

archive().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
