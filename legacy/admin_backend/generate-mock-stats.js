/**
 * 生成逼真的 Mock 统计数据 - 国内模型版本
 * 执行: node generate-mock-stats.js
 */
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 手动加载 .env.development 文件
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

// ==================== 配置 ====================
const CONFIG = {
  days: 21,
  // 国内模型列表 - DeepSeek 和 Qwen 占比较高
  models: [
    // DeepSeek 系列 - 高流量（占比最高）
    { id: 'deepseek-chat', name: 'DeepSeek Chat', inputPrice: 2, outputPrice: 8, dailyTokens: 5000000000, weight: 0.25 },
    { id: 'deepseek-coder', name: 'DeepSeek Coder', inputPrice: 2, outputPrice: 8, dailyTokens: 3000000000, weight: 0.15 },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', inputPrice: 4, outputPrice: 16, dailyTokens: 1600000000, weight: 0.08 },

    // Qwen 系列 - 高流量（占比次高）
    { id: 'qwen-max', name: 'Qwen Max', inputPrice: 2, outputPrice: 6, dailyTokens: 2400000000, weight: 0.12 },
    { id: 'qwen-plus', name: 'Qwen Plus', inputPrice: 0.8, outputPrice: 2, dailyTokens: 2000000000, weight: 0.10 },
    { id: 'qwen-turbo', name: 'Qwen Turbo', inputPrice: 0.3, outputPrice: 0.6, dailyTokens: 1600000000, weight: 0.08 },
    { id: 'qwen3.5', name: 'Qwen 3.5', inputPrice: 0.5, outputPrice: 1, dailyTokens: 1200000000, weight: 0.06 },

    // Kimi 系列
    { id: 'kimi-k1.5', name: 'Kimi K1.5', inputPrice: 3, outputPrice: 12, dailyTokens: 800000000, weight: 0.04 },
    { id: 'kimi-moonshot', name: 'Kimi Moonshot', inputPrice: 2, outputPrice: 8, dailyTokens: 600000000, weight: 0.03 },

    // GLM 系列
    { id: 'glm-4', name: 'GLM-4', inputPrice: 1, outputPrice: 2, dailyTokens: 400000000, weight: 0.02 },
    { id: 'glm-3-turbo', name: 'GLM-3 Turbo', inputPrice: 0.5, outputPrice: 1, dailyTokens: 300000000, weight: 0.02 },

    // Embedding 模型
    { id: 'embedding-2', name: 'BGE Embedding', inputPrice: 0.1, outputPrice: 0, dailyTokens: 1000000000, weight: 0.03 },
  ],
  // 虚拟渠道配置 - 生成 40 个
  virtualChannels: [],
  // 虚拟令牌配置 - 生成 2500 个
  virtualTokens: [],
};

// 1元 = 100000 额度
const QUOTA_PER_YUAN = 100000;

// 目标日均消费约 3800 元
const TARGET_DAILY_QUOTA = 3800 * QUOTA_PER_YUAN;

// ==================== 生成虚拟渠道和令牌 ====================
function generateVirtualConfigs() {
  // 生成 40 个虚拟渠道
  const channelTypes = ['openai', 'azure', 'ali', 'deepseek', 'kimi', 'custom'];
  const channelNames = [
    '阿里云百炼', '百度智能云', '腾讯云TI', '火山引擎', '智谱AI',
    'DeepSeek官方', 'Kimi官方', 'MiniMax', '商汤日日新', '讯飞星火',
    '华为云', '天翼云', '移动云', '联通云', '京东云',
    'AWS中国', 'Azure中国', 'Google中国', 'Oracle中国', 'IBM中国'
  ];

  for (let i = 1; i <= 40; i++) {
    const type = channelTypes[i % channelTypes.length];
    const nameBase = channelNames[i % channelNames.length];
    CONFIG.virtualChannels.push({
      id: i,
      name: `${nameBase}-${Math.ceil(i / 20)}`,
      type: type
    });
  }

  // 生成 2500 个虚拟令牌
  const tokenPrefixes = ['prod', 'dev', 'test', 'staging', 'api', 'sdk', 'web', 'mobile', 'partner', 'internal'];
  const tokenUsers = [
    '用户服务', '订单服务', '支付服务', '消息服务', '搜索服务',
    '推荐服务', '分析服务', '报表服务', '监控服务', '日志服务',
    'Web前端', '移动端', '小程序', 'H5页面', '管理后台',
    '数据平台', 'AI平台', '测试团队', '运维团队', '开发团队'
  ];

  for (let i = 1; i <= 2500; i++) {
    const prefix = tokenPrefixes[i % tokenPrefixes.length];
    const user = tokenUsers[i % tokenUsers.length];
    const groupNum = Math.ceil(i / 100);
    CONFIG.virtualTokens.push({
      id: i,
      name: `${prefix}-${user}-key-${groupNum}`,
      user: `team-${groupNum}`
    });
  }

  console.log(`📋 虚拟配置生成: ${CONFIG.virtualChannels.length} 个渠道, ${CONFIG.virtualTokens.length} 个令牌`);
}

