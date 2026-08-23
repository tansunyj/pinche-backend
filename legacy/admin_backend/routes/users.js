const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db/init');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const AuditLogger = require('../services/AuditLogger');
const redis = require('../db/redis');

// 所有路由需要管理员权限
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * GET /api/admin/users
 * 获取用户列表（支持搜索、分页）
 */
router.get('/', async (req, res) => {
  try {
    const {
      keyword = '',
      status,
      quota_min,
      quota_max,
      page = 1,
      pageSize = 20,
      sortField = 'id',
      sortOrder = 'desc',
      user_id
    } = req.query;

    // 构建查询条件
    let whereClause = 'WHERE 1=1';
    const params = [];

    // 用户ID搜索
    if (user_id) {
      whereClause += ' AND id = ?';
      params.push(parseInt(user_id, 10));
    }

    if (keyword) {
      whereClause += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    // 状态筛选
    if (status !== undefined && status !== '') {
      whereClause += ' AND status = ?';
      params.push(parseInt(status, 10));
    }

    // 额度范围筛选（quota_min/quota_max 是元，需要转换为点数: 1元=100000点数）
    if (quota_min !== undefined && quota_min !== '') {
      const minQuota = Math.round(parseFloat(quota_min) * 100000);
      if (!isNaN(minQuota) && minQuota >= 0) {
        whereClause += ' AND balance >= ?';
        params.push(minQuota);
      }
    }
    if (quota_max !== undefined && quota_max !== '') {
      const maxQuota = Math.round(parseFloat(quota_max) * 100000);
      if (!isNaN(maxQuota) && maxQuota >= 0) {
        whereClause += ' AND balance <= ?';
        params.push(maxQuota);
      }
    }

    // 排序字段白名单
    const allowedSortFields = ['id', 'name', 'created_at', 'balance'];
    const actualSortField = allowedSortFields.includes(sortField) ? sortField : 'id';
    const actualSortOrder = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // 查询总数
    const [countResult] = await query(
      `SELECT COUNT(*) as total FROM user_users ${whereClause}`,
      params
    );
    const total = countResult.total;

    // 分页参数安全处理（使用字符串拼接，避免 MySQL2 预处理语句参数问题）
    const safeLimit = Math.max(1, parseInt(pageSize) || 20);
    const safeOffset = Math.max(0, (parseInt(page) - 1) * safeLimit);

    // 查询用户列表（使用 user_users 表 - 存储真实注册用户）
    const users = await query(
      `SELECT
        id,
        email,
        phone,
        name,
        user_type,
        status,
        balance,
        cumulative_recharge,
        created_at,
        updated_at,
        email_verified_at,
        last_login_at,
        last_login_ip
      FROM user_users
      ${whereClause}
      ORDER BY ${actualSortField} ${actualSortOrder}
      LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
    );

    // 格式化返回数据
    const formattedUsers = users.map(u => ({
      id: u.id,
      name: u.name,
      username: u.name || u.email || u.phone,
      email: u.email,
      phone: u.phone,
      user_type: u.user_type,
      role: u.user_type === 3 ? 'superadmin' : u.user_type === 2 ? 'admin' : 'user',
      status: u.status,
      quota: u.balance || 0,
      cumulative_recharge: u.cumulative_recharge || 0,
      created_at: u.created_at,
      updated_at: u.updated_at,
      last_login_at: u.last_login_at,
      last_login_ip: u.last_login_ip,
      token_count: 0,
      recent_requests: 0
    }));

    res.json({
      success: true,
      data: formattedUsers,
      pagination: {
        total,
        page: parseInt(page),
        pageSize: safeLimit,
        totalPages: Math.ceil(total / safeLimit)
      }
    });
  } catch (error) {
    console.error('获取用户列表失败:', error);
    res.status(500).json({ success: false, error: '获取用户列表失败' });
  }
});

/**
 * PUT /api/admin/users/:id/user-type
 * 更新用户类型（如提升为企业用户）
 */
router.put('/:id/user-type', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_type } = req.body;

    // 验证用户类型值
    const validTypes = [1, 2, 3, 4];
    if (!validTypes.includes(parseInt(user_type))) {
      return res.status(400).json({ success: false, error: '无效的用户类型' });
    }

    // 检查用户是否存在
    const [user] = await query('SELECT name, email, user_type, status FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 不能修改自己的用户类型
    if (parseInt(id) === req.user.id) {
      return res.status(403).json({ success: false, error: '不能修改当前登录账号的用户类型' });
    }

    // 不能操作超级管理员（user_type=3）或更高级别
    if (user.user_type >= 3 && parseInt(id) !== req.user.id) {
      return res.status(403).json({ success: false, error: '无权限操作该用户' });
    }

    // 当前操作者权限检查（只有管理员及以上可以修改）
    if (req.user.user_type < 2) {
      return res.status(403).json({ success: false, error: '无权限修改用户类型' });
    }

    const oldType = user.user_type;

    // 更新用户类型
    await query('UPDATE user_users SET user_type = ? WHERE id = ?', [user_type, id]);

    // 记录审计日志
    const typeMap = { 1: '普通用户', 2: '管理员', 3: '超级管理员', 4: '企业用户' };
    req.audit = {
      action: 'UPDATE_USER_TYPE',
      targetType: 'USER',
      targetId: id,
      before: { user_type: oldType },
      after: { user_type: user_type },
      details: { oldTypeName: typeMap[oldType], newTypeName: typeMap[user_type] }
    };

    res.json({
      success: true,
      message: `用户类型已更新为${typeMap[user_type]}`,
      data: { user_type, typeName: typeMap[user_type] }
    });
  } catch (error) {
    console.error('更新用户类型失败:', error);
    res.status(500).json({ success: false, error: '更新用户类型失败' });
  }
});

/**
 * GET /api/admin/users/:id
 * 获取用户详情
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [user] = await query(
      `SELECT id, email, phone, name, user_type, status, balance, cumulative_recharge, created_at, updated_at, email_verified_at, last_login_at, last_login_ip FROM user_users WHERE id = ?`,
      [id]
    );

    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        username: user.name || user.email || user.phone,
        email: user.email,
        phone: user.phone,
        role: user.user_type === 3 ? 'superadmin' : user.user_type === 2 ? 'admin' : 'user',
        status: user.status,
        quota: user.balance || 0,
        cumulative_recharge: user.cumulative_recharge || 0,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_login_at: user.last_login_at,
        last_login_ip: user.last_login_ip,
        tokens: [],
        recent_logs: []
      }
    });
  } catch (error) {
    console.error('获取用户详情失败:', error);
    res.status(500).json({ success: false, error: '获取用户详情失败' });
  }
});

/**
 * PUT /api/admin/users/:id/status
 * 更新用户状态（禁用/启用）
 */
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // 检查用户是否存在
    const [user] = await query('SELECT name, email, user_type, status FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 不能禁用自己
    if (parseInt(id) === req.user.id && status === 0) {
      return res.status(403).json({ success: false, error: '不能禁用当前登录的管理员账号' });
    }

    // 不能操作同级或更高级别的管理员
    if (user.user_type >= req.user.user_type && parseInt(id) !== req.user.id) {
      return res.status(403).json({ success: false, error: '无权限操作该用户' });
    }

    // 更新用户状态
    await query('UPDATE user_users SET status = ? WHERE id = ?', [status, id]);

    // 禁用/启用用户后，清除该用户所有 Token 的网关缓存，使状态变更立即生效
    // Java 网关缓存键: api:key:{apiKey}（见 GatewayConstants.REDIS_KEY_API_KEY_PREFIX）
    // 否则网关仍命中旧缓存，禁用用户后其 API Key 在缓存 TTL 内仍可调用
    try {
      const tokenRows = await query('SELECT `key` FROM proxy_tokens WHERE user_id = ?', [id]);
      if (tokenRows && tokenRows.length > 0) {
        for (const t of tokenRows) {
          if (t.key) {
            await redis.del(`api:key:${t.key}`);
          }
        }
        console.log(`[UserStatus] 已清除用户 ${id} 的 ${tokenRows.length} 个 Token 网关缓存`);
      }
    } catch (redisErr) {
      console.error(`[UserStatus] 清除用户 ${id} 的 Token 缓存失败:`, redisErr.message);
    }

    // 记录审计日志
    req.audit = {
      action: status === 1 ? 'ENABLE_USER' : 'DISABLE_USER',
      targetType: 'USER',
      targetId: id,
      details: { status }
    };

    res.json({
      success: true,
      message: status === 1 ? '用户已启用' : '用户已禁用'
    });
  } catch (error) {
    console.error('更新用户状态失败:', error);
    res.status(500).json({ success: false, error: '更新用户状态失败' });
  }
});

/**
 * POST /api/admin/users/:id/quota
 * 调整用户额度（实际修改数据库）
 * 注意：amount 参数单位为"点数"（1元 = 100000点数）
 */
router.post('/:id/quota', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason = '' } = req.body;

    console.log('[Quota] 收到额度调整请求:', { id, amount, reason, amountType: typeof amount });

    // 严格检查 amount
    const numAmount = parseInt(amount, 10);
    if (isNaN(numAmount)) {
      return res.status(400).json({ success: false, error: '金额必须是有效数字' });
    }

    // 检查用户是否存在
    const [user] = await query('SELECT name, balance, cumulative_recharge FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    const previousBalance = parseInt(user.balance, 10) || 0;
    const newBalance = previousBalance + numAmount;

    console.log('[Quota] 计算新余额:', { previousBalance, numAmount, newBalance });

    // 如果增加额度，同时更新累计充值金额
    let newCumulativeRecharge = parseInt(user.cumulative_recharge, 10) || 0;
    if (numAmount > 0) {
      newCumulativeRecharge += numAmount;
    }

    // 实际更新数据库
    const result = await query(
      'UPDATE user_users SET balance = ?, cumulative_recharge = ? WHERE id = ?',
      [newBalance, newCumulativeRecharge, id]
    );

    console.log('[Quota] 数据库更新结果:', result);

    // 记录审计日志
    req.audit = {
      action: 'ADJUST_USER_QUOTA',
      targetType: 'USER',
      targetId: id,
      before: { balance: previousBalance, cumulativeRecharge: newCumulativeRecharge - (numAmount > 0 ? numAmount : 0) },
      after: { balance: newBalance, cumulativeRecharge: newCumulativeRecharge },
      reason: reason
    };

    res.json({
      success: true,
      message: '额度调整成功',
      data: {
        previousQuota: previousBalance,
        adjustment: numAmount,
        newQuota: newBalance,
        cumulativeRecharge: newCumulativeRecharge
      }
    });
  } catch (error) {
    console.error('调整用户额度失败:', error);
    res.status(500).json({ success: false, error: '调整用户额度失败: ' + error.message });
  }
});

/**
 * POST /api/admin/users/:id/event-token
 * 发放活动 Token（简化版）
 */
router.post('/:id/event-token', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name = '活动 Token',
      eventName = '',
      quota = 0,
      rate_limit_rpm = 10000,
      models = [],
      startDate,
      endDate,
      validDays = 7
    } = req.body;

    // 检查用户是否存在
    const [user] = await query('SELECT name, email FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 计算过期时间（优先使用 endDate，否则使用 validDays）
    let expiredAt = null;
    if (endDate) {
      expiredAt = new Date(endDate);
    } else if (validDays) {
      expiredAt = new Date();
      expiredAt.setDate(expiredAt.getDate() + parseInt(validDays));
    }

    // 记录审计日志
    req.audit = {
      action: 'GRANT_EVENT_TOKEN',
      targetType: 'USER',
      targetId: id,
      details: { name, eventName, quota, rate_limit_rpm, models, startDate, endDate, validDays }
    };

    res.json({
      success: true,
      message: '活动 Token 发放记录已保存（当前系统使用全局 Token 管理）',
      data: {
        token: {
          name,
          eventName,
          quota,
          rate_limit_rpm,
          models,
          startDate,
          endDate,
          validDays,
          expired_at: expiredAt ? expiredAt.toISOString() : null
        },
        recipient: {
          id: parseInt(id),
          username: user.name
        }
      }
    });
  } catch (error) {
    console.error('发放活动 Token 失败:', error);
    res.status(500).json({ success: false, error: '发放活动 Token 失败' });
  }
});

/**
 * POST /api/admin/users/:id/tokens
 * 创建新 Token
 */
router.post('/:id/tokens', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      quota = 0,
      rate_limit_rpm = 10000,
      models = [],
      start_at,
      expired_at,
      price_markup = 1.0,
      channel_id
    } = req.body;

    // 检查用户是否存在
    const [user] = await query('SELECT id FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 生成 Token key (sk-前缀)
    const crypto = require('crypto');
    const key = 'sk-' + crypto.randomBytes(32).toString('hex');

    // 处理 models 字段 - 统一转为逗号分隔字符串
    let modelsStr = '';
    if (Array.isArray(models)) {
      modelsStr = models.join(',');
    } else if (typeof models === 'string') {
      // 如果已经是字符串（可能是 JSON 格式），尝试解析再处理
      try {
        const parsed = JSON.parse(models);
        if (Array.isArray(parsed)) {
          modelsStr = parsed.join(',');
        } else {
          modelsStr = models;
        }
      } catch (e) {
        modelsStr = models;
      }
    }

    // 插入新 Token
    const result = await query(
      `INSERT INTO proxy_tokens
        (user_id, \`name\`, \`key\`, quota, remain_quota, used_quota, rate_limit_rpm, models, status, start_at, expired_at, created_at, price_markup, channel_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, NOW(), ?, ?)`,
      [id, name, key, quota, quota, rate_limit_rpm, modelsStr, start_at || null, expired_at || null, price_markup || 1.0, channel_id || null]
    );

    // 记录审计日志
    req.audit = {
      action: 'CREATE_TOKEN',
      targetType: 'TOKEN',
      targetId: result.insertId,
      details: { name, quota, rate_limit_rpm, start_at, expired_at, models }
    };

    res.json({
      success: true,
      message: 'Token 创建成功',
      data: {
        id: result.insertId,
        name,
        key: key.slice(0, 16) + '...',
        quota,
        rate_limit_rpm,
        status: 1,
        start_at,
        expired_at
      }
    });
  } catch (error) {
    console.error('创建 Token 失败:', error);
    res.status(500).json({ success: false, error: '创建 Token 失败: ' + error.message });
  }
});

/**
 * GET /api/admin/users/:id/tokens
 * 获取用户的 Token 列表
 */
router.get('/:id/tokens', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, pageSize = 20 } = req.query;

    console.log('[Tokens] 获取用户 Token 列表:', { id, page, pageSize });

    // 检查用户是否存在
    const [user] = await query('SELECT id, name FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 查询用户的 Token 列表
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    console.log('[Tokens] 查询参数:', { offset, pageSize: parseInt(pageSize) });

    const tokens = await query(
      `SELECT
        t.id,
        t.\`name\`,
        t.\`key\`,
        t.quota,
        t.used_quota,
        t.rate_limit_rpm,
        t.models,
        t.status,
        t.price_markup,
        t.channel_id,
        c.name AS channel_name,
        t.created_at,
        t.start_at,
        t.expired_at
      FROM proxy_tokens t
      LEFT JOIN proxy_channels c ON t.channel_id = c.id
      WHERE t.user_id = ?
      ORDER BY t.created_at DESC
      LIMIT ${parseInt(pageSize)} OFFSET ${offset}`,
      [id]
    );

    console.log('[Tokens] 查询结果数:', tokens.length);

    // 查询总数
    const [countResult] = await query(
      'SELECT COUNT(*) as total FROM proxy_tokens WHERE user_id = ?',
      [id]
    );

    // 格式化返回数据
    const formattedTokens = tokens.map(t => {
      let models = [];
      try {
        // 尝试解析 JSON 格式（旧数据）
        models = JSON.parse(t.models || '[]');
      } catch (e) {
        // 如果不是 JSON，则按逗号分隔解析（新数据）
        models = t.models ? t.models.split(',').filter(m => m.trim()) : [];
      }
      return {
        id: t.id,
        name: t.name,
        key: t.key,
        quota: t.quota || 0,
        used_quota: t.used_quota || 0,
        rate_limit_rpm: t.rate_limit_rpm || 0,
        price_markup: t.price_markup || 1.0,
        channel_id: t.channel_id,
        channel_name: t.channel_name,
        models: models,
        status: t.status,
        created_at: t.created_at,
        start_at: t.start_at,
        expired_at: t.expired_at
      };
    });

    res.json({
      success: true,
      data: formattedTokens,
      pagination: {
        total: countResult.total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(countResult.total / parseInt(pageSize))
      }
    });
  } catch (error) {
    console.error('[Tokens] 获取用户 Token 列表失败:', error);
    console.error('[Tokens] 错误堆栈:', error.stack);
    res.status(500).json({
      success: false,
      error: '获取用户 Token 列表失败: ' + error.message
    });
  }
});

