// 必须在所有其它 require 之前：按 NODE_ENV 加载对应的 .env.{development,production}
require('./utils/env');

const logger = require('./utils/logger');

// 启动日志
logger.startup('========================================');
logger.startup('应用启动中...');
logger.startup('NODE_ENV:', process.env.NODE_ENV);
logger.startup('LOG_LEVEL:', logger.getLevel());
logger.startup('DB_HOST:', process.env.DB_HOST);
logger.startup('DB_USER:', process.env.DB_USER);
logger.startup('DB_NAME:', process.env.DB_NAME);
logger.startup('========================================');

const express = require('express');
const path = require('path');
const cors = require('cors');
const { getDb, query } = require('./db/init');
const { getAllModels } = require('./utils/billing');
const authRoutes = require('./routes/auth');
const channelRoutes = require('./routes/channels');
const tokenRoutes = require('./routes/tokens');
const dashboardRoutes = require('./routes/dashboard');
const usersRoutes = require('./routes/users');
const { publicRouter: pricesPublic, adminRouter: pricesAdmin } = require('./routes/prices');
const { publicRouter: marketplacePublic, adminRouter: marketplaceAdmin } = require('./routes/marketplace');
const channelModelsRoutes = require('./routes/channel-models');
const channelTokensRoutes = require('./routes/channel-tokens');
const providerCapabilitiesRoutes = require('./routes/provider-capabilities');
const { publicRouter: discountsPublic, adminRouter: discountsAdmin } = require('./routes/discounts');
const { publicRouter: promotionsPublic, adminRouter: promotionsAdmin } = require('./routes/promotions');
const adminAuditRoutes = require('./routes/admin-audit');
const modelConfigsRoutes = require('./routes/model-configs');
const rechargesRoutes = require('./routes/recharges');
const adminReferralRoutes = require('./routes/admin-referral');
const userModelPermissionsRoutes = require('./routes/user-model-permissions');
const userModelDiscountsRoutes = require('./routes/user-model-discounts');
const packagesRoutes = require('./routes/packages');
const userPackageRoutes = require('./routes/user-package');
const publicPackagesRoutes = require('./routes/public-packages');
const audit = require('./services/AuditLogger');
const { initCronJobs } = require('./cron/index');
const { updateLastLoginMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;
let server;

// CORS 配置
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

app.use(express.json({ limit: process.env.BODY_LIMIT || '10mb' }));

// 更新用户最后登录时间中间件（针对携带有效用户 JWT 的请求）
app.use(updateLastLoginMiddleware);

// ==================== API 路由 ====================
// 约定：
//   /api/*        —— 公开接口（无需登录或仅校验用户身份）
//   /api/admin/*  —— 管理后台接口，统一带鉴权（authMiddleware）
//                    便于网关统一加 IP 白名单 / CORS / 限流策略

// ---- 公开接口 ----
app.use('/api/auth', authRoutes);                       // 注册 / 登录 / 改密
app.use('/api/prices', pricesPublic);                   // 模型价格列表（公开读）
app.use('/api/marketplace', marketplacePublic);         // 模型广场（公开读）
app.use('/api/discounts', discountsPublic);             // GET /active 公开
app.use('/api/user/package', userPackageRoutes);       // 用户套餐查询（需要用户JWT）
app.use('/api/packages', publicPackagesRoutes);         // 公开套餐浏览 + 用户自助开通

// ---- 管理后台接口（鉴权由各 router 内部 authMiddleware 保证） ----
// 在所有 /api/admin/* 链路上挂审计自动落库中间件：
// 路由处理函数若设置 req.audit = {action, targetType, targetId, before, after}
// 则在响应 2xx 完成后异步写入 admin_audit_logs。
app.use('/api/admin', audit.attachAutoFlush());

app.use('/api/admin/channels', channelRoutes);
app.use('/api/admin/channels/:channelId/models', channelModelsRoutes);
app.use('/api/admin/channels/:channelId/tokens', channelTokensRoutes);
app.use('/api/admin/provider-capabilities', providerCapabilitiesRoutes);
app.use('/api/admin/tokens', tokenRoutes);
app.use('/api/admin/users', usersRoutes);
app.use('/api/admin/dashboard', dashboardRoutes);
app.use('/api/admin/prices', pricesAdmin);              // POST /refresh
app.use('/api/admin/marketplace', marketplaceAdmin);
app.use('/api/admin/discounts', discountsAdmin);
app.use('/api/promotions', promotionsPublic);          // 公开：用户端领取活动
app.use('/api/admin/promotions', promotionsAdmin);     // 管理员：活动增删改查+派发
app.use('/api/admin/audit-logs', adminAuditRoutes);     // 审计日志查询
app.use('/api/admin/model-configs', modelConfigsRoutes); // 模型配置管理
app.use('/api/admin/recharges', rechargesRoutes);        // 充值记录管理
app.use('/api/admin/referral', adminReferralRoutes);     // 邀请奖励管理
app.use('/api/admin/user-model-permissions', userModelPermissionsRoutes); // 用户模型权限管理
app.use('/api/admin/user-model-discounts', userModelDiscountsRoutes);     // 用户模型优惠管理
app.use('/api/admin/packages', packagesRoutes);                           // 套餐管理

// 聚合模型列表
app.get('/api/models', async (req, res) => {
  try {
    const { type, provider } = req.query;

    // 从 model_library 表获取所有启用的模型
    const rows = await query('SELECT model_id, display_name, category FROM model_library WHERE status = 1');
    let models = Array.isArray(rows) ? rows : [];

    if (type) {
      models = models.filter(m => {
        if (type === 'chat') return m.category === 'text' || m.category === 'chat';
        if (type === 'image') return m.category === 'image' || m.model_id.includes('image') || m.model_id.includes('wan');
        if (type === 'video') return m.category === 'video' || m.model_id.includes('i2v') || m.model_id.includes('t2v');
        if (type === 'embedding') return m.category === 'embedding' || m.model_id.includes('embedding');
        return true;
      });
    }

    if (provider) {
      const providerMap = {
        ali: ['qwen', 'qvq', 'qwq', 'wan', 'qwen'],
        openai: ['gpt', 'o1', 'o3'],
        anthropic: ['claude'],
        deepseek: ['deepseek'],
        kimi: ['kimi'],
        gemini: ['gemini'],
      };
      const keywords = providerMap[provider] || [provider];
      models = models.filter(m =>
        keywords.some(k => m.model_id.toLowerCase().includes(k.toLowerCase()))
      );
    }

    const data = models.map(m => ({
      id: m.model_id,
      object: 'model',
      owned_by: 'silievo',
      created: 1626777600,
      category: m.category,
      display_name: m.display_name
    }));

    res.json({ success: true, data: data, count: data.length, total: data.length });
  } catch (e) {
    res.status(500).json({ success: false, error: { message: '获取模型列表失败', detail: e.message } });
  }
});

// 带渠道信息的模型列表（用于模型优惠配置）
app.get('/api/models-with-channels', async (req, res) => {
  try {
    // 查询所有启用的渠道及其关联的模型
    const rows = await query(`
      SELECT
        CONCAT(c.channel_code, '/', m.model_id) AS id,
        m.model_id,
        c.channel_code,
        c.name AS channel_name,
        ml.display_name,
        ml.category
      FROM proxy_channels c
      INNER JOIN proxy_channel_models m ON c.id = m.channel_id
      LEFT JOIN model_library ml ON m.model_id = ml.model_id
      WHERE c.status = 1 AND m.is_enabled = 1
      ORDER BY c.channel_code, m.model_id
    `);

    const models = Array.isArray(rows) ? rows : [];

    const data = models.map(m => ({
      id: m.id,
      model_id: m.model_id,
      channel_code: m.channel_code,
      channel_name: m.channel_name,
      display_name: m.display_name || m.model_id,
      category: m.category
    }));

    res.json({ success: true, data: data, count: data.length, total: data.length });
  } catch (e) {
    res.status(500).json({ success: false, error: { message: '获取带渠道模型列表失败', detail: e.message } });
  }
});

// 模型分组列表
app.get('/api/models/groups', (req, res) => {
  const groups = {
    '千问 Max': ['qwen-max', 'qwen3-max', 'qwen3.6-max-preview'],
    '千问 Plus': ['qwen-plus', 'qwen3.5-plus', 'qwen3.6-plus'],
    '千问 Flash': ['qwen-flash', 'qwen3.5-flash', 'qwen3.6-flash'],
    '千问 Turbo': ['qwen-turbo'],
    '千问 VL': ['qwen-vl-max', 'qwen-vl-plus', 'qwen3-vl-plus', 'qwen3-vl-flash'],
    '千问 Coder': ['qwen-coder-plus', 'qwen-coder-flash', 'qwen3-coder-plus', 'qwen3-coder-flash'],
    'QwQ 系列': ['qwq-plus', 'qwq-32b'],
    'QVQ 系列': ['qvq-max', 'qvq-plus', 'qvq-72b-preview'],
    'DeepSeek': ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3', 'deepseek-r1'],
    'Kimi': ['kimi-k2.5', 'kimi-k2.6'],
    'OpenAI': ['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'o1', 'o3-mini'],
    'Claude': ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
    'Gemini': ['gemini-2.0-flash', 'gemini-1.5-pro'],
  };
  res.json({ success: true, data: groups });
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    models: { total: getAllModels().length },
  });
});

