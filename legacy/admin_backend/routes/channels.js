const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

/**
 * 把前端传来的各种 key 字段归一化成 [{name, api_key, weight, status}]
 *
 * 接受的形态：
 *   - api_keys: ["sk-xxx", "sk-yyy"]
 *   - api_keys: [{api_key:"sk-xxx", name:"k1", weight:2}, ...]
 *   - api_key:  "sk-xxx"                  （legacy 单 key 兼容）
 *
 * 空字符串/重复 key 会被去掉；保留录入顺序。
 */
function normalizeKeys(body) {
  const raw = body?.api_keys;
  const out = [];
  const seen = new Set();
  const push = (item, idx) => {
    if (!item) return;
    const apiKey = (typeof item === 'string' ? item : item.api_key || '').trim();
    if (!apiKey || seen.has(apiKey)) return;
    seen.add(apiKey);
    out.push({
      name: (typeof item === 'object' && item?.name) ? String(item.name).slice(0, 100) : `key-${idx + 1}`,
      api_key: apiKey,
      weight: Number.isFinite(+item?.weight) && +item.weight > 0 ? +item.weight : 1,
      status: item?.status === 0 ? 0 : 1,
    });
  };

  if (Array.isArray(raw)) raw.forEach(push);
  if (body?.api_key && typeof body.api_key === 'string') push(body.api_key, out.length);

  return out;
}

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const channels = await query(`
      SELECT c.*,
        ROUND(COALESCE(stat.avg_latency, 0)) as avg_latency,
        COALESCE(latest.latency_ms, 0) as last_latency,
        stat.call_count,
        COALESCE(tok.token_count, 0) as token_count,
        COALESCE(tok.active_token_count, 0) as active_token_count,
        COALESCE(cmc.model_count, 0) as model_count
      FROM proxy_channels c
      LEFT JOIN (
        SELECT channel_id, COUNT(*) as model_count
        FROM proxy_channel_models
        WHERE is_enabled = 1
        GROUP BY channel_id
      ) cmc ON c.id = cmc.channel_id
      LEFT JOIN (
        SELECT channel_id,
               COUNT(*) as token_count,
               SUM(CASE WHEN status = 1 AND auto_disabled = 0 THEN 1 ELSE 0 END) as active_token_count
        FROM proxy_channel_tokens
        GROUP BY channel_id
      ) tok ON c.id = tok.channel_id
      LEFT JOIN (
        SELECT channel_id,
          ROUND(AVG(latency_ms)) as avg_latency,
          COUNT(*) as call_count
        FROM proxy_logs
        WHERE latency_ms > 0 AND status = 'success'
        GROUP BY channel_id
      ) stat ON c.id = stat.channel_id
      LEFT JOIN (
        SELECT L.channel_id, L.latency_ms
        FROM proxy_logs L
        JOIN (
            SELECT channel_id, MAX(id) as max_id
            FROM proxy_logs
            WHERE latency_ms > 0 AND status = 'success'
            GROUP BY channel_id
        ) M ON L.id = M.max_id
      ) latest ON c.id = latest.channel_id
      ORDER BY c.id ASC
    `);
    res.json({ success: true, data: channels });
  } catch (e) {
    res.status(500).json({ success: false, error: '获取渠道列表失败' });
  }
});

/**
 * 创建渠道
 *
 * 推荐工作流：先建渠道（无需 key），再到「Token」面板增管多个 key。
 * 也兼容一次性传 keys：
 *   - api_keys: ["sk-xxx", ...] 或 [{api_key, name?, weight?}, ...]
 *   - api_key:  "sk-xxx"  （legacy 单 key 兼容）
 *
 * 没传 key 时 proxy_channels.api_key 会写空串占位（DB 约束 NOT NULL）。
 * 该字段仅作为 token 池为空时的最后回退；池有活 key 时永远用池里的。
 */
