/**
 * 渠道-模型关联管理（proxy_channel_models）
 *
 * 一个渠道可以同时转发多个模型，每条关联可单独配置：
 *   - priority：路由优先级（数字大优先）
 *   - markup：加价乘数，1.0=不加，1.10=+10%（默认 1.0；优先级高于 token.price_markup）
 *   - rate_limit_rps / rate_limit_rpm：限流
 *   - is_enabled：是否启用
 *
 * 路由全部挂在父级 /api/channels/:channelId/models/* 下
 */

const express = require('express');
const { query, transaction } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

// TIME 列 → 'HH:mm:ss' 字符串（mysql2 对 TIME 可能返回带日期/数组形态，统一截取）
function fmtTime(t) {
  if (t == null) return null;
  const s = String(t);
  return s.length >= 8 ? s.slice(0, 8) : s;
}

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

/**
 * 规范化 provider_capability：以前端传的 provider_alias 为准，从 provider_capabilities 表
 * 取 domain/class_name 补全（防止手改漂移，保证与能力清单一致）。
 * 返回 { json, error, available }：
 *   - json：要写入 proxy_channel_models.provider_capability 的 JSON 字符串；null=未绑定
 *   - error：校验失败原因；available：可用 alias 列表（alias 不在表内时给前端提示）
 */
async function canonicalizeProviderCapability(pc) {
  if (pc === null || pc === undefined || pc === '') return { json: null };
  let obj = pc;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return { error: 'provider_capability 必须是 JSON 对象' }; }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return { error: 'provider_capability 必须是对象' };
  const alias = obj.provider_alias;
  if (!alias) return { error: 'provider_capability.provider_alias 必填' };

  const rows = await query('SELECT domain, class_name FROM provider_capabilities WHERE provider_alias = ?', [alias]);
  if (rows.length === 0) {
    const all = await query('SELECT provider_alias FROM provider_capabilities');
    const available = (Array.isArray(all) ? all : []).map(r => r.provider_alias);
    return { error: `provider_alias "${alias}" 不在能力清单中`, available };
  }
  const row = rows[0];
  return { json: JSON.stringify({ provider_alias: alias, domain: row.domain, class_name: row.class_name }) };
}

/** 列出指定渠道下的所有关联模型（联表 model_library 拿展示信息，联表 model_prices 拿价格） */
router.get('/', async (req, res) => {
  const { channelId } = req.params;
  try {
    const sql = 'SELECT cm.*, ' +
      'ml.display_name, ml.provider, ml.category, ml.icon_url, ml.status AS model_status, ' +
      'mp.billing_mode, mp.billing_params, ' +
      'mp.base_price AS input_price_per_m, ' +
      'mp.billing_params->>\'$.output_per_1m\' AS output_price_per_m, ' +
      'mp.billing_params->>\'$.thinking_output_per_m\' AS thinking_output_per_m, ' +
      'mp.billing_params->>\'$.cache_hit_per_1m\' AS cache_hit_per_1m, ' +
      'mp.billing_params->>\'$.cache_write_per_1m\' AS cache_write_per_1m, ' +
      'mp.billing_params->>\'$.embedding_per_1m\' AS embedding_per_1m, ' +
      'mp.billing_params->>\'$.image_per_call\' AS image_per_unit, ' +
      'mp.billing_params->>\'$.video_per_second_720p\' AS video_per_second_720p, ' +
      'mp.billing_params->>\'$.video_per_second_1080p\' AS video_per_second_1080p, ' +
      'mp.billing_params->>\'$.audio_per_minute\' AS audio_per_minute, ' +
      'mp.billing_params->>\'$.audio_per_second\' AS audio_per_second, ' +
      'mp.billing_params->>\'$.flat_price\' AS flat_price, ' +
      'mp.billing_params->>\'$.input_text_per_1m\' AS input_text_per_1m, ' +
      'mp.billing_params->>\'$.input_image_per_1m\' AS input_image_per_1m, ' +
      'mp.billing_params->>\'$.output_text_per_1m\' AS output_text_per_1m, ' +
      'mp.billing_params->>\'$.output_image_per_1m\' AS output_image_per_1m, ' +
      'mp.billing_params->>\'$.text_tokens_per_1m\' AS text_tokens_per_1m, ' +
      'mp.billing_params->>\'$.image_tokens_per_1m\' AS image_tokens_per_1m, ' +
      'mp.billing_params->>\'$.vector_tokens_per_1m\' AS vector_tokens_per_1m, ' +
      'mp.billing_params->>\'$.characters_per_1k\' AS characters_per_1k, ' +
      'mp.billing_params->>\'$."480p_noInput"\' AS `480p_noInput`, ' +
      'mp.billing_params->>\'$."480p_withInput"\' AS `480p_withInput`, ' +
      'mp.billing_params->>\'$."720p_noInput"\' AS `720p_noInput`, ' +
      'mp.billing_params->>\'$."720p_withInput"\' AS `720p_withInput`, ' +
      'mp.billing_params->>\'$."1080p_noInput"\' AS `1080p_noInput`, ' +
      'mp.billing_params->>\'$."1080p_withInput"\' AS `1080p_withInput`, ' +
      'mp.billing_params->>\'$."4k_noInput"\' AS `4k_noInput`, ' +
      'mp.billing_params->>\'$."4k_withInput"\' AS `4k_withInput`, ' +
      'CASE WHEN mpt.id IS NULL THEN 0 ELSE 1 END AS has_busy_price ' +
      'FROM proxy_channel_models cm ' +
      'LEFT JOIN model_library ml ON ml.model_id = cm.model_id ' +
      'LEFT JOIN model_prices mp ON mp.model_id = cm.model_id ' +
      'AND mp.channel_id = cm.channel_id ' +
      'AND mp.token_group_code = \'default\' ' +
      'AND mp.status = 1 ' +
      'LEFT JOIN model_price_tiers mpt ON mpt.price_id = mp.id ' +
      'AND mpt.tier_type = \'time_of_day\' ' +
      'AND mpt.status = 1 ' +
      'WHERE cm.channel_id = ? ' +
      'ORDER BY cm.priority DESC, cm.id ASC';

    const rows = await query(sql, [channelId]);
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('[channel-models] list error:', e);
    res.status(500).json({ success: false, error: '获取关联模型失败' });
  }
});