// ==================== 数据库连接 ====================
async function createDbConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'silievo',
  });
}

// ==================== 辅助函数 ====================
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function calculateQuota(tokens, pricePerM) {
  return Math.floor((tokens * pricePerM * QUOTA_PER_YUAN) / 1000000);
}

// ==================== 生成单日的全局统计数据 ====================
function generateDailyGlobalStats(date, dateStr, dayIndex) {
  const stats = [];
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  const weekendFactor = isWeekend ? 0.75 : 1.0;
  const growthFactor = 1 + (dayIndex * 0.015);

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalQuota = 0;
  let totalRequests = 0;

  // 计算所有模型的总 quota
  let modelQuotaSum = 0;
  const modelResults = CONFIG.models.map(model => {
    const factor = randomFloat(0.85, 1.15) * weekendFactor * growthFactor;
    const modelTokens = Math.floor(model.dailyTokens * factor);
    const promptRatio = randomFloat(0.65, 0.78);
    const promptTokens = Math.floor(modelTokens * promptRatio);
    const completionTokens = modelTokens - promptTokens;
    const requests = Math.floor(modelTokens / randomInt(1800, 2200));
    const quota = calculateQuota(promptTokens, model.inputPrice) + calculateQuota(completionTokens, model.outputPrice);
    return { model, promptTokens, completionTokens, requests, quota };
  });

  modelResults.forEach(r => {
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalQuota += r.quota;
    totalRequests += r.requests;
  });

  // 调整比例以接近目标日均消费 3800 元
  const targetQuota = TARGET_DAILY_QUOTA * randomFloat(0.9, 1.1);
  const adjustRatio = targetQuota / totalQuota;
  totalQuota = Math.floor(totalQuota * adjustRatio);
  totalPromptTokens = Math.floor(totalPromptTokens * adjustRatio);
  totalCompletionTokens = Math.floor(totalCompletionTokens * adjustRatio);
  totalRequests = Math.floor(totalRequests * adjustRatio);

  // 全局指标
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'requests', value: totalRequests });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'quota', value: totalQuota });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'prompt_tokens', value: totalPromptTokens });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'completion_tokens', value: totalCompletionTokens });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'success', value: Math.floor(totalRequests * 0.985) });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'error', value: Math.floor(totalRequests * 0.015) });

  // 延迟统计
  const avgLatency = randomInt(280, 650);
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'latency_count', value: totalRequests });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'latency_sum', value: avgLatency * totalRequests });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'latency_min', value: randomInt(45, 120) });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'latency_max', value: randomInt(2500, 6000) });

  // 延迟分布桶
  const buckets = {
    'latency_bucket_0_100': 0.08,
    'latency_bucket_100_300': 0.35,
    'latency_bucket_300_500': 0.32,
    'latency_bucket_500_1000': 0.18,
    'latency_bucket_1000_2000': 0.055,
    'latency_bucket_2000_5000': 0.013,
    'latency_bucket_5000_plus': 0.002,
  };

  for (const [bucket, ratio] of Object.entries(buckets)) {
    stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: bucket, value: Math.floor(totalRequests * ratio) });
  }

  const avgRtt = avgLatency + randomInt(40, 120);
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'rtt_count', value: totalRequests });
  stats.push({ date, dim_type: 'global', dim1_key: 'global', metric_name: 'rtt_sum', value: avgRtt * totalRequests });

  return { stats, totalPromptTokens, totalCompletionTokens, totalQuota, totalRequests };
}