router.post('/', async (req, res) => {
  const { name, type, base_url, priority, weight, token_lb_strategy, channel_code } = req.body;
  const keys = normalizeKeys(req.body);
  if (!name || !base_url) {
    return res.status(400).json({ error: '名称、Base URL 为必填项' });
  }

  // 验证渠道代码格式
  if (channel_code && !/^[a-z][a-z0-9_]{1,31}$/.test(channel_code)) {
    return res.status(400).json({ error: '渠道代码格式不正确，只能包含小写字母、数字和下划线，且必须以字母开头' });
  }

  try {
    const channelId = await transaction(async (conn) => {
      // 第一个 key 同时写进 proxy_channels.api_key 做 legacy 兜底；没传 keys 就用空串占位
      const legacyApiKey = keys[0]?.api_key || '';
      const [r] = await conn.execute(
        `INSERT INTO proxy_channels
           (name, type, base_url, api_key, priority, weight, token_lb_strategy, channel_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name, type || 'openai', base_url, legacyApiKey,
          priority || 0, weight || 1,
          token_lb_strategy || 'round_robin',
          channel_code || null,
        ]
      );
      const newId = r.insertId;

      for (const k of keys) {
        await conn.execute(
          `INSERT INTO proxy_channel_tokens
             (channel_id, name, api_key_encrypted, weight, status)
           VALUES (?, ?, ?, ?, ?)`,
          [newId, k.name, k.api_key, k.weight, k.status]
        );
      }
      return newId;
    });

    req.audit = {
      action: 'channel.create',
      targetType: 'channel',
      targetId: channelId,
      after: {
        name, type: type || 'openai', base_url, channel_code,
        priority, weight, token_lb_strategy: token_lb_strategy || 'round_robin',
        api_keys: keys.map(k => ({ name: k.name, weight: k.weight, status: k.status })),
        token_count: keys.length,
      },
    };

    // 清除该渠道的上游 Token 池缓存（Java 网关使用 upstream:tokens:channel:{channelId}）
    // 同时清除渠道端点缓存（channel:endpoint:*）
    try {
      const upstreamKey = `upstream:tokens:channel:${channelId}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelCreate] 清除上游 Token 缓存: ${upstreamKey}`);

      // 清除渠道端点缓存（所有模型）
      const epKeys = await redis.keys('channel:endpoint:*');
      if (epKeys.length > 0) {
        await redis.del(...epKeys);
        console.log(`[ChannelCreate] 清除渠道端点缓存: ${epKeys.length} 个`);
      }

      // 清除渠道模型映射缓存（新渠道可能影响模型路由）
      const cmKeys = await redis.keys('cache:channel_models:*');
      if (cmKeys.length > 0) {
        await redis.del(...cmKeys);
        console.log(`[ChannelCreate] 清除渠道模型缓存: ${cmKeys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ChannelCreate] 清除缓存失败 (channel ${channelId}):`, redisErr.message);
    }

    res.json({
      id: channelId,
      token_count: keys.length,
      message: keys.length === 0
        ? '渠道创建成功，请到「Token」面板添加 API Key'
        : '渠道创建成功',
    });
  } catch (e) {
    console.error('[channels] create error:', e);
    if (e.code === 'ER_DUP_ENTRY' && e.message.includes('channel_code')) {
      return res.status(409).json({ error: '渠道代码已存在，请使用其他代码' });
    }
    res.status(500).json({ error: '创建渠道失败', detail: e.message });
  }
});

/**
 * 更新渠道
 *
 * body 支持：
 *   - 基本字段：name / type / base_url / models / status / priority / weight / token_lb_strategy
 *   - api_key  : legacy 单 key 写法，只改 proxy_channels.api_key（不动 token 池）
 *   - api_keys : 多 key 写法，传入则**全量替换** proxy_channel_tokens（DELETE + INSERT）
 *                且把第一个 key 同步到 proxy_channels.api_key 作为 legacy 兼容
 *
 * 仅想改 token 池时更推荐走 PUT/POST /api/admin/channels/:id/tokens 的细粒度接口。
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, type, base_url, api_key, status, priority, weight,
    token_lb_strategy, channel_code,
  } = req.body || {};
  const replacingKeys = Array.isArray(req.body?.api_keys);
  const newKeys = replacingKeys ? normalizeKeys(req.body) : null;

  if (replacingKeys && newKeys.length === 0) {
    return res.status(400).json({ error: '至少需要一个 API Key' });
  }

  // 验证渠道代码格式
  if (channel_code !== undefined && channel_code !== null && channel_code !== '') {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(channel_code)) {
      return res.status(400).json({ error: '渠道代码格式不正确，只能包含小写字母、数字和下划线，且必须以字母开头' });
    }
  }

  try {
    const rows = await query('SELECT * FROM proxy_channels WHERE id = ?', [id]);
    const channel = rows[0];
    if (!channel) return res.status(404).json({ error: '渠道不存在' });

    const after = {
      name: name !== undefined ? name : channel.name,
      type: type !== undefined ? type : channel.type,
      base_url: base_url !== undefined ? base_url : channel.base_url,
      // 优先采用新 keys 的第一个作为 legacy api_key，其次用显式 api_key，否则保持原值
      api_key: replacingKeys ? newKeys[0].api_key : (api_key !== undefined ? api_key : channel.api_key),
      status: status !== undefined ? status : channel.status,
      priority: priority !== undefined ? priority : channel.priority,
      weight: weight !== undefined ? weight : channel.weight,
      token_lb_strategy: token_lb_strategy !== undefined ? token_lb_strategy : channel.token_lb_strategy,
      channel_code: channel_code !== undefined ? channel_code : channel.channel_code,
    };

    await transaction(async (conn) => {
      await conn.execute(
        `UPDATE proxy_channels
            SET name=?, type=?, base_url=?, api_key=?, status=?, priority=?, weight=?,
                token_lb_strategy=?, channel_code=?, updated_at=CURRENT_TIMESTAMP
          WHERE id=?`,
        [
          after.name, after.type, after.base_url, after.api_key,
          after.status, after.priority, after.weight, after.token_lb_strategy,
          after.channel_code, id,
        ]
      );

      if (replacingKeys) {
        // 全量替换 token 池（清空重建）
        await conn.execute('DELETE FROM proxy_channel_tokens WHERE channel_id = ?', [id]);
        for (const k of newKeys) {
          await conn.execute(
            `INSERT INTO proxy_channel_tokens
               (channel_id, name, api_key_encrypted, weight, status)
             VALUES (?, ?, ?, ?, ?)`,
            [id, k.name, k.api_key, k.weight, k.status]
          );
        }
      }
    });

    req.audit = {
      action: 'channel.update',
      targetType: 'channel',
      targetId: id,
      before: channel,
      after: replacingKeys
        ? {
            ...after,
            api_keys: newKeys.map(k => ({ name: k.name, weight: k.weight, status: k.status })),
            token_count: newKeys.length,
          }
        : after,
    };

    // 清除该渠道的上游 Token 池缓存（Java 网关使用 upstream:tokens:channel:{channelId}）
    // 同时清除渠道端点缓存（channel:endpoint:*）
    try {
      const upstreamKey = `upstream:tokens:channel:${id}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelUpdate] 清除上游 Token 缓存: ${upstreamKey}`);

      // 清除渠道端点缓存（所有模型）
      const epKeys = await redis.keys('channel:endpoint:*');
      if (epKeys.length > 0) {
        await redis.del(...epKeys);
        console.log(`[ChannelUpdate] 清除渠道端点缓存: ${epKeys.length} 个`);
      }

      // 清除渠道模型映射缓存（渠道配置变更可能影响模型路由）
      const cmKeys = await redis.keys('cache:channel_models:*');
      if (cmKeys.length > 0) {
        await redis.del(...cmKeys);
        console.log(`[ChannelUpdate] 清除渠道模型缓存: ${cmKeys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ChannelUpdate] 清除缓存失败 (channel ${id}):`, redisErr.message);
    }

    res.json({
      message: '渠道更新成功',
      ...(replacingKeys ? { token_count: newKeys.length } : {}),
    });
  } catch (e) {
    console.error('[channels] update error:', e);
    if (e.code === 'ER_DUP_ENTRY' && e.message.includes('channel_code')) {
      return res.status(409).json({ error: '渠道代码已存在，请使用其他代码' });
    }
    res.status(500).json({ error: '更新渠道失败', detail: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM proxy_channels WHERE id = ?', [req.params.id]);
    await query('DELETE FROM proxy_channels WHERE id = ?', [req.params.id]);

    // 清除该渠道的上游 Token 池缓存（Java 网关使用 upstream:tokens:channel:{channelId}）
    // 同时清除渠道端点缓存（channel:endpoint:*）
    try {
      const upstreamKey = `upstream:tokens:channel:${req.params.id}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelDelete] 清除上游 Token 缓存: ${upstreamKey}`);

      // 清除渠道端点缓存（所有模型）
      const epKeys = await redis.keys('channel:endpoint:*');
      if (epKeys.length > 0) {
        await redis.del(...epKeys);
        console.log(`[ChannelDelete] 清除渠道端点缓存: ${epKeys.length} 个`);
      }

      // 清除渠道模型映射缓存（渠道删除后模型路由需要重新计算）
      const cmKeys = await redis.keys('cache:channel_models:*');
      if (cmKeys.length > 0) {
        await redis.del(...cmKeys);
        console.log(`[ChannelDelete] 清除渠道模型缓存: ${cmKeys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ChannelDelete] 清除缓存失败 (channel ${req.params.id}):`, redisErr.message);
    }

    req.audit = {
      action: 'channel.delete',
      targetType: 'channel',
      targetId: req.params.id,
      before: rows[0] || null,
    };
    res.json({ message: '渠道删除成功' });
  } catch (e) {
    res.status(500).json({ error: '删除渠道失败' });
  }
});

router.post('/:id/test', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM proxy_channels WHERE id = ?', [req.params.id]);
    const channel = rows[0];
    if (!channel) return res.status(404).json({ error: '渠道不存在' });

    const startTime = Date.now();
    try {
      const baseUrl = channel.base_url.replace(/\/+$/, '');
      const modelsUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
      const chatUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

      let response;
      // 1. 优先尝试标准的 /models 接口 (最轻量)
      try {
        response = await fetch(modelsUrl, {
          headers: { 'Authorization': `Bearer ${channel.api_key}` },
          signal: AbortSignal.timeout(5000)
        });
      } catch (e) {
        // 忽略错误，继续尝试下一步
      }

      // 2. 如果 /models 不可用 (404/405/超时)，则尝试进行真实的对话探测
      if (!response || response.status === 404 || response.status === 405) {
        // 从 junction 取一个该渠道启用的 model_id 作为探测模型（跳过 *通配符）
        const cmRows = await query(
          `SELECT model_id FROM proxy_channel_models
            WHERE channel_id = ? AND is_enabled = 1 AND model_id <> '*'
            ORDER BY priority DESC LIMIT 1`,
          [req.params.id]
        );
        const testModel = cmRows[0]?.model_id || 'gpt-3.5-turbo';

        console.log(`[Test] 正在通过对话模式探测: ${chatUrl} (模型: ${testModel})`);

        try {
          response = await fetch(chatUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${channel.api_key}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              model: testModel,
              messages: [{ role: 'user', content: '你是谁？' }],
              max_tokens: 2,
              stream: false
            }),
            signal: AbortSignal.timeout(30000)
          });
        } catch (e) {
          throw new Error('对话端点响应超时或无法访问: ' + e.message);
        }
      }

      const latency = Date.now() - startTime;

      if (response.ok) {
        res.json({ success: true, latency, message: '连接正常' });
      } else if (response.status === 401 || response.status === 403) {
        res.json({ success: false, latency, message: '认证失败 (401/403)，请检查 API Key' });
      } else {
        const errText = await response.text().catch(() => '');
        let errMsg = `HTTP ${response.status}`;
        try {
          if (errText) {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error?.message || errJson.message || errMsg;
            if (errJson.error?.code) errMsg += ` (${errJson.error.code})`;
          }
        } catch { }
        res.json({ success: false, latency, message: errMsg });
      }
    } catch (err) {
      res.json({ success: false, latency: Date.now() - startTime, message: err.message });
    }
  } catch (e) {
    res.status(500).json({ error: '测试渠道失败' });
  }
});

module.exports = router;