/**
 * GET /api/admin/users/:id/recharge-records
 * 获取用户的充值记录（查询 billing_orders 表，包括所有状态）
 */
router.get('/:id/recharge-records', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, pageSize = 20 } = req.query;

    console.log(`[RechargeRecords] 查询用户 ${id} 的充值记录`);

    // 检查用户是否存在
    const [user] = await query('SELECT id, name FROM user_users WHERE id = ?', [id]);
    console.log(`[RechargeRecords] 用户查询结果:`, user);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;

    // 查询总数
    const [countResult] = await query(
      'SELECT COUNT(*) as total FROM billing_orders WHERE user_id = ?',
      [id]
    );
    const total = countResult?.total || 0;
    console.log(`[RechargeRecords] 用户 ${id} 的总记录数:`, total);

    // 查询充值记录（支持分页）
    const records = await query(
      `SELECT
        id,
        order_no,
        amount,
        points,
        payment_channel,
        payment_method,
        status,
        paid_at,
        created_at,
        updated_at
      FROM billing_orders
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
      [id]
    );
    console.log(`[RechargeRecords] 查询到 ${records.length} 条记录`);

    // 格式化返回数据
    const formattedRecords = records.map(r => ({
      id: r.id,
      order_no: r.order_no,
      amount: parseFloat(r.amount) || 0,
      points: parseInt(r.points) || 0,
      payment_channel: r.payment_channel,
      payment_method: r.payment_method,
      status: r.status, // pending, paid, failed, cancelled, expired
      paid_at: r.paid_at,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));

    res.json({
      success: true,
      data: formattedRecords,
      pagination: {
        total,
        page: parseInt(page),
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[RechargeRecords] 获取用户充值记录失败:', error);
    res.status(500).json({ success: false, error: '获取用户充值记录失败: ' + error.message });
  }
});

/**
 * PUT /api/admin/users/:id/tokens/:tokenId/status
 * 切换 Token 状态（启用/禁用）
 */
router.put('/:id/tokens/:tokenId/status', async (req, res) => {
  try {
    const { id, tokenId } = req.params;
    const { status } = req.body;

    // 检查用户是否存在
    const [user] = await query('SELECT id FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 检查 Token 是否存在且属于该用户
    const [token] = await query('SELECT id, `name` FROM proxy_tokens WHERE id = ? AND user_id = ?', [tokenId, id]);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token 不存在或不属于该用户' });
    }

    // 更新 Token 状态
    await query('UPDATE proxy_tokens SET status = ? WHERE id = ?', [status, tokenId]);

    // 清除 Redis 缓存，使状态变更立即生效
    // Java 网关 (silievo-api-gateway) ApiKeyAuthServiceImpl 使用的缓存键：
    //   api:key:{apiKey}  值: "1"(有效) / "0"(无效)  TTL: 24h / 5min
    // selectByKey 的 SQL 带 status=1 过滤，禁用后缓存会被污染成 "0"，
    // 若不清除正确的键，重新启用后 5 分钟内仍判定为无效 → 调用失败。
    try {
      const [tokenKey] = await query('SELECT \`key\` FROM proxy_tokens WHERE id = ?', [tokenId]);
      if (tokenKey) {
        const apiKeyCacheKey = `api:key:${tokenKey.key}`;
        const legacyCacheKey = `cache:token:key:${tokenKey.key}`;
        const delApi = await redis.del(apiKeyCacheKey);
        const delLegacy = await redis.del(legacyCacheKey);
        console.log(`[TokenStatus] 清除网关API Key缓存: ${apiKeyCacheKey}, 删除数量: ${delApi}; 旧版缓存: ${legacyCacheKey}, 删除数量: ${delLegacy}`);
      }
    } catch (redisErr) {
      console.error(`[TokenStatus] 清除缓存失败:`, redisErr.message);
    }

    // 记录审计日志
    req.audit = {
      action: status === 1 ? 'ENABLE_TOKEN' : 'DISABLE_TOKEN',
      targetType: 'TOKEN',
      targetId: tokenId,
      details: { tokenName: token.name, status }
    };

    res.json({
      success: true,
      message: status === 1 ? 'Token 已启用' : 'Token 已禁用'
    });
  } catch (error) {
    console.error('切换 Token 状态失败:', error);
    res.status(500).json({ success: false, error: '切换 Token 状态失败: ' + error.message });
  }
});

/**
 * PUT /api/admin/users/:id/tokens/:tokenId
 * 更新 Token 信息（名称、额度、过期时间、RPM、可用模型）
 */
router.put('/:id/tokens/:tokenId', async (req, res) => {
  try {
    const { id, tokenId } = req.params;
    const { name, quota, rate_limit_rpm, start_at, expired_at, models, price_markup, channel_id } = req.body;

    // 检查用户是否存在
    const [user] = await query('SELECT id FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 检查 Token 是否存在且属于该用户，同时获取 key 用于清除缓存
    const [token] = await query('SELECT id, `key` FROM proxy_tokens WHERE id = ? AND user_id = ?', [tokenId, id]);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token 不存在或不属于该用户' });
    }
    const tokenKey = token.key;

    // 构建更新字段
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('`name` = ?');
      params.push(name);
    }
    if (quota !== undefined) {
      updates.push('quota = ?');
      params.push(quota);
    }
    if (rate_limit_rpm !== undefined) {
      updates.push('rate_limit_rpm = ?');
      params.push(rate_limit_rpm);
    }
    if (start_at !== undefined) {
      updates.push('start_at = ?');
      params.push(start_at || null);
    }
    if (expired_at !== undefined) {
      updates.push('expired_at = ?');
      params.push(expired_at || null);
    }
    if (models !== undefined) {
      updates.push('models = ?');
      // 处理 models 字段 - 统一转为逗号分隔字符串
      let modelsStr = '';
      if (Array.isArray(models)) {
        modelsStr = models.join(',');
      } else if (typeof models === 'string') {
        // 如果已经是字符串（可能是 JSON 格式），尝试解析再处理
        try {
          const parsed = JSON.parse(models);
          if (Array.isArray(parsed)) {
            modelsStr = parsed.join(',');
          } else {
            modelsStr = models;
          }
        } catch (e) {
          modelsStr = models;
        }
      }
      params.push(modelsStr);
    }
    if (price_markup !== undefined) {
      updates.push('price_markup = ?');
      params.push(price_markup);
    }
    if (channel_id !== undefined) {
      updates.push('channel_id = ?');
      params.push(channel_id);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: '没有需要更新的字段' });
    }

    params.push(tokenId);

    await query(
      `UPDATE proxy_tokens SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Token 更新后，删除 Redis 缓存，使新配置立即生效
    // Java 网关 (silievo-api-gateway) ApiKeyAuthServiceImpl 使用的缓存键：
    //   api:key:{apiKey}  值: "1"(有效) / "0"(无效)  TTL: 24h / 5min
    // selectByKey 的 SQL 带 status=1 过滤，配置变更后若不主动清除该键，
    // 网关会命中旧缓存导致新配置不生效（如改额度/模型/折扣后仍按旧值计费）。
    // 另外保留对旧限流键的清理以兼容历史逻辑。
    try {
      const apiKeyCacheKey = `api:key:${tokenKey}`;
      const rateLimitKey = `ratelimit:config:${tokenId}`;
      const legacyTokenCacheKey = `cache:token:key:${tokenKey}`;

      console.log(`[TokenUpdate] 准备清除缓存，Token ID: ${tokenId}, Token Key: ${tokenKey}`);

      // 清除 Java 网关的 API Key 有效性缓存（最关键）
      const apiKeyResult = await redis.del(apiKeyCacheKey);
      console.log(`[TokenUpdate] 清除 API Key 缓存: ${apiKeyCacheKey}, 删除数量: ${apiKeyResult}`);

      // 清除限流配置缓存
      const rateLimitResult = await redis.del(rateLimitKey);
      console.log(`[TokenUpdate] 清除限流缓存: ${rateLimitKey}, 删除数量: ${rateLimitResult}`);

      // 清除旧版 Token 数据缓存（兼容）
      const tokenCacheResult = await redis.del(legacyTokenCacheKey);
      console.log(`[TokenUpdate] 清除旧版 Token 缓存: ${legacyTokenCacheKey}, 删除数量: ${tokenCacheResult}`);

      console.log(`[TokenUpdate] 已清除 Token ${tokenId}(${tokenKey}) 的所有相关缓存`);
    } catch (redisErr) {
      console.error(`[TokenUpdate] 清除缓存失败 (Token ${tokenId}):`, redisErr.message);
      console.error(`[TokenUpdate] Redis 错误详情:`, redisErr);
      // Redis 错误不影响主流程
    }

    // 记录审计日志
    req.audit = {
      action: 'UPDATE_TOKEN',
      targetType: 'TOKEN',
      targetId: tokenId,
      details: { name, quota, rate_limit_rpm, start_at, expired_at, models }
    };

    res.json({
      success: true,
      message: 'Token 更新成功'
    });
  } catch (error) {
    console.error('更新 Token 失败:', error);
    res.status(500).json({ success: false, error: '更新 Token 失败: ' + error.message });
  }
});