// ==================== 生成模型维度的统计数据 ====================
function generateDailyModelStats(date, dateStr, dayIndex) {
  const stats = [];
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  const weekendFactor = isWeekend ? 0.75 : 1.0;
  const growthFactor = 1 + (dayIndex * 0.015);

  CONFIG.models.forEach(model => {
    const factor = randomFloat(0.85, 1.15) * weekendFactor * growthFactor;
    const modelTokens = Math.floor(model.dailyTokens * factor);
    const promptRatio = randomFloat(0.65, 0.78);
    const promptTokens = Math.floor(modelTokens * promptRatio);
    const completionTokens = modelTokens - promptTokens;
    const requests = Math.floor(modelTokens / randomInt(1800, 2200));
    const quota = calculateQuota(promptTokens, model.inputPrice) + calculateQuota(completionTokens, model.outputPrice);

    const dimKey = `md:${model.id}`;
    stats.push({ date, dim_type: 'model', dim1_key: dimKey, metric_name: 'requests', value: requests });
    stats.push({ date, dim_type: 'model', dim1_key: dimKey, metric_name: 'quota', value: quota });
    stats.push({ date, dim_type: 'model', dim1_key: dimKey, metric_name: 'prompt_tokens', value: promptTokens });
    stats.push({ date, dim_type: 'model', dim1_key: dimKey, metric_name: 'completion_tokens', value: completionTokens });
    stats.push({ date, dim_type: 'model', dim1_key: dimKey, metric_name: 'unique_tokens', value: Math.floor(requests * 0.25) });
  });

  return stats;
}

// ==================== 生成渠道维度的统计数据（40个渠道） ====================
function generateDailyChannelStats(date, dateStr, dayIndex) {
  const stats = [];
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  const weekendFactor = isWeekend ? 0.75 : 1.0;
  const growthFactor = 1 + (dayIndex * 0.015);

  // 根据渠道分配不同的流量权重
  const totalTokens = CONFIG.models.reduce((sum, m) => sum + m.dailyTokens, 0);

  // 前 10 个渠道占主要流量，其余分散
  const channelWeights = [];
  for (let i = 0; i < 40; i++) {
    if (i < 5) channelWeights.push(0.12);      // 前 5 个占 60%
    else if (i < 10) channelWeights.push(0.03); // 接下来 5 个占 15%
    else channelWeights.push(0.00625);          // 其余 30 个占 25%
  }

  CONFIG.virtualChannels.forEach((channel, index) => {
    const weight = channelWeights[index] || 0.005;
    const factor = randomFloat(0.75, 1.25) * weekendFactor * growthFactor;
    const channelTokens = Math.floor(totalTokens * weight * factor);
    const promptTokens = Math.floor(channelTokens * 0.7);
    const completionTokens = channelTokens - promptTokens;
    const requests = Math.floor(channelTokens / 2000);
    const quota = calculateQuota(channelTokens, 2.5);

    const dimKey = `ch:${channel.id}`;
    const success = Math.floor(requests * 0.985);
    const error = requests - success;
    const avgLatency = randomInt(250, 700);

    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'requests', value: requests });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'quota', value: quota });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'prompt_tokens', value: promptTokens });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'completion_tokens', value: completionTokens });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'success', value: success });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'error', value: error });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'latency_count', value: requests });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'latency_sum', value: avgLatency * requests });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'online', value: 1 });

    const meta = JSON.stringify({
      channel_name: channel.name,
      channel_type: channel.type,
    });
    stats.push({ date, dim_type: 'channel', dim1_key: dimKey, metric_name: 'meta', value: 0, meta_json: meta });
  });

  return stats;
}

