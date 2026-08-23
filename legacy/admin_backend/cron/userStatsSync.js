/**
 * 用户相关指标同步服务
 * 从 Redis 读取 website_backend 写入的实时统计数据，同步到 unified_stats
 */
const { query } = require('../db/init');
const redis = require('../db/redis');

// 分布式锁配置
const USER_LOCK_KEY = 'cron:user_stats_sync:lock';
const LOCK_TTL_SECONDS = 300;

/**
 * 格式化日期 YYYY-MM-DD
 */
function formatDate(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/**
 * 尝试获取分布式锁
 */
async function acquireLock() {
  const timestamp = Date.now();
  const lockValue = `${process.pid}-${timestamp}`;
  const result = await redis.set(USER_LOCK_KEY, lockValue, 'EX', LOCK_TTL_SECONDS, 'NX');

  if (result === 'OK') {
    console.log(`[UserStatsSync] 获取分布式锁成功: ${lockValue}`);
    return { acquired: true, value: lockValue };
  }
  return { acquired: false, value: null };
}

/**
 * 释放分布式锁
 */
async function releaseLock(lockValue) {
  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(luaScript, 1, USER_LOCK_KEY, lockValue);
}

/**
 * 保存指标到 unified_stats
 */
async function saveMetric(date, dimType, dim1Key, dim2Key, metricName, metricValue) {
  await query(`
    INSERT INTO unified_stats
      (stat_date, dim_type, dim1_key, dim2_key, metric_name, metric_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      metric_value = VALUES(metric_value),
      updated_at = NOW()
  `, [date, dimType, dim1Key, dim2Key || '', metricName, metricValue]);
}

/**
 * 从 Redis 同步用户全局统计数据
 * website_backend 写入的 key: stats:user:global:{date}
 */
async function syncUserGlobalStats(date) {
  console.log(`[UserStatsSync] 同步 ${date} 用户全局统计...`);

  const key = `stats:user:global:${date}`;
  const stats = await redis.hgetall(key);

  if (!stats || Object.keys(stats).length === 0) {
    console.log(`[UserStatsSync] 暂无用户统计数据`);
    return null;
  }

  const metrics = {
    new_users: parseInt(stats.new_users) || 0,
    logins: parseInt(stats.logins) || 0,
    tokens_created: parseInt(stats.tokens_created) || 0,
    balance_consumed: parseInt(stats.balance_consumed) || 0,
    balance_recharged: parseInt(stats.balance_recharged) || 0,
  };

  // 获取 HyperLogLog 统计的活跃用户数
  const activeUsers = await redis.pfcount(`stats:user:active:${date}`);
  const usersWithRequests = await redis.pfcount(`stats:user:requesters:${date}`);

  metrics.active_users = activeUsers;
  metrics.users_with_requests = usersWithRequests;

  // 写入 unified_stats
  for (const [name, value] of Object.entries(metrics)) {
    if (value > 0) {
      await saveMetric(date, 'user_global', 'user:global', null, name, value);
    }
  }

  console.log(`[UserStatsSync] 用户统计: 新用户=${metrics.new_users}, 活跃用户=${activeUsers}, 登录=${metrics.logins}`);
  return metrics;
}

/**
 * 从 Redis 同步充值统计数据
 * website_backend 写入的 key: stats:billing:{date}
 */
async function syncBillingStats(date) {
  console.log(`[UserStatsSync] 同步 ${date} 充值统计...`);

  const key = `stats:billing:${date}`;
  const stats = await redis.hgetall(key);

  if (!stats || Object.keys(stats).length === 0) {
    console.log(`[UserStatsSync] 暂无充值统计数据`);
    return null;
  }

  const metrics = {
    recharge_orders: parseInt(stats.orders_count) || 0,
    recharge_success: parseInt(stats.orders_success) || 0,
    recharge_failed: parseInt(stats.orders_failed) || 0,
    recharge_amount: parseInt(stats.amount_total) || 0,
  };

  // 获取充值用户数（HyperLogLog）
  const usersRecharged = await redis.pfcount(`stats:billing:users:${date}`);
  metrics.users_recharged = usersRecharged;

  // 写入 unified_stats
  for (const [name, value] of Object.entries(metrics)) {
    if (value > 0) {
      await saveMetric(date, 'billing', 'billing:global', null, name, value);
    }
  }

  console.log(`[UserStatsSync] 充值统计: 订单=${metrics.recharge_orders}(${metrics.recharge_success}成功), 金额=${metrics.recharge_amount}分, 充值用户=${usersRecharged}`);
  return metrics;
}

/**
 * 从 Redis 同步Token活跃统计数据
 * website_backend/api-relay 写入的 key: stats:tokens:active:{date}
 */
async function syncTokenStats(date) {
  console.log(`[UserStatsSync] 同步 ${date} Token统计...`);

  // 从 HyperLogLog 获取活跃Token数
  const activeTokens = await redis.pfcount(`stats:tokens:active:${date}`);

  // 从 user_global 获取创建的Token数
  const key = `stats:user:global:${date}`;
  const stats = await redis.hgetall(key);
  const tokensCreated = parseInt(stats?.tokens_created) || 0;

  const metrics = {
    tokens_created: tokensCreated,
    active_tokens: activeTokens,
  };

  // 写入 unified_stats
  for (const [name, value] of Object.entries(metrics)) {
    if (value > 0) {
      await saveMetric(date, 'user_global', 'user:global', null, name, value);
    }
  }

  console.log(`[UserStatsSync] Token统计: 创建=${tokensCreated}, 活跃=${activeTokens}`);
  return metrics;
}

/**
 * 同步单用户详细统计
 * website_backend 写入的 key: stats:user:{user_id}:{date}
 */
async function syncUserDetailStats(date) {
  console.log(`[UserStatsSync] 同步 ${date} 单用户详细统计...`);

  // 获取所有用户统计key
  const keys = await redis.keys(`stats:user:*:${date}`);
  const userKeys = keys.filter(k => {
    const parts = k.split(':');
    // 过滤掉 global 和 active/requesters 等特殊key
    return parts.length === 4 && parts[2] !== 'global' && !['active', 'requesters'].includes(parts[2]);
  });

  let userCount = 0;
  let totalRequests = 0;
  let totalQuota = 0;

  for (const key of userKeys) {
    const userId = key.split(':')[2];
    const stats = await redis.hgetall(key);

    if (!stats || Object.keys(stats).length === 0) continue;

    userCount++;
    const requests = parseInt(stats.requests) || 0;
    const quota = parseInt(stats.quota) || 0;
    totalRequests += requests;
    totalQuota += quota;

    // 写入 unified_stats (user_detail 维度)
    if (requests > 0) {
      await saveMetric(date, 'user_detail', `user:${userId}`, null, 'requests', requests);
    }
    if (quota > 0) {
      await saveMetric(date, 'user_detail', `user:${userId}`, null, 'quota_consumed', quota);
    }
  }

  // 计算平均值并写入全局
  const avgRequests = userCount > 0 ? Math.round(totalRequests / userCount) : 0;
  const avgQuota = userCount > 0 ? Math.round(totalQuota / userCount) : 0;

  if (userCount > 0) {
    await saveMetric(date, 'user_global', 'user:global', null, 'avg_requests_per_user', avgRequests);
    await saveMetric(date, 'user_global', 'user:global', null, 'avg_quota_per_user', avgQuota);
  }

  console.log(`[UserStatsSync] 单用户统计: ${userCount}个用户, 平均请求=${avgRequests}, 平均消费=${avgQuota}分`);
  return { userCount, avgRequests, avgQuota };
}

/**
 * 同步用户余额分布（从 MySQL 查询当前状态）
 */
async function syncUserBalanceStats(date) {
  console.log(`[UserStatsSync] 同步 ${date} 用户余额分布...`);

  // 有余额的用户数
  const [withQuotaRows] = await query(`
    SELECT COUNT(*) as count FROM user_users
    WHERE balance > 0 AND deleted_at IS NULL
  `);

  // 余额为0的用户数
  const [zeroQuotaRows] = await query(`
    SELECT COUNT(*) as count FROM user_users
    WHERE (balance <= 0 OR balance IS NULL) AND deleted_at IS NULL
  `);

  const withQuota = withQuotaRows?.count || 0;
  const zeroQuota = zeroQuotaRows?.count || 0;

  // 写入 unified_stats
  await saveMetric(date, 'user_global', 'user:global', null, 'users_with_quota', withQuota);
  await saveMetric(date, 'user_global', 'user:global', null, 'users_zero_quota', zeroQuota);

  console.log(`[UserStatsSync] 余额分布: 有余额=${withQuota}, 零余额=${zeroQuota}`);
  return { withQuota, zeroQuota };
}

/**
 * 执行完整的用户统计同步（从 Redis）
 */
async function syncUserStats(date) {
  const targetDate = date || formatDate();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[UserStatsSync] 开始同步 ${targetDate} 用户统计数据`);
  console.log(`${'='.repeat(60)}`);

  const startTime = Date.now();

  try {
    // 1. 用户全局统计（从 Redis）
    const userGlobalStats = await syncUserGlobalStats(targetDate);

    // 2. 充值统计（从 Redis）
    const billingStats = await syncBillingStats(targetDate);

    // 3. Token统计（从 Redis）
    const tokenStats = await syncTokenStats(targetDate);

    // 4. 单用户详细统计（从 Redis）
    const userDetailStats = await syncUserDetailStats(targetDate);

    // 5. 用户余额分布（从 MySQL，这是当前状态而非增量）
    const balanceStats = await syncUserBalanceStats(targetDate);

    const duration = Date.now() - startTime;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[UserStatsSync] 用户统计同步完成`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  日期: ${targetDate}`);
    console.log(`  耗时: ${duration}ms`);
    console.log(`  新用户: ${userGlobalStats?.new_users || 0}`);
    console.log(`  活跃用户: ${userGlobalStats?.active_users || 0}`);
    console.log(`  Token创建: ${tokenStats?.tokens_created || 0}`);
    console.log(`  充值金额: ${billingStats?.recharge_amount || 0}分`);
    console.log(`${'='.repeat(60)}\n`);

    return {
      success: true,
      date: targetDate,
      userGlobalStats,
      billingStats,
      tokenStats,
      userDetailStats,
      balanceStats,
      duration
    };

  } catch (err) {
    console.error(`[UserStatsSync] 同步失败:`, err.message);
    throw err;
  }
}

/**
 * 带锁的同步包装器
 */
async function runUserStatsSync(date) {
  const lock = await acquireLock();
  if (!lock.acquired) {
    console.log('[UserStatsSync] 已有实例在运行，跳过');
    return { skipped: true, reason: 'lock_held' };
  }

  try {
    const result = await syncUserStats(date);
    return { success: true, ...result };
  } catch (error) {
    console.error('[UserStatsSync] 错误:', error.message);
    return { success: false, error: error.message };
  } finally {
    await releaseLock(lock.value);
  }
}

module.exports = {
  syncUserStats,
  runUserStatsSync,
  syncUserGlobalStats,
  syncBillingStats,
  syncTokenStats
};
