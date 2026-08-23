/**
 * 模型广场（Model Marketplace）路由
 * 依据：requirements/model-marketplace-schema-analysis.md
 *
 * 路由分层：
 *   /api/marketplace/*        ── 公开接口（列表 / 详情 / 令牌组），无需鉴权
 *   /api/marketplace/admin/*  ── 管理接口（CRUD），需要 authMiddleware
 *
 * 涉及表：
 *   model_library / model_endpoints / model_prices / model_token_groups / model_discounts
 */

const express = require('express');
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

const publicRouter = express.Router();
const adminRouter = express.Router();
adminRouter.use(authMiddleware);

// =============================================================
// 工具函数
// =============================================================

/** 安全解析 JSON（库里 JSON 列已自动解析，但兼容字符串场景） */
function parseJson(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** 把 model_library 行转成对外 JSON 形态 */
function shapeLibraryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    model_id: row.model_id,
    display_name: row.display_name,
    description: row.description,
    category: row.category,
    provider: row.provider,
    capabilities: parseJson(row.capabilities, []) || [],
    context_window: row.context_window,
    max_output_tokens: row.max_output_tokens,
    training_data_cutoff: row.training_data_cutoff,
    status: row.status,
    is_visible: row.is_visible,
    is_hot: row.is_hot,
    is_new: row.is_new,
    badge_text: row.badge_text,
    badge_color: row.badge_color,
    sort_order: row.sort_order,
    icon_url: row.icon_url,
    doc_url: row.doc_url,
    metadata: parseJson(row.metadata, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 把 model_endpoints 行转成对外形态 */
function shapeEndpointRow(row) {
  return {
    id: row.id,
    model_id: row.model_id,
    endpoint_type: row.endpoint_type,
    endpoint_path: row.endpoint_path,
    is_default: !!row.is_default,
    status: row.status,
    sort_order: row.sort_order,
  };
}

/** 把 model_prices 行转成对外形态 */
function shapePriceRow(row) {
  return {
    id: row.id,
    model_id: row.model_id,
    endpoint_type: row.endpoint_type, // 可能为 NULL（=适用所有端点）
    token_group_code: row.token_group_code,
    is_auto_derived: !!row.is_auto_derived,
    price_type: row.price_type,
    billing_mode: row.billing_mode,
    base_price: Number(row.base_price ?? 0),
    billing_params: parseJson(row.billing_params, {}) || {},
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    status: row.status,
    is_promotional: !!row.is_promotional,
  };
}

/** 给定一个 default 组的价格 + 倍率，按 multiplier 算出派生价格 */
function multiplyParams(params, multiplier) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (typeof v === 'number') {
      out[k] = Number((v * multiplier).toFixed(4));
    } else {
      out[k] = v;
    }
  }
  return out;
}

// =============================================================
// 公开路由：令牌组字典
// =============================================================