// ==================== 生成Token维度的统计数据（2500个令牌） ====================
function generateDailyTokenStats(date, dateStr, dayIndex) {
  const stats = [];
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  const weekendFactor = isWeekend ? 0.75 : 1.0;
  const growthFactor = 1 + (dayIndex * 0.015);

  const totalTokens = CONFIG.models.reduce((sum, m) => sum + m.dailyTokens, 0);

  // 生成帕累托分布 - 20% 的令牌产生 80% 的流量
  CONFIG.virtualTokens.forEach((token, index) => {
    // 排名越靠前权重越高（帕累托分布近似）
    const rank = index + 1;
    const paretoWeight = Math.pow(rank, -0.8); // 帕累托指数
    const normalizedWeight = paretoWeight / 50; // 归一化

    const factor = randomFloat(0.5, 1.5) * weekendFactor * growthFactor;
    const tokenTokens = Math.floor(totalTokens * normalizedWeight * factor);

    // 小流量令牌也要有数据
    const finalTokens = Math.max(tokenTokens, randomInt(10000, 100000));
    const promptTokens = Math.floor(finalTokens * 0.7);
    const completionTokens = finalTokens - promptTokens;
    const requests = Math.floor(finalTokens / randomInt(1500, 2500));
    const quota = calculateQuota(finalTokens, 2.5);

    const dimKey = `tk:${token.id}`;
    const meta = JSON.stringify({
      token_name: token.name,
      user_id: token.id * 10,
    });

    stats.push({ date, dim_type: 'token', dim1_key: dimKey, metric_name: 'requests', value: requests });
    stats.push({ date, dim_type: 'token', dim1_key: dimKey, metric_name: 'quota', value: quota });
    stats.push({ date, dim_type: 'token', dim1_key: dimKey, metric_name: 'prompt_tokens', value: promptTokens });
    stats.push({ date, dim_type: 'token', dim1_key: dimKey, metric_name: 'completion_tokens', value: completionTokens });
    stats.push({ date, dim_type: 'token', dim1_key: dimKey, metric_name: 'meta', value: 0, meta_json: meta });
  });

  return stats;
}

// ==================== 生成 proxy_logs 记录 ====================
function generateProxyLogs(date, count) {
  const logs = [];
  const models = CONFIG.models;
  const channels = CONFIG.virtualChannels;
  const tokens = CONFIG.virtualTokens;

  const statuses = ['success', 'success', 'success', 'success', 'success', 'success',
                    'success', 'success', 'success', 'success', 'success', 'success',
                    'success', 'success', 'success', 'success', 'success', 'success',
                    'success', 'error'];

  const cstOffset = 8 * 60 * 60 * 1000;
  const baseTime = new Date(date.getTime() + cstOffset);
  baseTime.setHours(0, 0, 0, 0);

  // 优先选择热门模型
  const weightedModels = [];
  models.forEach(m => {
    const weight = Math.floor((m.weight || 0.05) * 100);
    for (let i = 0; i < weight; i++) weightedModels.push(m);
  });

  for (let i = 0; i < count; i++) {
    // 根据权重选择模型
    const model = weightedModels[randomInt(0, weightedModels.length - 1)] || models[0];
    // 随机选择渠道和令牌
    const channel = channels[randomInt(0, channels.length - 1)];
    // 令牌按帕累托分布选择
    const tokenIndex = Math.floor(Math.pow(Math.random(), 2) * tokens.length);
    const token = tokens[tokenIndex] || tokens[0];
    const status = statuses[randomInt(0, statuses.length - 1)];

    const promptTokens = randomInt(200, 8000);
    const completionTokens = randomInt(100, 4000);
    const quota = calculateQuota(promptTokens, model.inputPrice) + calculateQuota(completionTokens, model.outputPrice);

    const hour = randomInt(0, 23);
    const minute = randomInt(0, 59);
    const second = randomInt(0, 59);
    const logTime = new Date(baseTime);
    logTime.setHours(hour, minute, second);

    const latencyMs = randomInt(180, 2500);

    logs.push({
      request_id: `req_${Date.now()}_${i}`,
      channel_id: channel.id,
      channel_name: channel.name,
      token_id: token.id,
      token_name: token.name,
      model: model.id,
      status: status,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      quota_consumed: quota,
      latency_ms: latencyMs,
      created_at: logTime,
    });
  }

  return logs;
}

