/**
 * 模型配置管理 API
 * 供管理后台使用
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

// 所有路由需要登录 + 管理员权限
router.use(authMiddleware, adminMiddleware);

// ========== 模板管理 ==========

// 获取模板列表
router.get('/model-templates', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM model_templates WHERE status = 1 ORDER BY id DESC'
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 创建模板
router.post('/model-templates', async (req, res) => {
  try {
    const {
      template_key, name, description, supported_types,
      endpoint_path, http_method, headers, response_mapping
    } = req.body;

    const result = await query(
      `INSERT INTO model_templates
       (template_key, name, description, supported_types, endpoint_path, http_method, headers, response_mapping, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        template_key,
        name,
        description ?? null,
        supported_types ?? null,
        endpoint_path ?? null,
        http_method ?? null,
        headers ?? null,
        response_mapping ?? null
      ]
    );

    // 清除模型模板缓存（使新模板立即生效）
    try {
      const keys = await redis.keys('cache:model_template:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ModelTemplateCreate] 清除模型模板缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ModelTemplateCreate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, data: { id: result.insertId } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 更新模板
router.put('/model-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, description, supported_types,
      endpoint_path, http_method, headers, response_mapping, status
    } = req.body;

    await query(
      `UPDATE model_templates SET
       name = ?, description = ?, supported_types = ?,
       endpoint_path = ?, http_method = ?, headers = ?, response_mapping = ?, status = ?
       WHERE id = ?`,
      [
        name ?? null,
        description ?? null,
        supported_types ?? null,
        endpoint_path ?? null,
        http_method ?? null,
        headers ?? null,
        response_mapping ?? null,
        status ?? 1,
        id
      ]
    );

    // 清除模型模板缓存（使模板变更立即生效）
    try {
      const keys = await redis.keys('cache:model_template:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ModelTemplateUpdate] 清除模型模板缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ModelTemplateUpdate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除模板
router.delete('/model-templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await query('UPDATE model_templates SET status = 0 WHERE id = ?', [id]);

    // 清除模型模板缓存（使模板删除立即生效）
    try {
      const keys = await redis.keys('cache:model_template:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ModelTemplateDelete] 清除模型模板缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ModelTemplateDelete] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== 模型-渠道配置 ==========

// 获取配置列表
router.get('/model-channel-configs', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        mcc.*,
        ml.model_id,
        ml.display_name as model_name,
        c.name as channel_name,
        mt.template_key,
        mt.endpoint_path as template_endpoint
      FROM model_channel_configs mcc
      JOIN model_library ml ON mcc.model_id = ml.model_id
      JOIN proxy_channels c ON mcc.channel_id = c.id
      JOIN model_templates mt ON mcc.use_template_id = mt.id
      WHERE mcc.status IN (0, 1)
      ORDER BY mcc.id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 创建配置
router.post('/model-channel-configs', async (req, res) => {
  try {
    const {
      model_id, channel_id, template_id,
      priority = 1, weight = 100, status = 1,
      override_endpoint, custom_endpoint_path,
      override_headers, custom_headers,
      override_params, custom_params
    } = req.body;

    const result = await query(
      `INSERT INTO model_channel_configs
       (model_id, channel_id, use_template_id, status,
        override_endpoint, custom_endpoint_path,
        custom_headers, custom_params)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        model_id,
        channel_id,
        template_id ?? null,
        status ?? 1,
        override_endpoint ?? false,
        custom_endpoint_path ?? null,
        custom_headers ?? null,
        custom_params ?? null
      ]
    );

    // 清除模型渠道配置缓存（使新配置立即生效）
    try {
      const keys = await redis.keys('cache:model_channel_config:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ModelChannelConfigCreate] 清除模型渠道配置缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ModelChannelConfigCreate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, data: { id: result.insertId } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 更新配置
router.put('/model-channel-configs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      template_id, priority, weight, status,
      override_endpoint, custom_endpoint_path,
      override_headers, custom_headers,
      override_params, custom_params
    } = req.body;

    await query(
      `UPDATE model_channel_configs SET
       use_template_id = ?, status = ?,
       override_endpoint = ?, custom_endpoint_path = ?,
       custom_headers = ?, custom_params = ?
       WHERE id = ?`,
      [
        template_id ?? null,
        status ?? 1,
        override_endpoint ?? false,
        custom_endpoint_path ?? null,
        custom_headers ?? null,
        custom_params ?? null,
        id
      ]
    );

    // 清除模型渠道配置缓存（使配置变更立即生效）
    try {
      const keys = await redis.keys('cache:model_channel_config:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ModelChannelConfigUpdate] 清除模型渠道配置缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ModelChannelConfigUpdate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除配置
router.delete('/model-channel-configs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await query('DELETE FROM model_channel_configs WHERE id = ?', [id]);

    // 清除模型渠道配置缓存（使配置删除立即生效）
    try {
      const keys = await redis.keys('cache:model_channel_config:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[ModelChannelConfigDelete] 清除模型渠道配置缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[ModelChannelConfigDelete] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 测试连接
router.post('/model-channel-configs/test', async (req, res) => {
  try {
    const { model_id, channel_id } = req.body;

    // 获取配置
    const [config] = await query(`
      SELECT mcc.*, mt.endpoint_path, mt.headers, c.base_url, c.api_key
      FROM model_channel_configs mcc
      JOIN model_templates mt ON mcc.template_id = mt.id
      JOIN proxy_channels c ON mcc.channel_id = c.id
      WHERE mcc.model_id = ? AND mcc.channel_id = ?
    `, [model_id, channel_id]);

    if (!config) {
      return res.status(404).json({ success: false, error: '配置不存在' });
    }

    // 构建测试请求（发送一个简单的 HEAD 或 GET 请求）
    const endpoint = config.override_endpoint && config.custom_endpoint_path
      ? config.custom_endpoint_path
      : config.endpoint_path;

    const testUrl = config.base_url.replace(/\/+$/, '') + endpoint;

    // 简单测试：尝试访问接口
    try {
      const response = await fetch(testUrl, {
        method: 'HEAD',
        headers: {
          'Authorization': `Bearer ${config.api_key}`,
        },
      });

      // 即使是 404 或 405 也说明接口存在
      res.json({ success: true, message: '连接正常' });
    } catch (fetchErr) {
      res.status(502).json({ success: false, error: '连接失败: ' + fetchErr.message });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
