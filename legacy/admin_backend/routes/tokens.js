const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { yuanToQuota } = require('../utils/billing');
const redis = require('../db/redis');

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { username } = req.query;
    let sql = `
      SELECT t.*, c.name as channel_name,
        COALESCE(u.phone, u.email, u.name) as user_username,
        ROUND(COALESCE(stat.avg_latency, 0)) as avg_latency,
        COALESCE(latest.latency_ms, 0) as last_latency,
        stat.call_count,
        stat.last_call_time
      FROM proxy_tokens t
      LEFT JOIN proxy_channels c ON t.channel_id = c.id
      LEFT JOIN user_users u ON t.user_id = u.id
      LEFT JOIN (
        SELECT token_id,
          ROUND(AVG(latency_ms)) as avg_latency,
          COUNT(*) as call_count,
          MAX(created_at) as last_call_time
        FROM proxy_logs
        WHERE latency_ms > 0 AND status = 'success'
        GROUP BY token_id
      ) stat ON t.id = stat.token_id
      LEFT JOIN (
        SELECT L.token_id, L.latency_ms
        FROM proxy_logs L
        JOIN (
            SELECT token_id, MAX(id) as max_id
            FROM proxy_logs
            WHERE latency_ms > 0 AND status = 'success'
            GROUP BY token_id
        ) M ON L.id = M.max_id
      ) latest ON t.id = latest.token_id
    `;
    const params = [];
    if (username) {
      sql += ' WHERE (u.phone LIKE ? OR u.email LIKE ? OR u.name LIKE ?)';
      params.push(`%${username}%`, `%${username}%`, `%${username}%`);
    }
    sql += ' ORDER BY t.id DESC';
    const tokens = await query(sql, params);
    res.json(tokens);
  } catch (e) {
    res.status(500).json({ error: '获取令牌列表失败' });
  }
});