publicRouter.get('/groups', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM model_token_groups WHERE status = 1 ORDER BY sort_order ASC, id ASC`
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('[marketplace] groups list error:', e);
    res.status(500).json({ success: false, error: '获取令牌组失败' });
  }
});

// =============================================================
// 公开路由：模型列表（含 search / filter / 聚合）
// =============================================================

publicRouter.get('/models', async (req, res) => {
  try {
    const {
      q = '',
      provider,
      category,
      capability,
      endpoint_type,
      include_invisible, // 仅管理员预览时使用
      page = 1,
      page_size = 100,
    } = req.query;

    console.log('[Debug] Marketplace Request:', { q, provider, category, capability, endpoint_type, include_invisible, page, page_size });

    const conds = ['ml.status = 1'];
    const params = [];
    if (!include_invisible) {
      conds.push('ml.is_visible = 1');
    }
    if (q && String(q).trim()) {
      conds.push('(ml.display_name LIKE ? OR ml.model_id LIKE ? OR ml.description LIKE ?)');
      const like = `%${String(q).trim()}%`;
      params.push(like, like, like);
    }
    if (provider) {
      conds.push('ml.provider = ?');
      params.push(provider);
    }
    if (category) {
      conds.push('ml.category = ?');
      params.push(category);
    }
    if (capability) {
      conds.push('JSON_CONTAINS(ml.capabilities, ?)');
      params.push(JSON.stringify(capability));
    }
    if (endpoint_type) {
      conds.push('EXISTS (SELECT 1 FROM model_endpoints me WHERE me.model_id = ml.model_id AND me.endpoint_type = ? AND me.status = 1)');
      params.push(endpoint_type);
    }

    const limit = Math.min(500, Math.max(1, parseInt(page_size) || 100));
    const offset = Math.max(0, (Math.max(1, parseInt(page) || 1) - 1) * limit);

    const librarySql = `SELECT ml.* FROM model_library ml
       WHERE ${conds.join(' AND ')}
       ORDER BY ml.is_hot DESC, ml.sort_order ASC, ml.id ASC
       LIMIT ${limit} OFFSET ${offset}`;

    console.log('[Debug] Marketplace SQL:', librarySql);
    console.log('[Debug] Marketplace Params:', params);

    const libraryRows = await query(librarySql, params);
    console.log('[Debug] Library Rows Count:', libraryRows.length);
    console.log('[Debug] Library Rows IDs:', libraryRows.map(r => r.model_id));

    if (libraryRows.length === 0) {
      console.log('[Debug] No models found, returning empty');
      return res.json({ success: true, data: [], total: 0 });
    }

    if (libraryRows.length === 0) {
      return res.json({ success: true, data: [], total: 0 });
    }

    const ids = libraryRows.map(r => r.model_id);
    const placeholders = ids.map(() => '?').join(',');

    const [endpointRows, priceRows] = await Promise.all([
      query(
        `SELECT * FROM model_endpoints WHERE model_id IN (${placeholders}) AND status = 1 ORDER BY sort_order ASC`,
        ids
      ),
      query(
        `SELECT * FROM model_prices WHERE model_id IN (${placeholders}) AND status = 1`,
        ids
      ),
    ]);

    const endpointsByModel = {};
    for (const e of endpointRows) {
      (endpointsByModel[e.model_id] ||= []).push(shapeEndpointRow(e));
    }
    const pricesByModel = {};
    for (const p of priceRows) {
      (pricesByModel[p.model_id] ||= []).push(shapePriceRow(p));
    }

    const data = libraryRows.map(r => ({
      ...shapeLibraryRow(r),
      endpoints: endpointsByModel[r.model_id] || [],
      prices: pricesByModel[r.model_id] || [],
    }));

    // 总数
    const [countRow] = await query(
      `SELECT COUNT(*) as cnt FROM model_library ml WHERE ${conds.join(' AND ')}`,
      params
    );

    res.json({ success: true, data, total: countRow.cnt });
  } catch (e) {
    console.error('[marketplace] models list error:', e);
    res.status(500).json({ success: false, error: '获取模型列表失败', detail: e.message });
  }
});

// =============================================================
// 公开路由：模型详情
// =============================================================

publicRouter.get('/models/:modelId', async (req, res) => {
  try {
    const { modelId } = req.params;
    const [row] = await query(`SELECT * FROM model_library WHERE model_id = ?`, [modelId]);
    if (!row) return res.status(404).json({ success: false, error: '模型不存在' });

    const [endpoints, prices] = await Promise.all([
      query(`SELECT * FROM model_endpoints WHERE model_id = ? AND status = 1 ORDER BY sort_order ASC`, [modelId]),
      query(`SELECT * FROM model_prices WHERE model_id = ? AND status = 1 ORDER BY token_group_code, endpoint_type`, [modelId]),
    ]);

    res.json({
      success: true,
      data: {
        ...shapeLibraryRow(row),
        endpoints: endpoints.map(shapeEndpointRow),
        prices: prices.map(shapePriceRow),
      },
    });
  } catch (e) {
    console.error('[marketplace] model detail error:', e);
    res.status(500).json({ success: false, error: '获取模型详情失败' });
  }
});

// =============================================================
// 公开路由：筛选项字典（厂商 / 类型 / 能力 / 端点）
// =============================================================

publicRouter.get('/filters', async (req, res) => {
  try {
    const [providers, categories, endpoints, groups] = await Promise.all([
      query(`SELECT DISTINCT provider FROM model_library WHERE status=1 AND is_visible=1 AND provider IS NOT NULL`),
      query(`SELECT DISTINCT category FROM model_library WHERE status=1 AND is_visible=1 AND category IS NOT NULL`),
      query(`SELECT DISTINCT endpoint_type FROM model_endpoints WHERE status=1`),
      query(`SELECT * FROM model_token_groups WHERE status=1 ORDER BY sort_order ASC`),
    ]);
    res.json({
      success: true,
      data: {
        providers: providers.map(r => r.provider),
        categories: categories.map(r => r.category),
        endpoints: endpoints.map(r => r.endpoint_type),
        token_groups: groups,
      },
    });
  } catch (e) {
    console.error('[marketplace] filters error:', e);
    res.status(500).json({ success: false, error: '获取筛选项失败' });
  }
});

// =============================================================
// 管理路由：令牌组 CRUD
// =============================================================

adminRouter.get('/groups', async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM model_token_groups ORDER BY sort_order ASC, id ASC`);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

