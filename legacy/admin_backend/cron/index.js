/**
 * Cron 任务调度入口
 *
 * 1. 每分钟同步今天 Redis 统计数据到 MySQL（实时看板）
 * 2. 自动检测并同步缺失的历史数据
 * 3. 每天凌晨 3 点执行历史数据归档
 */
const cron = require('node-cron');
const { runDailyArchive } = require('./dailyArchive');
const { runTodaySync, runStatsSync, syncService } = require('./syncStats');
const { runUserStatsSync } = require('./userStatsSync');
const redis = require('../db/redis');

// 是否在运行
let isArchiveRunning = false;
let isSyncRunning = false;
let isHistorySyncRunning = false;

/**
 * 运行归档任务（包装器）
 */
async function runArchiveWithLock() {
  if (isArchiveRunning) {
    console.log('[Cron] Archive task already running, skipping...');
    return;
  }

  isArchiveRunning = true;
  try {
    await runDailyArchive();
  } finally {
    isArchiveRunning = false;
  }
}

/**
 * 运行实时同步任务（包装器）
 */
async function runSyncWithLock() {
  if (isSyncRunning) {
    console.log('[Cron] Stats sync already running, skipping...');
    return;
  }

  isSyncRunning = true;
  try {
    await runTodaySync();
  } finally {
    isSyncRunning = false;
  }
}

/**
 * 检测 Redis 中有但 MySQL 中缺失的历史日期
 * 返回需要同步的日期列表（最近30天内）
 */
async function findMissingSyncDates() {
  const dates = [];
  const today = new Date();

  // 检查最近30天
  for (let i = 1; i <= 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    // 检查 Redis 是否有该日期的数据
    const redisKey = `stats:global:${dateStr}`;
    const redisData = await redis.hgetall(redisKey);

    if (redisData && redisData.requests && parseInt(redisData.requests) > 0) {
      // Redis 有数据，检查 MySQL 是否已同步
      const { query } = require('../db/init');
      const rows = await query(`
        SELECT COUNT(*) as count FROM unified_stats
        WHERE stat_date = ? AND dim_type = 'global' AND metric_name = 'requests'
      `, [dateStr]);

      if (!rows || rows[0].count === 0) {
        dates.push(dateStr);
      }
    }
  }

  return dates;
}

/**
 * 同步历史缺失数据
 */
async function syncMissingHistory() {
  if (isHistorySyncRunning) {
    console.log('[Cron] History sync already running, skipping...');
    return;
  }

  isHistorySyncRunning = true;
  console.log('[Cron] Checking for missing historical data...');

  try {
    const missingDates = await findMissingSyncDates();

    if (missingDates.length === 0) {
      console.log('[Cron] No missing historical data found');
      return;
    }

    console.log(`[Cron] Found ${missingDates.length} days of missing data: ${missingDates.join(', ')}`);

    // 逐个同步缺失的日期
    for (const date of missingDates) {
      console.log(`[Cron] Syncing missing data for ${date}...`);
      const result = await runStatsSync(date);

      if (result.success && !result.skipped) {
        console.log(`[Cron] ✓ Synced ${date}: ${result.records} records, ${result.requests} requests`);
      } else if (result.skipped) {
        console.log(`[Cron] ⏭️  Skipped ${date}: ${result.reason}`);
      } else {
        console.log(`[Cron] ✗ Failed to sync ${date}: ${result.error}`);
      }

      // 间隔1秒，避免压力过大
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('[Cron] History sync completed');
  } catch (err) {
    console.error('[Cron] History sync error:', err.message);
  } finally {
    isHistorySyncRunning = false;
  }
}

/**
 * 初始化定时任务
 */
function initCronJobs() {
  // 1. 每5分钟同步今天的数据（实时看板）
  cron.schedule('*/5 * * * *', () => {
    console.log('[Cron] Real-time stats sync triggered at', new Date().toISOString());
    runSyncWithLock();
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  console.log('[Cron] Scheduled real-time stats sync every 5 minutes');

  // 2. 每5分钟检查并同步缺失的历史数据
  cron.schedule('*/5 * * * *', () => {
    console.log('[Cron] History sync check triggered at', new Date().toISOString());
    syncMissingHistory();
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  console.log('[Cron] Scheduled history sync check every 5 minutes');

  // 3. 每天凌晨 3 点执行数据归档（转移到历史表）
  cron.schedule('0 3 * * *', () => {
    console.log('[Cron] Daily archive triggered at', new Date().toISOString());
    runArchiveWithLock();
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  console.log('[Cron] Scheduled daily archive at 03:00 Asia/Shanghai');

  // 4. 每5分钟同步用户相关统计数据
  cron.schedule('*/5 * * * *', () => {
    console.log('[Cron] User stats sync triggered at', new Date().toISOString());
    runUserStatsSync();
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  console.log('[Cron] Scheduled user stats sync every 5 minutes');

  // 5. 服务启动时立即检查一次缺失数据（延迟10秒等待连接就绪）
  setTimeout(() => {
    console.log('[Cron] Initial history sync check on startup...');
    syncMissingHistory();
  }, 10000);

  // 返回手动触发方法
  return {
    triggerArchive: runArchiveWithLock,
    triggerSync: runSyncWithLock,
    triggerHistorySync: syncMissingHistory,
    triggerUserStatsSync: runUserStatsSync
  };
}

module.exports = { initCronJobs };
