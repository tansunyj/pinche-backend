/**
 * 渠道 Token 池管理（proxy_channel_tokens）
 *
 * 一个渠道可以挂多个上游 API Key，做负载均衡：
 *   - weight：权重（轮询/加权随机用）
 *   - status：启用/禁用
 *   - auto_disabled：连续错误自动禁用（由代理层维护）
 *   - total_requests / success_count / error_count：累计统计
 *
 * 路由全部挂在父级 /api/channels/:channelId/tokens/* 下
 *
 * 注意：api_key 字段在数据库里是加密的（api_key_encrypted），但当前实现里
 * 大多数地方直接当明文用了，为兼容老逻辑这里保持明文写入，将来上加密再统一处理。
 */

const express = require('express');
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

/** 列出渠道下所有 token（api_key 仅返回最后 4 位用于识别） */
router.get('/', async (req, res) => {
  const { channelId } = req.params;
  try {
    const rows = await query(
      `SELECT id, channel_id, name, weight, status,
              total_requests, success_count, error_count,
              consecutive_errors, auto_disabled, auto_disabled_at,
              last_used_at, created_at, updated_at,
              api_key_encrypted
         FROM proxy_channel_tokens
        WHERE channel_id = ?
        ORDER BY id ASC`,
      [channelId]
    );
    // 脱敏：仅暴露后 4 位用于展示，但保留完整值供复制
    const masked = rows.map(r => ({
      ...r,
      api_key_preview: r.api_key_encrypted
        ? `sk-****${String(r.api_key_encrypted).slice(-4)}`
        : null,
      // 保留完整 api_key_encrypted 供前端复制使用（管理后台已鉴权）
    }));
    res.json({ success: true, data: masked });
  } catch (e) {
    console.error('[channel-tokens] list error:', e);
    res.status(500).json({ success: false, error: '获取 Token 列表失败' });
  }
});

/** 添加新 token */
router.post('/', async (req, res) => {
  const { channelId } = req.params;
  const { name = 'default', api_key, weight = 1, status = 1 } = req.body || {};
  if (!api_key) {
    return res.status(400).json({ success: false, error: 'api_key 必填' });
  }
  try {
    const result = await query(
      `INSERT INTO proxy_channel_tokens
         (channel_id, name, api_key_encrypted, weight, status)
       VALUES (?, ?, ?, ?, ?)`,
      [channelId, name, api_key, weight, status]
    );
    req.audit = {
      action: 'channel_token.create',
      targetType: 'channel_token',
      targetId: result.insertId,
      after: { channel_id: channelId, name, api_key, weight, status },
    };

    // 清除该渠道的上游 Token 池缓存（新增 Token 后池子变化）
    // Java 网关 (ChannelResolverServiceImpl) 使用的缓存键前缀: upstream:tokens:channel:{channelId}
    try {
      const upstreamKey = `upstream:tokens:channel:${channelId}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelTokenCreate] 清除上游 Token 缓存: ${upstreamKey}`);
    } catch (redisErr) {
      console.error(`[ChannelTokenCreate] 清除缓存失败 (channel ${channelId}):`, redisErr.message);
    }

    res.json({ success: true, id: result.insertId, message: 'Token 已添加' });
  } catch (e) {
    if (e.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ success: false, error: '渠道不存在' });
    }
    console.error('[channel-tokens] create error:', e);
    res.status(500).json({ success: false, error: '添加失败' });
  }
});

/** 更新 token（name / weight / status / api_key） */
router.put('/:id', async (req, res) => {
  const { channelId, id } = req.params;
  const sets = [];
  const params = [];
  if (req.body && req.body.name !== undefined) {
    sets.push('name = ?'); params.push(req.body.name);
  }
  if (req.body && req.body.weight !== undefined) {
    sets.push('weight = ?'); params.push(req.body.weight);
  }
  if (req.body && req.body.status !== undefined) {
    sets.push('status = ?'); params.push(req.body.status);
    // 手动启用时，自动重置自动禁用状态
    if (req.body.status === 1 || req.body.status === true) {
      sets.push('auto_disabled = 0', 'auto_disabled_at = NULL', 'consecutive_errors = 0');
    }
  }
  if (req.body && req.body.api_key) {
    sets.push('api_key_encrypted = ?'); params.push(req.body.api_key);
  }
  // 重置自动禁用状态
  if (req.body && req.body.reset_auto_disabled) {
    sets.push('auto_disabled = 0', 'auto_disabled_at = NULL', 'consecutive_errors = 0');
  }
  if (sets.length === 0) {
    return res.status(400).json({ success: false, error: '无更新字段' });
  }
  try {
    const beforeRows = await query('SELECT * FROM proxy_channel_tokens WHERE id = ? AND channel_id = ?', [id, channelId]);
    if (beforeRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Token 不存在' });
    }
    params.push(id, channelId);
    const r = await query(
      `UPDATE proxy_channel_tokens SET ${sets.join(', ')} WHERE id = ? AND channel_id = ?`,
      params
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Token 不存在' });
    }
    req.audit = {
      action: 'channel_token.update',
      targetType: 'channel_token',
      targetId: id,
      before: beforeRows[0],
      after: req.body,
    };

    // 清除该渠道的上游 Token 池缓存（Token 状态/权重变更后池子变化）
    // Java 网关 (ChannelResolverServiceImpl) 使用的缓存键前缀: upstream:tokens:channel:{channelId}
    try {
      const upstreamKey = `upstream:tokens:channel:${channelId}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelTokenUpdate] 清除上游 Token 缓存: ${upstreamKey}`);
    } catch (redisErr) {
      console.error(`[ChannelTokenUpdate] 清除缓存失败 (channel ${channelId}):`, redisErr.message);
    }

    res.json({ success: true, message: '更新成功' });
  } catch (e) {
    console.error('[channel-tokens] update error:', e);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

/** 删除 token */
router.delete('/:id', async (req, res) => {
  const { channelId, id } = req.params;
  try {
    const beforeRows = await query('SELECT * FROM proxy_channel_tokens WHERE id = ? AND channel_id = ?', [id, channelId]);
    const r = await query(
      `DELETE FROM proxy_channel_tokens WHERE id = ? AND channel_id = ?`,
      [id, channelId]
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Token 不存在' });
    }
    req.audit = {
      action: 'channel_token.delete',
      targetType: 'channel_token',
      targetId: id,
      before: beforeRows[0] || null,
    };

    // 清除该渠道的上游 Token 池缓存（Token 删除后池子变化）
    // Java 网关 (ChannelResolverServiceImpl) 使用的缓存键前缀: upstream:tokens:channel:{channelId}
    try {
      const upstreamKey = `upstream:tokens:channel:${channelId}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelTokenDelete] 清除上游 Token 缓存: ${upstreamKey}`);
    } catch (redisErr) {
      console.error(`[ChannelTokenDelete] 清除缓存失败 (channel ${channelId}):`, redisErr.message);
    }

    res.json({ success: true, message: '已删除' });
  } catch (e) {
    console.error('[channel-tokens] delete error:', e);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

module.exports = router;