/** 获取指定渠道下某个模型的价格配置（从 model_prices 表读取） */
router.get('/:id/price', async (req, res) => {
  const { channelId, id } = req.params;
  try {
    // 先获取关联的 model_id
    const cmRows = await query(
      'SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?',
      [id, channelId]
    );
    if (cmRows.length === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    const modelId = cmRows[0].model_id;

    // 从 model_prices 读取价格
    const rows = await query(
      `SELECT id, billing_mode, base_price AS input_price_per_m,
              billing_params
         FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' AND status = 1
        ORDER BY id DESC LIMIT 1`,
      [modelId, channelId]
    );

    if (rows.length === 0) {
      // 没有设置过价格，返回空数据
      return res.json({
        success: true,
        data: {
          billing_mode: null,
          input_price_per_m: null,
          output_price_per_m: null,
          thinking_output_per_m: null,
          cache_hit_per_1m: null,
          cache_write_per_1m: null,
          embedding_per_1m: null,
          image_per_unit: null,
          video_per_second_720p: null,
          video_per_second_1080p: null,
          audio_per_minute: null,
          audio_per_second: null,
          flat_price: null,
          input_text_per_1m: null,
          input_image_per_1m: null,
          output_text_per_1m: null,
          output_image_per_1m: null,
          text_tokens_per_1m: null,
          image_tokens_per_1m: null,
          vector_tokens_per_1m: null,
          characters_per_1k: null,
          // video_token 计费模式 - Seedance 8个价格
          '480p_noInput': null,
          '480p_withInput': null,
          '720p_noInput': null,
          '720p_withInput': null,
          '1080p_noInput': null,
          '1080p_withInput': null,
          '4k_noInput': null,
          '4k_withInput': null,
        }
      });
    }

    // 解析 billing_params JSON
    const row = rows[0];
    let billingParams = {};
    try {
      billingParams = typeof row.billing_params === 'string'
        ? JSON.parse(row.billing_params)
        : (row.billing_params || {});
    } catch { /* ignore */ }

    res.json({
      success: true,
      data: {
        id: row.id,
        billing_mode: row.billing_mode,
        input_price_per_m: row.input_price_per_m,
        output_price_per_m: billingParams.output_per_1m ?? null,
        thinking_output_per_m: billingParams.thinking_output_per_m ?? null,
        cache_hit_per_1m: billingParams.cache_hit_per_1m ?? null,
        cache_write_per_1m: billingParams.cache_write_per_1m ?? null,
        embedding_per_1m: billingParams.embedding_per_1m ?? null,
        image_per_unit: billingParams.image_per_call ?? null,
        video_per_second_720p: billingParams.video_per_second_720p ?? null,
        video_per_second_1080p: billingParams.video_per_second_1080p ?? null,
        audio_per_minute: billingParams.audio_per_minute ?? null,
        audio_per_second: billingParams.audio_per_second ?? null,
        flat_price: billingParams.flat_price ?? null,
        // 图片按 tokens 计费
        input_text_per_1m: billingParams.input_text_per_1m ?? null,
        input_image_per_1m: billingParams.input_image_per_1m ?? null,
        output_text_per_1m: billingParams.output_text_per_1m ?? null,
        output_image_per_1m: billingParams.output_image_per_1m ?? null,
        // 向量模型
        text_tokens_per_1m: billingParams.text_tokens_per_1m ?? null,
        image_tokens_per_1m: billingParams.image_tokens_per_1m ?? null,
        vector_tokens_per_1m: billingParams.vector_tokens_per_1m ?? null,
        // 语音合成
        characters_per_1k: billingParams.characters_per_1k ?? null,
        // video_token 计费模式 - Seedance 8个价格
        '480p_noInput': billingParams['480p_noInput'] ?? null,
        '480p_withInput': billingParams['480p_withInput'] ?? null,
        '720p_noInput': billingParams['720p_noInput'] ?? null,
        '720p_withInput': billingParams['720p_withInput'] ?? null,
        '1080p_noInput': billingParams['1080p_noInput'] ?? null,
        '1080p_withInput': billingParams['1080p_withInput'] ?? null,
        '4k_noInput': billingParams['4k_noInput'] ?? null,
        '4k_withInput': billingParams['4k_withInput'] ?? null,
      }
    });
  } catch (e) {
    console.error('[channel-models] get price error:', e);
    res.status(500).json({ success: false, error: '获取价格失败' });
  }
});

/** 更新指定渠道下某个模型的价格配置（保存到 model_prices 表） */
router.put('/:id/price', async (req, res) => {
  const { channelId, id } = req.params;
  const {
    billing_mode,
    input_price_per_m,
    output_price_per_m,
    thinking_output_per_m,
    cache_hit_per_1m,
    cache_write_per_1m,
    embedding_per_1m,
    image_per_unit,
    video_per_second_720p,
    video_per_second_1080p,
    audio_per_minute,
    audio_per_second,
    flat_price,
    input_text_per_1m,
    input_image_per_1m,
    output_text_per_1m,
    output_image_per_1m,
    text_tokens_per_1m,
    image_tokens_per_1m,
    vector_tokens_per_1m,
    characters_per_1k,
    // video_token 计费模式 - Seedance 8个价格
    '480p_noInput': p480_noInput,
    '480p_withInput': p480_withInput,
    '720p_noInput': p720_noInput,
    '720p_withInput': p720_withInput,
    '1080p_noInput': p1080_noInput,
    '1080p_withInput': p1080_withInput,
    '4k_noInput': p4k_noInput,
    '4k_withInput': p4k_withInput,
  } = req.body || {};

  try {
    // 先获取关联的 model_id 和渠道名称
    const cmRows = await query(
      `SELECT cm.model_id, c.name AS channel_name
         FROM proxy_channel_models cm
         JOIN proxy_channels c ON c.id = cm.channel_id
        WHERE cm.id = ? AND cm.channel_id = ?`,
      [id, channelId]
    );
    if (cmRows.length === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    const { model_id: modelId, channel_name: channelName } = cmRows[0];

    // 构建 billing_params JSON
    const billingParams = {};
    if (input_price_per_m !== undefined && input_price_per_m !== null) billingParams.input_per_1m = Number(input_price_per_m);
    if (output_price_per_m !== undefined && output_price_per_m !== null) billingParams.output_per_1m = Number(output_price_per_m);
    if (thinking_output_per_m !== undefined && thinking_output_per_m !== null) billingParams.thinking_output_per_m = Number(thinking_output_per_m);
    if (cache_hit_per_1m !== undefined && cache_hit_per_1m !== null) billingParams.cache_hit_per_1m = Number(cache_hit_per_1m);
    if (cache_write_per_1m !== undefined && cache_write_per_1m !== null) billingParams.cache_write_per_1m = Number(cache_write_per_1m);
    if (embedding_per_1m !== undefined && embedding_per_1m !== null) billingParams.embedding_per_1m = Number(embedding_per_1m);
    if (image_per_unit !== undefined && image_per_unit !== null) billingParams.image_per_call = Number(image_per_unit);
    // 图片按 tokens 计费的 4 个字段
    if (input_text_per_1m !== undefined && input_text_per_1m !== null) billingParams.input_text_per_1m = Number(input_text_per_1m);
    if (input_image_per_1m !== undefined && input_image_per_1m !== null) billingParams.input_image_per_1m = Number(input_image_per_1m);
    if (output_text_per_1m !== undefined && output_text_per_1m !== null) billingParams.output_text_per_1m = Number(output_text_per_1m);
    if (output_image_per_1m !== undefined && output_image_per_1m !== null) billingParams.output_image_per_1m = Number(output_image_per_1m);
    if (text_tokens_per_1m !== undefined && text_tokens_per_1m !== null) billingParams.text_tokens_per_1m = Number(text_tokens_per_1m);
    if (image_tokens_per_1m !== undefined && image_tokens_per_1m !== null) billingParams.image_tokens_per_1m = Number(image_tokens_per_1m);
    if (vector_tokens_per_1m !== undefined && vector_tokens_per_1m !== null) billingParams.vector_tokens_per_1m = Number(vector_tokens_per_1m);
    if (characters_per_1k !== undefined && characters_per_1k !== null) billingParams.characters_per_1k = Number(characters_per_1k);
    if (video_per_second_720p !== undefined && video_per_second_720p !== null) billingParams.video_per_second_720p = Number(video_per_second_720p);
    if (video_per_second_1080p !== undefined && video_per_second_1080p !== null) billingParams.video_per_second_1080p = Number(video_per_second_1080p);
    if (audio_per_minute !== undefined && audio_per_minute !== null) billingParams.audio_per_minute = Number(audio_per_minute);
    if (audio_per_second !== undefined && audio_per_second !== null) billingParams.audio_per_second = Number(audio_per_second);
    if (flat_price !== undefined && flat_price !== null) billingParams.flat_price = Number(flat_price);
    // video_token 计费模式 - Seedance 8个价格
    if (p480_noInput !== undefined && p480_noInput !== null) billingParams['480p_noInput'] = Number(p480_noInput);
    if (p480_withInput !== undefined && p480_withInput !== null) billingParams['480p_withInput'] = Number(p480_withInput);
    if (p720_noInput !== undefined && p720_noInput !== null) billingParams['720p_noInput'] = Number(p720_noInput);
    if (p720_withInput !== undefined && p720_withInput !== null) billingParams['720p_withInput'] = Number(p720_withInput);
    if (p1080_noInput !== undefined && p1080_noInput !== null) billingParams['1080p_noInput'] = Number(p1080_noInput);
    if (p1080_withInput !== undefined && p1080_withInput !== null) billingParams['1080p_withInput'] = Number(p1080_withInput);
    if (p4k_noInput !== undefined && p4k_noInput !== null) billingParams['4k_noInput'] = Number(p4k_noInput);
    if (p4k_withInput !== undefined && p4k_withInput !== null) billingParams['4k_withInput'] = Number(p4k_withInput);

    // 检查是否已存在该渠道+模型的价格记录
    const existingRows = await query(
      `SELECT id FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default'`,
      [modelId, channelId]
    );

    if (existingRows.length > 0) {
      // 更新现有记录
      await query(
        `UPDATE model_prices
            SET billing_mode = ?,
                base_price = ?,
                billing_params = ?,
                channel_name = ?,
                updated_at = NOW()
          WHERE id = ?`,
        [
          billing_mode || 'token',
          input_price_per_m != null ? Number(input_price_per_m) : 0,
          JSON.stringify(billingParams),
          channelName,
          existingRows[0].id,
        ]
      );
    } else {
      // 插入新记录
      await query(
        `INSERT INTO model_prices
           (model_id, endpoint_type, token_group_code, billing_mode, base_price,
            billing_params, channel_id, channel_name, status, price_type)
         VALUES (?, NULL, 'default', ?, ?, ?, ?, ?, 1, 'platform')`,
        [
          modelId,
          billing_mode || 'token',
          input_price_per_m != null ? Number(input_price_per_m) : 0,
          JSON.stringify(billingParams),
          channelId,
          channelName,
        ]
      );
    }

    res.json({ success: true, message: '价格更新成功' });

    // 6) 把 image_token 价格写入 Redis 缓存（供 Java 网关查询）
    if (billing_mode === 'image_token') {
      try {
        const redisKey = `model:price:${modelId}`;
        const priceData = {
          billing_mode,
          input_text_per_1m: parseFloat(billingParams.input_text_per_1m) || 0,
          input_image_per_1m: parseFloat(billingParams.input_image_per_1m) || 0,
          output_text_per_1m: parseFloat(billingParams.output_text_per_1m) || 0,
          output_image_per_1m: parseFloat(billingParams.output_image_per_1m) || 0,
          thinking_output_per_m: parseFloat(billingParams.thinking_output_per_m) || 0,
          updated_at: Date.now(),
        };
        await redis.setex(redisKey, 3600, JSON.stringify(priceData));
        console.log(`[PriceSync] 图片Token价格已写入Redis: ${redisKey}`, priceData);
      } catch (redisErr) {
        console.error(`[PriceSync] 写入Redis价格缓存失败:`, redisErr.message);
      }
    }

    // 7) 通知 api-relay 刷新价格缓存（通过 Redis 发布消息）
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId, billing_mode, ts: Date.now() }));
      console.log(`[PriceSync] 已发布价格刷新通知: ${modelId}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[channel-models] update price error:', e);
    res.status(500).json({ success: false, error: '更新价格失败' });
  }
});

/** 读取指定渠道下某个模型的忙闲时配置（model_price_tiers + price_tier_time_ranges） */
router.get('/:id/busy-price', async (req, res) => {
  const { channelId, id } = req.params;
  try {
    const cmRows = await query(
      'SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?',
      [id, channelId]
    );
    if (cmRows.length === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    const modelId = cmRows[0].model_id;

    // 基础价记录（忙闲时挂载点；billing_mode 决定价格覆盖维度）
    const priceRows = await query(
      `SELECT id, billing_mode FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' AND status = 1
        ORDER BY id DESC LIMIT 1`,
      [modelId, channelId]
    );
    const hasBasePrice = priceRows.length > 0;
    const billingMode = hasBasePrice ? priceRows[0].billing_mode : 'token';
    const priceId = hasBasePrice ? priceRows[0].id : null;

    let tierId = null, tierName = null;
    if (priceId) {
      const tierRows = await query(
        `SELECT id, tier_name FROM model_price_tiers
          WHERE price_id = ? AND tier_type = 'time_of_day' AND status = 1
          ORDER BY priority DESC LIMIT 1`,
        [priceId]
      );
      if (tierRows.length > 0) {
        tierId = tierRows[0].id;
        tierName = tierRows[0].tier_name;
      }
    }

    let ranges = [];
    if (tierId) {
      const rangeRows = await query(
        `SELECT id, tier_name, time_start, time_end, timezone, days_of_week, priority, price_overrides
           FROM price_tier_time_ranges
          WHERE tier_id = ?
          ORDER BY priority DESC, id ASC`,
        [tierId]
      );
      ranges = rangeRows.map(r => {
        let overrides = {};
        if (r.price_overrides) {
          try {
            overrides = typeof r.price_overrides === 'string' ? JSON.parse(r.price_overrides) : r.price_overrides;
          } catch { /* ignore */ }
        }
        return {
          id: r.id,
          tier_name: r.tier_name,
          time_start: fmtTime(r.time_start),
          time_end: fmtTime(r.time_end),
          timezone: r.timezone || 'Asia/Shanghai',
          days_of_week: r.days_of_week ? String(r.days_of_week).split(',') : ['1', '2', '3', '4', '5', '6', '7'],
          priority: r.priority != null ? r.priority : 0,
          price_overrides: overrides,
        };
      });
    }

    res.json({
      success: true,
      data: {
        price_id: priceId,
        billing_mode: billingMode,
        has_base_price: hasBasePrice,
        tier_id: tierId,
        tier_name: tierName || 'busy_idle',
        ranges,
      },
    });
  } catch (e) {
    console.error('[channel-models] get busy price error:', e);
    res.status(500).json({ success: false, error: '获取忙闲时价格失败' });
  }
});

/** 保存指定渠道下某个模型的忙闲时配置（整表替换 ranges；ranges=[] 等价清空时段但保留配置） */
router.put('/:id/busy-price', async (req, res) => {
  const { channelId, id } = req.params;
  const { billing_mode, tier_name, ranges } = req.body || {};
  try {
    const cmRows = await query(
      'SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?',
      [id, channelId]
    );
    if (cmRows.length === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    const modelId = cmRows[0].model_id;

    const result = await transaction(async (conn) => {
      // 1. 确保 model_prices 有挂载记录（无基础价时自动创建，保证忙闲时可独立配置）
      const priceRows = await conn.execute(
        `SELECT id, billing_mode FROM model_prices
          WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' AND status = 1
          ORDER BY id DESC LIMIT 1`,
        [modelId, channelId]
      );
      let priceId;
      if (priceRows[0].length > 0) {
        priceId = priceRows[0][0].id;
        // 忙闲时弹窗可自由选择计费类型，同步更新基础保底价记录的计费模式，保证两侧维度一致
        const bm = billing_mode || 'token';
        const curBm = priceRows[0][0].billing_mode;
        if (curBm && curBm !== bm) {
          await conn.execute('UPDATE model_prices SET billing_mode = ? WHERE id = ?', [bm, priceId]);
        }
      } else {
        const ins = await conn.execute(
          `INSERT INTO model_prices
             (model_id, endpoint_type, token_group_code, billing_mode, base_price, billing_params, channel_id, channel_name, status, price_type)
           VALUES (?, NULL, 'default', ?, 0, '{}', ?, NULL, 1, 'platform')`,
          [modelId, billing_mode || 'token', channelId]
        );
        priceId = ins[0].insertId;
      }

      // 2. upsert model_price_tiers
      const tierRows = await conn.execute(
        `SELECT id FROM model_price_tiers
          WHERE price_id = ? AND tier_type = 'time_of_day'
          ORDER BY priority DESC LIMIT 1`,
        [priceId]
      );
      const tierNameVal = tier_name || 'busy_idle';
      let tierId;
      if (tierRows[0].length > 0) {
        tierId = tierRows[0][0].id;
        await conn.execute(
          'UPDATE model_price_tiers SET tier_name = ?, status = 1 WHERE id = ?',
          [tierNameVal, tierId]
        );
      } else {
        const ins = await conn.execute(
          `INSERT INTO model_price_tiers (price_id, tier_type, tier_name, priority, status)
           VALUES (?, 'time_of_day', ?, 0, 1)`,
          [priceId, tierNameVal]
        );
        tierId = ins[0].insertId;
      }

      // 3. 替换全部 ranges
      await conn.execute('DELETE FROM price_tier_time_ranges WHERE tier_id = ?', [tierId]);
      const list = Array.isArray(ranges) ? ranges : [];
      for (const r of list) {
        const overrides = (r.price_overrides && typeof r.price_overrides === 'object')
          ? JSON.stringify(r.price_overrides)
          : null;
        await conn.execute(
          `INSERT INTO price_tier_time_ranges
             (tier_id, tier_name, time_start, time_end, timezone, price_multiplier, days_of_week, priority, price_overrides)
           VALUES (?, ?, ?, ?, ?, 1.00, ?, ?, ?)`,
          [
            tierId,
            r.tier_name || 'slot',
            r.time_start || '00:00:00',
            r.time_end || '23:59:59',
            r.timezone || 'Asia/Shanghai',
            Array.isArray(r.days_of_week) ? r.days_of_week.join(',') : (r.days_of_week || '1,2,3,4,5,6,7'),
            r.priority != null ? r.priority : 0,
            overrides,
          ]
        );
      }

      return { priceId, tierId, rangeCount: list.length };
    });

    // 清理网关侧缓存（预留：网关忙闲时计费接入后消费；现仅清可能的遗留 key）
    try {
      await redis.del(`tier:config:${result.priceId}`);
      const cfgKeys = await redis.keys('tier:config:*');
      if (cfgKeys.length > 0) await redis.del(...cfgKeys);
      await redis.del(`channel:endpoint:${modelId}`);
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId, busy_price: true, ts: Date.now() }));
    } catch (redisErr) {
      console.error('[BusyPriceSave] 清理缓存失败:', redisErr.message);
    }

    res.json({ success: true, message: '忙闲时价格已保存', data: { ranges: result.rangeCount } });
  } catch (e) {
    console.error('[channel-models] save busy price error:', e);
    res.status(500).json({ success: false, error: '保存忙闲时价格失败' });
  }
});

/** 清空指定渠道下某个模型的忙闲时配置（物理删除 tier + ranges；无配置时幂等返回成功） */
router.delete('/:id/busy-price', async (req, res) => {
  const { channelId, id } = req.params;
  try {
    const cmRows = await query(
      'SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?',
      [id, channelId]
    );
    if (cmRows.length === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    const modelId = cmRows[0].model_id;

    const priceRows = await query(
      `SELECT id FROM model_prices
        WHERE model_id = ? AND channel_id = ? AND token_group_code = 'default' AND status = 1
        ORDER BY id DESC LIMIT 1`,
      [modelId, channelId]
    );
    if (priceRows.length === 0) {
      return res.json({ success: true, message: '忙闲时配置已清空（无基础价记录）' });
    }
    const priceId = priceRows[0].id;

    await transaction(async (conn) => {
      const tierRows = await conn.execute(
        `SELECT id FROM model_price_tiers
          WHERE price_id = ? AND tier_type = 'time_of_day'`,
        [priceId]
      );
      if (tierRows[0].length > 0) {
        const tierId = tierRows[0][0].id;
        await conn.execute('DELETE FROM price_tier_time_ranges WHERE tier_id = ?', [tierId]);
        await conn.execute('DELETE FROM model_price_tiers WHERE id = ?', [tierId]);
      }
    });

    try {
      await redis.del(`tier:config:${priceId}`);
    } catch (redisErr) { /* ignore */ }

    res.json({ success: true, message: '忙闲时配置已清空' });
  } catch (e) {
    console.error('[channel-models] clear busy price error:', e);
    res.status(500).json({ success: false, error: '清空忙闲时价格失败' });
  }
});

/** 添加一个模型到该渠道 */
router.post('/', async (req, res) => {
  const { channelId } = req.params;
  const {
    model_id,
    priority = 0,
    markup = 1.0,
    rate_limit_rps = null,
    rate_limit_rpm = null,
    is_enabled = 1,
    provider_capability,
  } = req.body || {};

  if (!model_id) {
    return res.status(400).json({ success: false, error: 'model_id 必填' });
  }

  // 规范化 provider_capability（以 provider_capabilities 表为准补全 domain/class_name）
  const cap = await canonicalizeProviderCapability(provider_capability);
  if (cap.error) {
    return res.status(400).json({ success: false, error: cap.error, available: cap.available });
  }

  try {
    const result = await query(
      `INSERT INTO proxy_channel_models
         (channel_id, model_id, provider_capability, priority, markup, rate_limit_rps, rate_limit_rpm, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [channelId, model_id, cap.json, priority, markup, rate_limit_rps, rate_limit_rpm, is_enabled]
    );
    req.audit = {
      action: 'channel_model.create',
      targetType: 'channel_model',
      targetId: result.insertId,
      after: { channel_id: channelId, model_id, provider_capability: cap.json, priority, markup, rate_limit_rps, rate_limit_rpm, is_enabled },
    };

    // 清除模型渠道配置缓存（使新关联立即生效）
    // Java 网关 (ChannelResolverServiceImpl) 使用的缓存键: channel:endpoint:{modelId}
    try {
      // 清除 Java 网关的渠道端点缓存（新关联可能影响模型路由）
      const modelId = req.body.model_id;
      if (modelId) {
        const endpointKey = `channel:endpoint:${modelId}`;
        await redis.del(endpointKey);
        console.log(`[ChannelModelCreate] 清除渠道端点缓存: ${endpointKey}`);

        // 同时清除带 channelCode 的缓存
        const endpointKeys = await redis.keys(`channel:endpoint:${modelId}:*`);
        if (endpointKeys.length > 0) {
          await redis.del(...endpointKeys);
          console.log(`[ChannelModelCreate] 清除渠道端点缓存: ${endpointKeys.length} 个带 channelCode 的键`);
        }
      }

      const keys = await redis.keys('cache:model_channel_config:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ChannelModelCreate] 清除模型渠道配置缓存: ${keys.length} 个`);
      }
      // 同时清除该渠道的上游 Token 池缓存（Java 网关使用 upstream:tokens:channel:{channelId}）
      const upstreamKey = `upstream:tokens:channel:${channelId}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelModelCreate] 清除上游 Token 缓存: ${upstreamKey}`);

      // 清除渠道模型映射缓存（新关联影响模型路由）
      const cmKeys = await redis.keys('cache:channel_models:*');
      if (cmKeys.length > 0) {
        await redis.del(...cmKeys);
        console.log(`[ChannelModelCreate] 清除渠道模型缓存: ${cmKeys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ChannelModelCreate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, id: result.insertId, message: '模型已加入渠道' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, error: '该模型已在此渠道下' });
    }
    if (e.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ success: false, error: '渠道不存在或外键约束失败' });
    }
    console.error('[channel-models] create error:', e);
    res.status(500).json({ success: false, error: '添加失败', detail: e.message });
  }
});

/** 更新单条关联（priority / markup / rate_limit / is_enabled / provider_capability） */
router.put('/:id', async (req, res) => {
  const { channelId, id } = req.params;
  const editable = ['priority', 'markup', 'rate_limit_rps', 'rate_limit_rpm', 'is_enabled'];
  const sets = [];
  const params = [];

  // provider_capability 特殊处理：规范化（以表为准补全 domain/class_name）后单独加入
  let capAfter = undefined;
  if (req.body && req.body.provider_capability !== undefined) {
    const cap = await canonicalizeProviderCapability(req.body.provider_capability);
    if (cap.error) {
      return res.status(400).json({ success: false, error: cap.error, available: cap.available });
    }
    sets.push('provider_capability = ?');
    params.push(cap.json);
    capAfter = cap.json;
  }

  for (const f of editable) {
    if (req.body && req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (sets.length === 0) {
    return res.status(400).json({ success: false, error: '无更新字段' });
  }
  try {
    const beforeRows = await query('SELECT * FROM proxy_channel_models WHERE id = ? AND channel_id = ?', [id, channelId]);
    if (beforeRows.length === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    params.push(id, channelId);
    const r = await query(
      `UPDATE proxy_channel_models SET ${sets.join(', ')} WHERE id = ? AND channel_id = ?`,
      params
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    req.audit = {
      action: 'channel_model.update',
      targetType: 'channel_model',
      targetId: id,
      before: beforeRows[0],
      after: req.body,
    };

    // 清除模型渠道配置缓存（使关联变更立即生效）
    // Java 网关 (ChannelResolverServiceImpl) 使用的缓存键: channel:endpoint:{modelId}
    try {
      // 获取 model_id 以精确清除缓存
      const modelRow = await query('SELECT model_id FROM proxy_channel_models WHERE id = ? AND channel_id = ?', [id, channelId]);
      const modelId = modelRow.length > 0 ? modelRow[0].model_id : null;

      // 清除 Java 网关的渠道端点缓存
      if (modelId) {
        const endpointKey = `channel:endpoint:${modelId}`;
        await redis.del(endpointKey);
        console.log(`[ChannelModelUpdate] 清除渠道端点缓存: ${endpointKey}`);

        // 同时清除带 channelCode 的缓存
        const endpointKeys = await redis.keys(`channel:endpoint:${modelId}:*`);
        if (endpointKeys.length > 0) {
          await redis.del(...endpointKeys);
          console.log(`[ChannelModelUpdate] 清除渠道端点缓存: ${endpointKeys.length} 个带 channelCode 的键`);
        }
      }

      const keys = await redis.keys('cache:model_channel_config:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ChannelModelUpdate] 清除模型渠道配置缓存: ${keys.length} 个`);
      }
      // 清除渠道模型映射缓存（关联变更影响模型路由）
      const cmKeys = await redis.keys('cache:channel_models:*');
      if (cmKeys.length > 0) {
        await redis.del(...cmKeys);
        console.log(`[ChannelModelUpdate] 清除渠道模型缓存: ${cmKeys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ChannelModelUpdate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '更新成功' });
  } catch (e) {
    console.error('[channel-models] update error:', e);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

/** 解除单条关联 */
router.delete('/:id', async (req, res) => {
  const { channelId, id } = req.params;
  try {
    const beforeRows = await query('SELECT * FROM proxy_channel_models WHERE id = ? AND channel_id = ?', [id, channelId]);
    const r = await query(
      `DELETE FROM proxy_channel_models WHERE id = ? AND channel_id = ?`,
      [id, channelId]
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    req.audit = {
      action: 'channel_model.delete',
      targetType: 'channel_model',
      targetId: id,
      before: beforeRows[0] || null,
    };

    // 清除模型渠道配置缓存（使关联删除立即生效）
    // Java 网关 (ChannelResolverServiceImpl) 使用的缓存键: channel:endpoint:{modelId}
    try {
      // 获取 model_id 以精确清除缓存
      const modelId = beforeRows[0] ? beforeRows[0].model_id : null;

      // 清除 Java 网关的渠道端点缓存
      if (modelId) {
        const endpointKey = `channel:endpoint:${modelId}`;
        await redis.del(endpointKey);
        console.log(`[ChannelModelDelete] 清除渠道端点缓存: ${endpointKey}`);

        // 同时清除带 channelCode 的缓存
        const endpointKeys = await redis.keys(`channel:endpoint:${modelId}:*`);
        if (endpointKeys.length > 0) {
          await redis.del(...endpointKeys);
          console.log(`[ChannelModelDelete] 清除渠道端点缓存: ${endpointKeys.length} 个带 channelCode 的键`);
        }
      }

      const keys = await redis.keys('cache:model_channel_config:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ChannelModelDelete] 清除模型渠道配置缓存: ${keys.length} 个`);
      }
      // 同时清除该渠道的上游 Token 池缓存（Java 网关使用 upstream:tokens:channel:{channelId}）
      const channelIdNum = req.params.channelId;
      const upstreamKey = `upstream:tokens:channel:${channelIdNum}`;
      await redis.del(upstreamKey);
      console.log(`[ChannelModelDelete] 清除上游 Token 缓存: ${upstreamKey}`);

      // 清除渠道模型映射缓存（关联删除影响模型路由）
      const cmKeys = await redis.keys('cache:channel_models:*');
      if (cmKeys.length > 0) {
        await redis.del(...cmKeys);
        console.log(`[ChannelModelDelete] 清除渠道模型缓存: ${cmKeys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ChannelModelDelete] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '已移除' });
  } catch (e) {
    console.error('[channel-models] delete error:', e);
    res.status(500).json({ success: false, error: '移除失败' });
  }
});

module.exports = router;