router.post('/', async (req, res) => {
  const { name, models, quota, rate_limit_rpm, expired_at, start_at, channel_id, price_markup, api_key, user_id } = req.body;
  if (!name) return res.status(400).json({ error: '令牌名称为必填项' });
  if (!user_id) return res.status(400).json({ error: '必须绑定所属用户' });
  const modelsStr = Array.isArray(models) ? models.join(',') : (models || '');
  const markup = price_markup || 1.0;
  if (isNaN(markup) || markup <= 0 || markup > 100) return res.status(400).json({ error: '折扣倍率必须在 0~100 之间' });

  const key = 'sk-silievo-' + uuidv4().replace(/-/g, '').slice(0, 32);
  const quotaVal = quota ? Number(quota) : 0;
  try {
    const result = await query(
      'INSERT INTO proxy_tokens (user_id, name, `key`, models, quota, used_quota, remain_quota, rate_limit_rpm, start_at, expired_at, channel_id, price_markup, api_key) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
      [user_id, name, key, modelsStr, quotaVal, quotaVal, rate_limit_rpm || 10000, start_at || null, expired_at || null, channel_id || null, markup, api_key || '']
    );
    req.audit = {
      action: 'token.create',
      targetType: 'token',
      targetId: result.insertId,
      after: { user_id, name, models: modelsStr, quota: quotaVal, rate_limit_rpm, start_at, expired_at, channel_id, price_markup: markup },
    };
    res.json({ id: result.insertId, key, message: '令牌创建成功' });
  } catch (e) {
    console.error('[Token Create Error]', e);
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Key 生成冲突，请重试' });
    res.status(500).json({ error: '创建令牌失败: ' + e.message });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, models, quota, rate_limit_rpm, start_at, expired_at, status, channel_id, price_markup, api_key } = req.body;
  try {
    const rows = await query('SELECT * FROM proxy_tokens WHERE id = ?', [id]);
    const token = rows[0];
    if (!token) return res.status(404).json({ error: '令牌不存在' });

    let newQuota = token.quota;
    let remainQuota = token.remain_quota;
    if (quota !== undefined) {
      newQuota = Number(quota);
      remainQuota = Math.max(0, newQuota - token.used_quota);
    }

    const modelsStr = models !== undefined ? (Array.isArray(models) ? models.join(',') : models) : token.models;
    const markup = price_markup !== undefined ? price_markup : token.price_markup;
    if (isNaN(markup) || markup <= 0 || markup > 100) return res.status(400).json({ error: '折扣倍率必须在 0~100 之间' });

    const after = {
      name: name !== undefined ? name : token.name,
      models: modelsStr,
      quota: newQuota,
      remain_quota: remainQuota,
      rate_limit_rpm: rate_limit_rpm !== undefined ? rate_limit_rpm : token.rate_limit_rpm,
      start_at: start_at !== undefined ? start_at : token.start_at,
      expired_at: expired_at !== undefined ? expired_at : token.expired_at,
      status: status !== undefined ? status : token.status,
      channel_id: channel_id !== undefined ? channel_id : token.channel_id,
      price_markup: markup,
      api_key: api_key !== undefined ? api_key : token.api_key,
    };
    await query(
      'UPDATE proxy_tokens SET name=?, models=?, quota=?, remain_quota=?, rate_limit_rpm=?, start_at=?, expired_at=?, status=?, channel_id=?, price_markup=?, api_key=? WHERE id=?',
      [after.name, after.models, after.quota, after.remain_quota, after.rate_limit_rpm, after.start_at, after.expired_at,
       after.status, after.channel_id, after.price_markup, after.api_key, id]
    );

    // Token 更新后，删除 Redis 缓存，使新配置立即生效
    // Java 网关 (silievo-api-gateway) ApiKeyAuthServiceImpl 使用的缓存键：
    //   api:key:{apiKey}  值: "1"(有效) / "0"(无效)  TTL: 24h / 5min
    // selectByKey 的 SQL 带 status=1 过滤，因此禁用后缓存会被污染成 "0"，
    // 若不主动清除，重新启用后 5 分钟内仍会被判定为无效 → 调用失败。
    // 另外保留对旧限流键的清理以兼容历史逻辑。
    try {
      const apiKeyCacheKey = `api:key:${token.key}`;
      const rateLimitKey = `ratelimit:config:${id}`;
      const legacyTokenCacheKey = `cache:token:key:${token.key}`;

      console.log(`[TokenUpdate] 准备清除缓存，Token ID: ${id}, Token Key: ${token.key}`);

      // 清除 Java 网关的 API Key 有效性缓存（最关键）
      const apiKeyResult = await redis.del(apiKeyCacheKey);
      console.log(`[TokenUpdate] 清除 API Key 缓存: ${apiKeyCacheKey}, 删除数量: ${apiKeyResult}`);

      // 清除限流配置缓存
      const rateLimitResult = await redis.del(rateLimitKey);
      console.log(`[TokenUpdate] 清除限流缓存: ${rateLimitKey}, 删除数量: ${rateLimitResult}`);

      // 清除旧版 Token 数据缓存（兼容）
      const tokenCacheResult = await redis.del(legacyTokenCacheKey);
      console.log(`[TokenUpdate] 清除旧版 Token 缓存: ${legacyTokenCacheKey}, 删除数量: ${tokenCacheResult}`);

      console.log(`[TokenUpdate] 已清除 Token ${id}(${token.key}) 的所有相关缓存`);
    } catch (redisErr) {
      console.error(`[TokenUpdate] 清除缓存失败 (Token ${id}):`, redisErr.message);
      // Redis 错误不影响主流程
    }

    req.audit = {
      action: 'token.update',
      targetType: 'token',
      targetId: id,
      before: token,
      after,
    };
    res.json({ message: '令牌更新成功' });
  } catch (e) {
    res.status(500).json({ error: '更新令牌失败' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM proxy_tokens WHERE id = ?', [req.params.id]);
    const token = rows[0];
    await query('DELETE FROM proxy_tokens WHERE id = ?', [req.params.id]);

    // 清除 Token 相关缓存（使删除立即生效）
    // Java 网关 (silievo-api-gateway) 实际使用的 Redis 缓存键：
    //   api:key:{apiKey}  值: "1"=有效 / "0"=无效  (见 GatewayConstants.REDIS_KEY_API_KEY_PREFIX)
    // 必须清除该键，否则网关仍会命中旧缓存导致已删除/禁用的 Key 继续可用或反向卡死。
    if (token) {
      try {
        const apiKeyCacheKey = `api:key:${token.key}`;

        const delResult = await redis.del(apiKeyCacheKey);
        console.log(`[TokenDelete] 清除网关API Key缓存: ${apiKeyCacheKey}, 删除数量: ${delResult}`);
      } catch (redisErr) {
        console.error(`[TokenDelete] 清除缓存失败 (Token ${req.params.id}):`, redisErr.message);
      }
    }

    req.audit = {
      action: 'token.delete',
      targetType: 'token',
      targetId: req.params.id,
      before: rows[0] || null,
    };
    res.json({ message: '令牌删除成功' });
  } catch (e) {
    res.status(500).json({ error: '删除令牌失败' });
  }
});

router.post('/:id/reset-quota', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM proxy_tokens WHERE id = ?', [req.params.id]);
    const token = rows[0];
    if (!token) return res.status(404).json({ error: '令牌不存在' });
    await query('UPDATE proxy_tokens SET used_quota = 0, remain_quota = quota WHERE id = ?', [req.params.id]);
    req.audit = {
      action: 'token.reset_quota',
      targetType: 'token',
      targetId: req.params.id,
      before: { used_quota: token.used_quota, remain_quota: token.remain_quota },
      after: { used_quota: 0, remain_quota: token.quota },
    };
    res.json({ message: '额度已重置' });
  } catch (e) {
    res.status(500).json({ error: '重置额度失败' });
  }
});

module.exports = router;
