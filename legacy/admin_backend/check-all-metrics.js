/**
 * 检查所有度量指标（完整版）
 */
const Redis = require('ioredis');
const redis = new Redis({ host: 'localhost', port: 6379, db: 0 });

async function checkAllMetrics() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`📊 实时统计指标检查 - ${today}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  // 1. 全局概览
  console.log('📈 【全局概览】');
  const global = await redis.hgetall(`stats:global:${today}`);
  if (global.requests) {
    const latencyCount = parseInt(global.latency_count) || 1;
    const latencySum = parseInt(global.latency_sum) || 0;
    console.log(`   请求总数: ${global.requests}`);
    console.log(`   成功/失败: ${global.success || 0} / ${global.error || 0}`);
    console.log(`   消费额度: ${((global.quota || 0) / 100000).toFixed(2)} 元`);
    console.log(`   Token消耗: 输入=${global.prompt_tokens || 0}, 输出=${global.completion_tokens || 0}`);
    console.log(`   平均延迟: ${Math.round(latencySum / latencyCount)} ms`);
    console.log(`   延迟范围: ${global.latency_min || 0} - ${global.latency_max || 0} ms`);
  } else {
    console.log('   ⚠️ 暂无数据');
  }

  // 2. 日活统计
  console.log('\n👥 【活跃度统计】');
  const dau = await redis.pfcount(`stats:dau:${today}`);
  const tau = await redis.pfcount(`stats:tau:${today}`);
  const cau = await redis.pfcount(`stats:cau:${today}`);
  console.log(`   日活用户(DAU): ${dau}`);
  console.log(`   日活Token(TAU): ${tau}`);
  console.log(`   日活渠道(CAU): ${cau}`);

  // 3. 延迟分布
  console.log('\n⏱️ 【延迟分布】');
  const buckets = [
    { key: 'latency_bucket_0_100', label: '0-100ms', desc: '极快' },
    { key: 'latency_bucket_100_300', label: '100-300ms', desc: '很快' },
    { key: 'latency_bucket_300_500', label: '300-500ms', desc: '快' },
    { key: 'latency_bucket_500_1000', label: '500ms-1s', desc: '正常' },
    { key: 'latency_bucket_1000_2000', label: '1-2s', desc: '较慢' },
    { key: 'latency_bucket_2000_5000', label: '2-5s', desc: '慢' },
    { key: 'latency_bucket_5000_plus', label: '5s+', desc: '极慢' }
  ];

  let hasLatencyData = false;
  for (const bucket of buckets) {
    const value = parseInt(global[bucket.key]) || 0;
    if (value > 0) {
      hasLatencyData = true;
      const bar = '█'.repeat(Math.min(value, 20));
      console.log(`   ${bucket.label.padEnd(12)} ${bar} ${value} ${bucket.desc}`);
    }
  }
  if (!hasLatencyData) {
    console.log('   ⚠️ 暂无延迟分布数据');
  }

  // 4. 渠道统计
  console.log('\n📡 【渠道统计】');
  const channelKeys = (await redis.keys(`stats:channel:*:${today}`))
    .filter(key => key.split(':').length === 4);

  for (const key of channelKeys) {
    const channelId = key.split(':')[2];
    const data = await redis.hgetall(key);
    const latencyCount = parseInt(data.latency_count) || 1;
    const latencySum = parseInt(data.latency_sum) || 0;
    const online = parseInt(data.online) || 1;
    const healthScore = data.health_score || 'N/A';

    console.log(`   渠道 ${channelId}: ${data.channel_name || '未命名'}`);
    console.log(`      状态: ${online === 1 ? '🟢 在线' : '🔴 离线'}, 健康分: ${healthScore}`);
    console.log(`      请求: ${data.requests || 0}, 消费: ${((data.quota || 0) / 100000).toFixed(2)}元`);
    console.log(`      延迟: ${Math.round(latencySum / latencyCount)} ms`);
  }

  // 5. Token排行
  console.log('\n🔑 【Token消费排行】');
  const tokenRanking = await redis.zrevrange(`stats:rank:token:quota:${today}`, 0, 4, 'WITHSCORES');
  if (tokenRanking.length > 0) {
    for (let i = 0; i < tokenRanking.length; i += 2) {
      const tokenKey = tokenRanking[i];
      const tokenId = tokenKey.split(':')[1];
      const quota = parseInt(tokenRanking[i + 1]);
      const data = await redis.hgetall(`stats:token:${tokenId}:${today}`);
      console.log(`   #${i/2 + 1} Token ${tokenId}: ${((quota || 0) / 100000).toFixed(2)}元 (${data.token_name || '未命名'})`);
    }
  } else {
    console.log('   ⚠️ 暂无Token排行数据');
  }

  // 6. 模型排行
  console.log('\n🤖 【模型消费排行】');
  const modelRanking = await redis.zrevrange(`stats:rank:model:quota:${today}`, 0, 9, 'WITHSCORES');
  if (modelRanking.length > 0) {
    for (let i = 0; i < modelRanking.length; i += 2) {
      const model = modelRanking[i];
      const quota = parseInt(modelRanking[i + 1]);
      const data = await redis.hgetall(`stats:model:${model}:${today}`);
      const bar = '█'.repeat(Math.min(Math.round(quota / Math.max(parseInt(modelRanking[1]), 1) * 20), 20));
      console.log(`   ${model.padEnd(25)} ${bar} ${((quota || 0) / 100000).toFixed(2)}元 (${data.requests || 0}次)`);
    }
  } else {
    console.log('   ⚠️ 暂无模型排行数据');
  }

  // 7. 小时趋势
  console.log('\n📉 【今日小时趋势】');
  let hourData = [];
  for (let hour = 0; hour < 24; hour++) {
    const data = await redis.hgetall(`stats:hourly:${today}:${hour}`);
    if (data.requests) {
      hourData.push({ hour, requests: parseInt(data.requests), quota: parseInt(data.quota) });
    }
  }

  if (hourData.length > 0) {
    const maxRequests = Math.max(...hourData.map(h => h.requests));
    for (const h of hourData) {
      const bar = '█'.repeat(Math.round((h.requests / Math.max(maxRequests, 1)) * 30));
      console.log(`   ${h.hour.toString().padStart(2, '0')}:00 ${bar} ${h.requests}次 (${(h.quota / 100000).toFixed(2)}元)`);
    }
  } else {
    console.log('   ⚠️ 暂无小时数据');
  }

  // 8. 错误率统计
  console.log('\n⚠️ 【错误统计】');
  const success = parseInt(global.success) || 0;
  const error = parseInt(global.error) || 0;
  const total = success + error;
  if (total > 0) {
    const errorRate = ((error / total) * 100).toFixed(2);
    console.log(`   成功率: ${((success / total) * 100).toFixed(2)}%`);
    console.log(`   错误率: ${errorRate}%`);
    console.log(`   失败数: ${error} / ${total}`);
  } else {
    console.log('   暂无请求数据');
  }

  console.log('\n═══════════════════════════════════════════════════\n');
  await redis.quit();
  process.exit(0);
}

checkAllMetrics().catch(err => {
  console.error('检查失败:', err);
  process.exit(1);
});