// 系统信息
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Silievo API Relay Platform',
    version: '1.0.0',
    description: '统一聚合 API 接口平台 - 支持阿里云百炼全品类大模型',
    features: ['多模型路由分流', '阶梯计费支持', '思考模式加价', '实时账单统计', '令牌额度管理', '渠道优先级权重'],
    supported_providers: [
      { name: '阿里云百炼', code: 'ali', models: getAllModels().filter(m => m.startsWith('qwen')).length },
      { name: 'OpenAI', code: 'openai', models: getAllModels().filter(m => m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')).length },
      { name: 'Anthropic Claude', code: 'claude', models: getAllModels().filter(m => m.startsWith('claude')).length },
      { name: 'DeepSeek', code: 'deepseek', models: getAllModels().filter(m => m.startsWith('deepseek')).length },
      { name: 'Kimi/Moonshot', code: 'kimi', models: getAllModels().filter(m => m.startsWith('kimi')).length },
      { name: 'Google Gemini', code: 'gemini', models: getAllModels().filter(m => m.startsWith('gemini')).length },
    ],
  });
});

// ==================== 静态文件服务 ====================

const webDist = path.join(__dirname, '..', 'web', 'dist');
const fs = require('fs');

if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    // 跳过 API 路径，不返回 SPA
    if (req.path.startsWith('/v1/') || req.path.startsWith('/api/') || req.path.startsWith('/internal/')) {
      next();
    } else {
      res.sendFile(path.join(webDist, 'index.html'));
    }
  });
}