adminRouter.post('/groups', async (req, res) => {
  const { code, name, description, price_multiplier = 1.0, color, sort_order = 0, status = 1 } = req.body || {};
  if (!code || !name) return res.status(400).json({ success: false, error: 'code 和 name 必填' });
  try {
    const result = await query(
      `INSERT INTO model_token_groups (code, name, description, price_multiplier, color, sort_order, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, name, description ?? null, price_multiplier, color ?? null, sort_order, status]
    );
    res.json({ success: true, id: result.insertId, message: '令牌组创建成功' });

    // 通知 api-relay 刷新令牌组缓存
    try {
      await redis.publish('api-relay:reload-groups', JSON.stringify({ ts: Date.now() }));
      console.log(`[GroupSync] 令牌组创建后已发布刷新通知`);
    } catch (redisErr) {
      console.error(`[GroupSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, error: 'code 已存在' });
    console.error('[marketplace] groups create error:', e);
    res.status(500).json({ success: false, error: '创建失败' });
  }
});

adminRouter.put('/groups/:code', async (req, res) => {
  const { code } = req.params;
  const fields = ['name', 'description', 'price_multiplier', 'color', 'sort_order', 'status'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (req.body && req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ success: false, error: '无更新字段' });
  params.push(code);
  try {
    const r = await query(`UPDATE model_token_groups SET ${sets.join(', ')} WHERE code = ?`, params);
    if (r.affectedRows === 0) return res.status(404).json({ success: false, error: '令牌组不存在' });
    res.json({ success: true, message: '更新成功' });

    // 通知 api-relay 刷新令牌组缓存
    try {
      await redis.publish('api-relay:reload-groups', JSON.stringify({ ts: Date.now() }));
      console.log(`[GroupSync] 令牌组更新后已发布刷新通知`);
    } catch (redisErr) {
      console.error(`[GroupSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] groups update error:', e);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

adminRouter.delete('/groups/:code', async (req, res) => {
  const { code } = req.params;
  if (code === 'default') return res.status(400).json({ success: false, error: '默认组不可删除' });
  try {
    // 检查是否有价格行依赖
    const [usage] = await query(`SELECT COUNT(*) as cnt FROM model_prices WHERE token_group_code = ?`, [code]);
    if (usage.cnt > 0) {
      return res.status(409).json({ success: false, error: `仍有 ${usage.cnt} 条价格记录使用此组，无法删除` });
    }
    await query(`DELETE FROM model_token_groups WHERE code = ?`, [code]);
    res.json({ success: true, message: '删除成功' });

    // 通知 api-relay 刷新令牌组缓存
    try {
      await redis.publish('api-relay:reload-groups', JSON.stringify({ ts: Date.now() }));
      console.log(`[GroupSync] 令牌组删除后已发布刷新通知`);
    } catch (redisErr) {
      console.error(`[GroupSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] groups delete error:', e);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

// =============================================================
// 管理路由：模型主数据 CRUD
// =============================================================

adminRouter.get('/models', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM model_library ORDER BY sort_order ASC, id DESC`
    );

    if (rows.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // 查询所有模型的价格数据
    const ids = rows.map(r => r.model_id);
    const placeholders = ids.map(() => '?').join(',');

    const priceRows = await query(
      `SELECT * FROM model_prices WHERE model_id IN (${placeholders}) AND status = 1`,
      ids
    );

    const pricesByModel = {};
    for (const p of priceRows) {
      (pricesByModel[p.model_id] ||= []).push(shapePriceRow(p));
    }

    const data = rows.map(r => ({
      ...shapeLibraryRow(r),
      prices: pricesByModel[r.model_id] || [],
    }));

    res.json({ success: true, data });
  } catch (e) {
    console.error('[marketplace] admin models list error:', e);
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

adminRouter.post('/models', async (req, res) => {
  const b = req.body || {};
  const required = ['model_id', 'display_name', 'category', 'provider'];
  for (const k of required) if (!b[k]) return res.status(400).json({ success: false, error: `${k} 必填` });

  try {
    await query(
      `INSERT INTO model_library
        (model_id, display_name, description, category, provider, capabilities,
         context_window, max_output_tokens, training_data_cutoff, status, is_visible,
         is_hot, is_new, badge_text, badge_color, sort_order, icon_url, doc_url, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.model_id, b.display_name, b.description ?? null, b.category, b.provider,
        b.capabilities ? JSON.stringify(b.capabilities) : null,
        b.context_window ?? null, b.max_output_tokens ?? null, b.training_data_cutoff ?? null,
        b.status ?? 1, b.is_visible ?? 1,
        b.is_hot ? 1 : 0, b.is_new ? 1 : 0,
        b.badge_text ?? null, b.badge_color ?? null,
        b.sort_order ?? 0, b.icon_url ?? null, b.doc_url ?? null,
        b.metadata ? JSON.stringify(b.metadata) : null,
      ]
    );

    // 可选：一次性创建 endpoints / 默认价 / 自动派生
    if (Array.isArray(b.endpoints) && b.endpoints.length > 0) {
      for (const ep of b.endpoints) {
        await query(
          `INSERT INTO model_endpoints (model_id, endpoint_type, endpoint_path, is_default, status, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [b.model_id, ep.endpoint_type, ep.endpoint_path, ep.is_default ? 1 : 0, ep.status ?? 1, ep.sort_order ?? 0]
        );
      }
    }
    if (b.default_price && b.default_price.billing_params) {
      await upsertDefaultAndDerive(b.model_id, b.default_price);
    }

    req.audit = {
      action: 'marketplace.model.create',
      targetType: 'marketplace.model',
      targetId: b.model_id,
      after: b,
    };
    res.json({ success: true, message: '模型创建成功', model_id: b.model_id });

    // 通知 api-relay 刷新价格缓存
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId: b.model_id, ts: Date.now() }));
      console.log(`[PriceSync] 模型创建后已发布价格刷新通知: ${b.model_id}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, error: 'model_id 已存在' });
    console.error('[marketplace] models create error:', e);
    res.status(500).json({ success: false, error: '创建失败', detail: e.message });
  }
});

adminRouter.put('/models/:modelId', async (req, res) => {
  const { modelId } = req.params;
  const b = req.body || {};
  const editable = [
    'display_name', 'description', 'category', 'provider',
    'context_window', 'max_output_tokens', 'training_data_cutoff',
    'status', 'is_visible', 'is_hot', 'is_new', 'badge_text', 'badge_color',
    'sort_order', 'icon_url', 'doc_url',
  ];
  const sets = [];
  const params = [];
  for (const f of editable) {
    if (b[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(b[f]);
    }
  }
  if (b.capabilities !== undefined) {
    sets.push('capabilities = ?');
    params.push(b.capabilities ? JSON.stringify(b.capabilities) : null);
  }
  if (b.metadata !== undefined) {
    sets.push('metadata = ?');
    params.push(b.metadata ? JSON.stringify(b.metadata) : null);
  }
  if (sets.length === 0) return res.status(400).json({ success: false, error: '无更新字段' });
  try {
    const beforeRows = await query('SELECT * FROM model_library WHERE model_id = ?', [modelId]);
    if (beforeRows.length === 0) return res.status(404).json({ success: false, error: '模型不存在' });
    params.push(modelId);
    const r = await query(`UPDATE model_library SET ${sets.join(', ')} WHERE model_id = ?`, params);
    if (r.affectedRows === 0) return res.status(404).json({ success: false, error: '模型不存在' });
    req.audit = {
      action: 'marketplace.model.update',
      targetType: 'marketplace.model',
      targetId: modelId,
      before: beforeRows[0],
      after: b,
    };
    res.json({ success: true, message: '更新成功' });

    // 通知 api-relay 刷新价格缓存
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId, ts: Date.now() }));
      console.log(`[PriceSync] 模型更新后已发布价格刷新通知: ${modelId}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] models update error:', e);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

adminRouter.delete('/models/:modelId', async (req, res) => {
  const { modelId } = req.params;
  try {
    const beforeRows = await query('SELECT * FROM model_library WHERE model_id = ?', [modelId]);
    // model_endpoints / model_prices 均设了 ON DELETE CASCADE
    const r = await query(`DELETE FROM model_library WHERE model_id = ?`, [modelId]);
    if (r.affectedRows === 0) return res.status(404).json({ success: false, error: '模型不存在' });
    req.audit = {
      action: 'marketplace.model.delete',
      targetType: 'marketplace.model',
      targetId: modelId,
      before: beforeRows[0] || null,
    };
    res.json({ success: true, message: '删除成功（关联端点/价格已级联删除）' });

    // 通知 api-relay 刷新价格缓存
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId, ts: Date.now() }));
      console.log(`[PriceSync] 模型删除后已发布价格刷新通知: ${modelId}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] models delete error:', e);
    res.status(500).json({ success: false, error: '删除失败', detail: e.message });
  }
});

// =============================================================
// 管理路由：端点子资源 CRUD
// =============================================================

adminRouter.get('/models/:modelId/endpoints', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM model_endpoints WHERE model_id = ? ORDER BY sort_order ASC`,
      [req.params.modelId]
    );
    res.json({ success: true, data: rows.map(shapeEndpointRow) });
  } catch (e) {
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

adminRouter.post('/models/:modelId/endpoints', async (req, res) => {
  const { modelId } = req.params;
  const { endpoint_type, endpoint_path, is_default = 0, status = 1, sort_order = 0 } = req.body || {};
  if (!endpoint_type || !endpoint_path) {
    return res.status(400).json({ success: false, error: 'endpoint_type 和 endpoint_path 必填' });
  }
  try {
    const r = await query(
      `INSERT INTO model_endpoints (model_id, endpoint_type, endpoint_path, is_default, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [modelId, endpoint_type, endpoint_path, is_default ? 1 : 0, status, sort_order]
    );
    req.audit = {
      action: 'marketplace.endpoint.create',
      targetType: 'marketplace.endpoint',
      targetId: r.insertId,
      after: { model_id: modelId, endpoint_type, endpoint_path, is_default, status, sort_order },
    };
    res.json({ success: true, id: r.insertId, message: '端点创建成功' });

    // 通知 api-relay 刷新端点缓存
    try {
      await redis.publish('api-relay:reload-endpoints', JSON.stringify({ modelId, ts: Date.now() }));
      console.log(`[EndpointSync] 端点创建后已发布刷新通知: ${modelId}`);
    } catch (redisErr) {
      console.error(`[EndpointSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, error: '该模型已有此端点' });
    if (e.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ success: false, error: '模型不存在' });
    console.error('[marketplace] endpoint create error:', e);
    res.status(500).json({ success: false, error: '创建失败' });
  }
});

adminRouter.put('/models/:modelId/endpoints/:id', async (req, res) => {
  const { modelId, id } = req.params;
  const editable = ['endpoint_type', 'endpoint_path', 'is_default', 'status', 'sort_order'];
  const sets = [];
  const params = [];
  for (const f of editable) {
    if (req.body && req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ success: false, error: '无更新字段' });
  params.push(id, modelId);
  try {
    const r = await query(
      `UPDATE model_endpoints SET ${sets.join(', ')} WHERE id = ? AND model_id = ?`,
      params
    );
    if (r.affectedRows === 0) return res.status(404).json({ success: false, error: '端点不存在' });
    res.json({ success: true, message: '更新成功' });

    // 通知 api-relay 刷新端点缓存
    try {
      await redis.publish('api-relay:reload-endpoints', JSON.stringify({ modelId, ts: Date.now() }));
      console.log(`[EndpointSync] 端点更新后已发布刷新通知: ${modelId}`);
    } catch (redisErr) {
      console.error(`[EndpointSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] endpoint update error:', e);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

adminRouter.delete('/models/:modelId/endpoints/:id', async (req, res) => {
  const { modelId, id } = req.params;
  try {
    const r = await query(
      `DELETE FROM model_endpoints WHERE id = ? AND model_id = ?`,
      [id, modelId]
    );
    if (r.affectedRows === 0) return res.status(404).json({ success: false, error: '端点不存在' });
    res.json({ success: true, message: '删除成功' });

    // 通知 api-relay 刷新端点缓存
    try {
      await redis.publish('api-relay:reload-endpoints', JSON.stringify({ modelId, ts: Date.now() }));
      console.log(`[EndpointSync] 端点删除后已发布刷新通知: ${modelId}`);
    } catch (redisErr) {
      console.error(`[EndpointSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] endpoint delete error:', e);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

// =============================================================
// 管理路由：价格 CRUD（核心：支持倍率自动派生）
// =============================================================

/**
 * 同步价格到 proxy_model_prices（api-relay 实际计费使用）
 * @param {string} modelId - 模型ID
 * @param {string} billingMode - billing_mode (token/image/video_second)
 * @param {object} params - billing_params
 */
async function syncToProxyPrices(modelId, billingMode, params) {
  try {
    // 确定 type 和提取对应的价格
    let type = 'flat';
    let inputPrice = 0;
    let outputPrice = 0;
    let thinkingOutputPrice = 0;
    let imagePrice = 0;
    let videoPrice720 = 0;
    let videoPrice1080 = 0;
    let tierLabel = '固定单价';

    if (billingMode === 'token') {
      type = 'flat';
      inputPrice = parseFloat(params.input_per_1m) || 0;
      outputPrice = parseFloat(params.output_per_1m) || 0;
      thinkingOutputPrice = parseFloat(params.thinking_output_per_m) || outputPrice;
      tierLabel = '按Token计费';
    } else if (billingMode === 'image') {
      type = 'image';
      // billing_params 中的价格是"点数"，需要转换为"元"（除以100000）
      // 优先使用 image_per_call，兼容 unit_price_per_image
      imagePrice = (parseFloat(params.image_per_call || params.unit_price_per_image) || 0) / 100000;
      tierLabel = '按张计费';
    } else if (billingMode === 'video_second') {
      type = 'video';
      // 优先使用 video_per_second_720p/video_per_second_1080p，兼容旧字段名
      videoPrice720 = (parseFloat(params.video_per_second_720p || params.unit_price_per_second) || 0) / 100000;
      videoPrice1080 = (parseFloat(params.video_per_second_1080p || params.unit_price_per_second_1080 || (params.video_per_second_720p || params.unit_price_per_second) * 2) || 0) / 100000;
      tierLabel = '按秒计费';
    } else if (billingMode === 'video_token') {
      // 视频按Token计费（Seedance）- 使用预估价格配置
      type = 'video_token';
      videoPrice720 = parseFloat(params.price_per_second_720p) || 0;
      videoPrice1080 = parseFloat(params.price_per_second_1080p) || 0;
      tierLabel = '视频按Token计费';
    }

    // 构建 config_json（存储额外配置，如 video_token 的8个价格）
    let configJson = null;
    if (billingMode === 'video_token') {
      configJson = JSON.stringify({
        '480p_noInput': parseFloat(params['480p_noInput']) || 46.00,
        '480p_withInput': parseFloat(params['480p_withInput']) || 28.00,
        '720p_noInput': parseFloat(params['720p_noInput']) || 46.00,
        '720p_withInput': parseFloat(params['720p_withInput']) || 28.00,
        '1080p_noInput': parseFloat(params['1080p_noInput']) || 51.00,
        '1080p_withInput': parseFloat(params['1080p_withInput']) || 31.00,
        '4k_noInput': parseFloat(params['4k_noInput']) || 26.00,
        '4k_withInput': parseFloat(params['4k_withInput']) || 16.00,
      });
    }

    // 检查是否已存在
    const existing = await query(
      'SELECT id FROM proxy_model_prices WHERE model = ?',
      [modelId]
    );

    if (existing.length > 0) {
      // 更新
      await query(
        `UPDATE proxy_model_prices
         SET type = ?,
             input_price_per_m = ?,
             output_price_per_m = ?,
             thinking_output_per_m = ?,
             price_per_image = ?,
             price_per_second_720 = ?,
             price_per_second_1080 = ?,
             tier_label = ?,
             config_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE model = ?`,
        [type, inputPrice, outputPrice, thinkingOutputPrice,
         imagePrice, videoPrice720, videoPrice1080, tierLabel, configJson, modelId]
      );
      console.log(`[PriceSync] 更新 proxy_model_prices: ${modelId}, type=${type}`);
    } else {
      // 插入
      await query(
        `INSERT INTO proxy_model_prices
         (model, type, input_price_per_m, output_price_per_m, thinking_output_per_m,
          price_per_image, price_per_second_720, price_per_second_1080, tier_label, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [modelId, type, inputPrice, outputPrice, thinkingOutputPrice,
         imagePrice, videoPrice720, videoPrice1080, tierLabel, configJson]
      );
      console.log(`[PriceSync] 插入 proxy_model_prices: ${modelId}, type=${type}`);
    }
  } catch (err) {
    console.error('[PriceSync] 同步到 proxy_model_prices 失败:', err.message);
    // 抛出错误让上层知道同步失败
    throw new Error(`同步到 proxy_model_prices 失败: ${err.message}`);
  }
}

/**
 * 把"默认组"的价格落库 + 按 model_token_groups.price_multiplier 自动派生其他组
 * @param {string} modelId
 * @param {object} payload
 *   - endpoint_type: string|null（NULL=适用所有端点）
 *   - billing_mode: 'token'|'image'|...
 *   - billing_params: { input_per_1m, output_per_1m, cache_hit_per_1m, ... }
 *   - price_type: 'platform'|'official'|'promotional'，默认 'platform'
 *   - skip_groups: string[] 不要派生的组 code
 */
async function upsertDefaultAndDerive(modelId, payload) {
  const {
    endpoint_type = null,
    billing_mode = 'token',
    billing_params,
    price_type = 'platform',
    skip_groups = [],
  } = payload;

  if (!billing_params || typeof billing_params !== 'object') {
    throw new Error('billing_params 必填且必须是对象');
  }

  // 1) upsert default 组
  const existing = await query(
    `SELECT id FROM model_prices
      WHERE model_id = ? AND token_group_code = 'default'
        AND (endpoint_type <=> ?) AND price_type = ?
      LIMIT 1`,
    [modelId, endpoint_type, price_type]
  );

  if (existing.length > 0) {
    await query(
      `UPDATE model_prices
          SET billing_mode = ?, billing_params = ?, is_auto_derived = 0,
              valid_from = CURRENT_TIMESTAMP, status = 1
        WHERE id = ?`,
      [billing_mode, JSON.stringify(billing_params), existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO model_prices
        (model_id, endpoint_type, token_group_code, is_auto_derived,
         price_type, billing_mode, base_price, billing_params, valid_from, status, is_promotional)
       VALUES (?, ?, 'default', 0, ?, ?, 0, ?, CURRENT_TIMESTAMP, 1, 0)`,
      [modelId, endpoint_type, price_type, billing_mode, JSON.stringify(billing_params)]
    );
  }

  // 2) 派生其他组
  const groups = await query(
    `SELECT code, price_multiplier FROM model_token_groups
      WHERE status = 1 AND code <> 'default'`
  );
  for (const g of groups) {
    if (skip_groups.includes(g.code)) continue;

    // 只覆盖 is_auto_derived = 1 的行；如果管理员手动覆盖过（is_auto_derived = 0），保留不动
    const found = await query(
      `SELECT id, is_auto_derived FROM model_prices
        WHERE model_id = ? AND token_group_code = ?
          AND (endpoint_type <=> ?) AND price_type = ?
        LIMIT 1`,
      [modelId, g.code, endpoint_type, price_type]
    );

    const derivedParams = multiplyParams(billing_params, Number(g.price_multiplier));

    if (found.length === 0) {
      await query(
        `INSERT INTO model_prices
          (model_id, endpoint_type, token_group_code, is_auto_derived,
           price_type, billing_mode, base_price, billing_params, valid_from, status, is_promotional)
         VALUES (?, ?, ?, 1, ?, ?, 0, ?, CURRENT_TIMESTAMP, 1, 0)`,
        [modelId, endpoint_type, g.code, price_type, billing_mode, JSON.stringify(derivedParams)]
      );
    } else if (found[0].is_auto_derived) {
      await query(
        `UPDATE model_prices
            SET billing_mode = ?, billing_params = ?, is_auto_derived = 1,
                valid_from = CURRENT_TIMESTAMP, status = 1
          WHERE id = ?`,
        [billing_mode, JSON.stringify(derivedParams), found[0].id]
      );
    }
    // is_auto_derived = 0 的手动行不动
  }

  // 3) 同步到 proxy_model_prices（api-relay 实际计费使用）
  await syncToProxyPrices(modelId, billing_mode, billing_params);

  // 4) 把 image_token 价格写入 Redis 缓存（供 Java 网关查询）
  if (billing_mode === 'image_token') {
    try {
      const redisKey = `model:price:${modelId}`;
      const priceData = {
        billing_mode,
        input_text_per_1m: parseFloat(billing_params.input_text_per_1m) || 0,
        input_image_per_1m: parseFloat(billing_params.input_image_per_1m) || 0,
        output_text_per_1m: parseFloat(billing_params.output_text_per_1m) || 0,
        output_image_per_1m: parseFloat(billing_params.output_image_per_1m) || 0,
        updated_at: Date.now(),
      };
      await redis.setex(redisKey, 3600, JSON.stringify(priceData));
      console.log(`[PriceSync] 图片Token价格已写入Redis: ${redisKey}`, priceData);
    } catch (redisErr) {
      console.error(`[PriceSync] 写入Redis价格缓存失败:`, redisErr.message);
    }
  }

  // 5) 通知 api-relay 刷新价格缓存（通过 Redis 发布消息）
  try {
    await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId, billing_mode, ts: Date.now() }));
    console.log(`[PriceSync] 已发布价格刷新通知: ${modelId}`);
  } catch (redisErr) {
    console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
  }
}

adminRouter.get('/models/:modelId/prices', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM model_prices WHERE model_id = ? ORDER BY token_group_code, endpoint_type`,
      [req.params.modelId]
    );
    res.json({ success: true, data: rows.map(shapePriceRow) });
  } catch (e) {
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

/** 落入一个默认组价格 + 自动派生其他组（推荐管理员主用） */
adminRouter.post('/models/:modelId/prices/default', async (req, res) => {
  try {
    await upsertDefaultAndDerive(req.params.modelId, req.body || {});
    res.json({ success: true, message: '默认组价格已写入并自动派生其他组' });

    // 通知 api-relay 刷新价格缓存
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId: req.params.modelId, ts: Date.now() }));
      console.log(`[PriceSync] 已发布价格刷新通知: ${req.params.modelId}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] price default upsert error:', e);
    res.status(400).json({ success: false, error: e.message || '操作失败' });
  }
});

/** 仅对某条价格行做手动覆盖（is_auto_derived = 0） */
adminRouter.put('/models/:modelId/prices/:id', async (req, res) => {
  const { modelId, id } = req.params;
  const editable = ['billing_mode', 'price_type', 'is_promotional', 'status', 'valid_from', 'valid_until', 'description'];
  const sets = [];
  const params = [];
  for (const f of editable) {
    if (req.body && req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (req.body && req.body.billing_params !== undefined) {
    sets.push('billing_params = ?', 'is_auto_derived = 0');
    params.push(JSON.stringify(req.body.billing_params));
  }
  if (sets.length === 0) return res.status(400).json({ success: false, error: '无更新字段' });
  params.push(id, modelId);
  try {
    const r = await query(
      `UPDATE model_prices SET ${sets.join(', ')} WHERE id = ? AND model_id = ?`,
      params
    );
    if (r.affectedRows === 0) return res.status(404).json({ success: false, error: '价格不存在' });
    res.json({ success: true, message: '价格已手动覆盖（不再随倍率派生）' });

    // 通知 api-relay 刷新价格缓存
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId: req.params.modelId, ts: Date.now() }));
      console.log(`[PriceSync] 已发布价格刷新通知: ${req.params.modelId}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] price update error:', e);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

adminRouter.delete('/models/:modelId/prices/:id', async (req, res) => {
  const { modelId, id } = req.params;
  try {
    const r = await query(`DELETE FROM model_prices WHERE id = ? AND model_id = ?`, [id, modelId]);
    if (r.affectedRows === 0) return res.status(404).json({ success: false, error: '价格不存在' });
    res.json({ success: true, message: '删除成功' });

    // 通知 api-relay 刷新价格缓存
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId: req.params.modelId, ts: Date.now() }));
      console.log(`[PriceSync] 已发布价格刷新通知: ${req.params.modelId}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

/** 重新派生：基于 default 组的当前价 + 当前倍率刷新所有 auto_derived 行 */
adminRouter.post('/models/:modelId/prices/rederive', async (req, res) => {
  const { modelId } = req.params;
  try {
    // 找出该模型所有 default 组的"端点维度"组合
    const defaults = await query(
      `SELECT * FROM model_prices
        WHERE model_id = ? AND token_group_code = 'default' AND status = 1`,
      [modelId]
    );
    if (defaults.length === 0) {
      return res.status(404).json({ success: false, error: '该模型没有默认组价格，无法派生' });
    }
    for (const d of defaults) {
      await upsertDefaultAndDerive(modelId, {
        endpoint_type: d.endpoint_type,
        billing_mode: d.billing_mode,
        billing_params: parseJson(d.billing_params, {}),
        price_type: d.price_type,
      });
    }
    res.json({ success: true, message: `已基于 ${defaults.length} 个默认组配置重新派生` });

    // 通知 api-relay 刷新价格缓存
    try {
      await redis.publish('api-relay:reload-prices', JSON.stringify({ modelId: req.params.modelId, ts: Date.now() }));
      console.log(`[PriceSync] 已发布价格刷新通知: ${req.params.modelId}`);
    } catch (redisErr) {
      console.error(`[PriceSync] 发布刷新通知失败:`, redisErr.message);
    }
  } catch (e) {
    console.error('[marketplace] rederive error:', e);
    res.status(500).json({ success: false, error: '派生失败', detail: e.message });
  }
});

module.exports = { publicRouter, adminRouter };