// ==================== 主函数 ====================
async function main() {
  console.log('🚀 开始生成 Mock 统计数据（国内模型版本）...\n');

  // 生成虚拟配置
  generateVirtualConfigs();

  const conn = await createDbConnection();
  console.log('✅ 数据库连接成功\n');

  try {
    // 清理旧数据
    console.log('🧹 清理旧数据...');
    const [statsResult] = await conn.execute('DELETE FROM unified_stats WHERE stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)', [CONFIG.days]);
    console.log(`   删除 unified_stats 记录: ${statsResult.affectedRows} 条`);

    const [logResult] = await conn.execute('DELETE FROM proxy_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', [CONFIG.days]);
    console.log(`   删除 proxy_logs 记录: ${logResult.affectedRows} 条\n`);

    // 生成统计数据
    console.log('📊 生成统计数据...');
    let totalStats = 0;

    for (let i = CONFIG.days - 1; i >= 0; i--) {
      const now = new Date();
      const cstOffset = 8 * 60 * 60 * 1000;
      const cstNow = new Date(now.getTime() + cstOffset);
      cstNow.setDate(cstNow.getDate() - i);
      cstNow.setHours(0, 0, 0, 0);

      const dayIndex = CONFIG.days - i;

      const year = cstNow.getFullYear();
      const month = String(cstNow.getMonth() + 1).padStart(2, '0');
      const day = String(cstNow.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const globalStats = generateDailyGlobalStats(cstNow, dateStr, dayIndex);
      const modelStats = generateDailyModelStats(cstNow, dateStr, dayIndex);
      const channelStats = generateDailyChannelStats(cstNow, dateStr, dayIndex);
      const tokenStats = generateDailyTokenStats(cstNow, dateStr, dayIndex);

      const allStats = [...globalStats.stats, ...modelStats, ...channelStats, ...tokenStats];

      const sql = `
        INSERT INTO unified_stats
        (stat_date, dim_type, dim1_key, metric_name, metric_value, meta_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `;

      for (const stat of allStats) {
        await conn.execute(sql, [
          dateStr,
          stat.dim_type,
          stat.dim1_key,
          stat.metric_name,
          stat.value,
          stat.meta_json || null,
        ]);
        totalStats++;
      }

      const logCount = randomInt(800, 1500);
      const logs = generateProxyLogs(cstNow, logCount);

      const logSql = `
        INSERT INTO proxy_logs
        (request_id, channel_id, channel_name, token_id, token_name, model, status,
         prompt_tokens, completion_tokens, quota_consumed, latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      for (const log of logs) {
        await conn.execute(logSql, [
          log.request_id,
          log.channel_id,
          log.channel_name,
          log.token_id,
          log.token_name,
          log.model,
          log.status,
          log.prompt_tokens,
          log.completion_tokens,
          log.quota_consumed,
          log.latency_ms,
          log.created_at,
        ]);
      }

      console.log(`   ${dateStr}: ${allStats.length} 条统计，${logs.length} 条日志`);
    }

    console.log(`\n✅ 统计生成完成！共 ${totalStats} 条统计记录`);

    // 汇总信息
    const [quotaSum] = await conn.execute(`
      SELECT SUM(metric_value) as total_quota
      FROM unified_stats
      WHERE dim_type = 'global' AND dim1_key = 'global' AND metric_name = 'quota' AND stat_hour IS NULL
    `);

    const totalQuota = quotaSum[0]?.total_quota || 0;
    const totalYuan = (totalQuota / QUOTA_PER_YUAN).toFixed(2);
    const avgDailyYuan = (totalQuota / QUOTA_PER_YUAN / CONFIG.days).toFixed(2);

    console.log('\n📈 数据汇总:');
    console.log(`   总消耗额度: ${totalQuota.toLocaleString()}`);
    console.log(`   总消耗金额: ¥${parseFloat(totalYuan).toLocaleString()} 元`);
    console.log(`   日均消费: ¥${avgDailyYuan} 元`);

  } catch (error) {
    console.error('❌ 生成数据失败:', error);
  } finally {
    await conn.end();
    console.log('\n👋 数据库连接已关闭');
  }
}

main().catch(console.error);
