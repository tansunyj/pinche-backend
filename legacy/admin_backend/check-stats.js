/**
 * 检查实时统计系统数据
 */
const Redis = require('ioredis');
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  db: 0
});

async function checkStats() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`\n========== 检查日期: ${today} ==========\n`);

  // 1. 检查全局统计
  console.log('1. 全局日统计 (stats:global:' + today + ')');
  const global = await redis.hgetall(`stats:global:${today}`);
  if (Object.keys(global).length === 0) {
    console.log('   ⚠️ 无数据');
  } else {
    console.log('   requests:', global.requests || 0);
    console.log('   quota:', global.quota || 0);
    console.log('   prompt_tokens:', global.prompt_tokens || 0);
    console.log('   completion_tokens:', global.completion_tokens || 0);
    console.log('   success:', global.success || 0);
    console.log('   error:', global.error || 0);
    console.log('   latency_count:', global.latency_count || 0);
    console.log('   latency_sum:', global.latency_sum || 0);
  }

  // 2. 检查日活统计
  console.log('\n2. 日活统计');
  const dau = await redis.pfcount(`stats:dau:${today}`);
  const tau = await redis.pfcount(`stats:tau:${today}`);
  const cau = await redis.pfcount(`stats:cau:${today}`);
  console.log('   日活用户:', dau);
  console.log('   日活Token:', tau);
  console.log('   日活渠道:', cau);

  // 3. 检查渠道统计
  console.log('\n3. 渠道统计');
  const channelKeys = (await redis.keys(`stats:channel:*:${today}`))
    .filter(key => key.split(':').length === 4); // 排除 tau/mau/cau HyperLogLog keys
  console.log(`   发现 ${channelKeys.length} 个渠道`);
  for (const key of channelKeys.slice(0, 3)) {
    const channelId = key.split(':')[2];
    const data = await redis.hgetall(key);
    console.log(`   渠道 ${channelId}: requests=${data.requests || 0}, quota=${data.quota || 0}, name=${data.channel_name || 'N/A'}`);
  }

  // 4. 检查Token统计
  console.log('\n4. Token统计');
  const tokenKeys = (await redis.keys(`stats:token:*:${today}`))
    .filter(key => key.split(':').length === 4);
  console.log(`   发现 ${tokenKeys.length} 个Token`);
  for (const key of tokenKeys.slice(0, 3)) {
    const tokenId = key.split(':')[2];
    const data = await redis.hgetall(key);
    console.log(`   Token ${tokenId}: requests=${data.requests || 0}, quota=${data.quota || 0}, name=${data.token_name || 'N/A'}`);
  }

  // 5. 检查模型统计
  console.log('\n5. 模型统计');
  const modelKeys = (await redis.keys(`stats:model:*:${today}`))
    .filter(key => key.split(':').length === 4);
  console.log(`   发现 ${modelKeys.length} 个模型`);
  for (const key of modelKeys.slice(0, 5)) {
    const model = key.split(':')[2];
    const data = await redis.hgetall(key);
    console.log(`   模型 ${model}: requests=${data.requests || 0}, quota=${data.quota || 0}`);
  }

  // 6. 检查模型排行
  console.log('\n6. 模型消费排行');
  const modelRanking = await redis.zrevrange(`stats:rank:model:quota:${today}`, 0, 4, 'WITHSCORES');
  for (let i = 0; i < modelRanking.length; i += 2) {
    console.log(`   ${modelRanking[i]}: ${modelRanking[i+1]}`);
  }

  // 7. 检查小时级统计
  console.log('\n7. 小时级统计 (最近3小时)');
  const now = new Date();
  for (let h = now.getHours() - 2; h <= now.getHours(); h++) {
    if (h < 0) continue;
    const data = await redis.hgetall(`stats:hourly:${today}:${h}`);
    if (data.requests) {
      console.log(`   ${h}:00: requests=${data.requests}, quota=${data.quota}`);
    }
  }

  // 8. 检查延迟分布
  console.log('\n8. 延迟分布');
  const latencyBuckets = ['0-100', '100-300', '300-500', '500-1000', '1000-2000', '2000-5000', '5000+'];
  for (const bucket of latencyBuckets) {
    const field = bucket === '5000+' ? 'latency_bucket_5000_plus' : `latency_bucket_${bucket.replace('-', '_')}`;
    const value = await redis.hget(`stats:global:${today}`, field);
    if (value) {
      console.log(`   ${bucket}ms: ${value}`);
    }
  }

  console.log('\n========== 检查完成 ==========\n');
  process.exit(0);
}

checkStats().catch(err => {
  console.error('检查失败:', err);
  process.exit(1);
});
