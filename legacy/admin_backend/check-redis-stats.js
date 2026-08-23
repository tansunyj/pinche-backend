const redis = require('../api-relay/db/redis');

async function checkStats() {
  const date = '2026-05-22';
  
  console.log('📊 检查 Redis 统计数据\n');
  
  // 1. 全局统计
  const global = await redis.hgetall(`stats:global:${date}`);
  console.log('📈 全局统计:', global);
  
  // 2. 渠道统计
  const channel = await redis.hgetall(`stats:channel:2:${date}`);
  console.log('📡 渠道2统计:', channel);
  
  // 3. Token统计
  const token = await redis.hgetall(`stats:token:21:${date}`);
  console.log('🔑 Token21统计:', token);
  
  // 4. 模型统计
  const model = await redis.hgetall(`stats:model:qwen3.6-plus:${date}`);
  console.log('🤖 模型 qwen3.6-plus 统计:', model);
  
  // 5. 复合统计
  const composite = await redis.hgetall(`stats:composite:ch:2:md:qwen3.6-plus:${date}`);
  console.log('🔗 复合统计(渠道2+模型):', composite);
  
  // 计算今日消费
  const quota = parseInt(global.quota || 0);
  const yuan = (quota / 100000).toFixed(4);
  console.log(`\n💰 今日消费: ¥${yuan} (${global.requests || 0} 次请求)`);
  
  process.exit(0);
}

checkStats().catch(console.error);