// 404 处理（所有未匹配的 API 路径）
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/') || req.path.startsWith('/internal/')) {
    res.status(404).json({
      error: {
        message: '该接口已迁移到 api-relay 服务 (端口 3002)',
        type: 'not_found',
        path: req.path,
      },
    });
  } else {
    next();
  }
});

// ==================== 启动服务 ====================

const start = async () => {
  try {
    // 确保连接池已初始化
    await getDb();

    server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
      console.log(`
  ════════════════════════════════════════════════════════════════
    🚀 Silievo API Relay Platform v1.1.0 (Stats Edition)
    📍 Dashboard: http://localhost:${PORT}
    🔌 API Base:  http://localhost:${PORT}/v1
    📊 Health:    http://localhost:${PORT}/api/health
    💰 Prices:    http://localhost:${PORT}/api/prices
  ════════════════════════════════════════════════════════════════
      `);
    });

    // 启动定时任务
    initCronJobs();
    console.log('[Cron] 定时任务已启动');
  } catch (err) {
    console.error('❌ 服务器启动失败:', err.message);
    process.exit(1);
  }
};

start();

// ==================== 进程管理 ====================

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

const gracefulShutdown = async (signal) => {
  console.log(`[Shutdown] 收到 ${signal}，正在安全关闭…`);
  server.close(async () => {
    console.log('[Shutdown] HTTP 服务器已停止接收新请求');
    try {
      const pool = await getDb();
      await pool.end();
      console.log('[Shutdown] MySQL 连接池已关闭');
    } catch (e) {
      console.error('[Shutdown] 连接池关闭异常:', e.message);
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[Shutdown] 超时强制退出');
    process.exit(1);
  }, 4000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [HTTP] ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// 错误处理中间件
app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [Server Error] 路径: ${req.path}`);
  console.error(`[${timestamp}] [Server Error] 错误:`, err.message);
  console.error(`[${timestamp}] [Server Error] 堆栈:`, err.stack);
  res.status(500).json({ error: { message: '服务器内部错误', type: 'internal_error', detail: err.message } });
});

module.exports = app;