/**
 * DELETE /api/admin/users/:id/tokens/:tokenId
 * 删除 Token
 */
router.delete('/:id/tokens/:tokenId', async (req, res) => {
  try {
    const { id, tokenId } = req.params;

    // 检查用户是否存在
    const [user] = await query('SELECT id FROM user_users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 检查 Token 是否存在且属于该用户，同时获取 key 用于清除缓存
    const [token] = await query('SELECT id, `name`, `key` FROM proxy_tokens WHERE id = ? AND user_id = ?', [tokenId, id]);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token 不存在或不属于该用户' });
    }

    // 删除 Token
    await query('DELETE FROM proxy_tokens WHERE id = ?', [tokenId]);

    // 清除 Redis 缓存
    // Java 网关 (silievo-api-gateway) 实际使用的缓存键: api:key:{apiKey} (见 GatewayConstants.REDIS_KEY_API_KEY_PREFIX)
    try {
      const apiKeyCacheKey = `api:key:${token.key}`;
      const delResult = await redis.del(apiKeyCacheKey);
      console.log(`[TokenDelete] 已清除网关API Key缓存: ${apiKeyCacheKey}, 删除数量: ${delResult}`);
    } catch (redisErr) {
      console.error(`[TokenDelete] 清除缓存失败:`, redisErr.message);
    }

    // 记录审计日志
    req.audit = {
      action: 'DELETE_TOKEN',
      targetType: 'TOKEN',
      targetId: tokenId,
      details: { tokenName: token.name }
    };

    res.json({
      success: true,
      message: 'Token 已删除'
    });
  } catch (error) {
    console.error('删除 Token 失败:', error);
    res.status(500).json({ success: false, error: '删除 Token 失败: ' + error.message });
  }
});

module.exports = router;
