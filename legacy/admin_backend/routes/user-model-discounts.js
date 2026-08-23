/**
 * 用户模型优惠管理路由
 * 表：user_model_discounts
 * models 字段存储 JSON 数组，如 ["gpt-4", "claude-3-opus"]
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

// 所有路由需要管理员权限
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * GET /api/admin/user-model-discounts
 * 查询用户模型优惠列表（支持搜索、分页）
 */
router.get('/', async (req, res) => {
  try {
    const {
      user_id,
      models,
      discount_type,
      status,
      page = 1,
      pageSize = 20
    } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (user_id) {
      whereClause += ' AND d.user_id = ?';
      params.push(parseInt(user_id, 10));
    }
    if (models) {
      whereClause += ' AND JSON_CONTAINS(d.models, ?)';
      params.push(JSON.stringify(models));
    }
    if (discount_type) {
      whereClause += ' AND d.discount_type = ?';
      params.push(discount_type);
    }
    if (status !== undefined && status !== '') {
      whereClause += ' AND d.status = ?';
      params.push(parseInt(status, 10));
    }

    // 查询总数
    const [countResult] = await query(
      `SELECT COUNT(*) as total FROM user_model_discounts d ${whereClause}`,
      params
    );
    const total = countResult.total;

    // 分页
    const safeLimit = Math.max(1, parseInt(pageSize) || 20);
    const safeOffset = Math.max(0, (parseInt(page) - 1) * safeLimit);

    // 查询列表（关联用户表）
    const rows = await query(
      `SELECT
        d.id,
        d.user_id,
        d.models,
        d.discount_type,
        d.discount_value,
        d.start_time,
        d.end_time,
        d.status,
        d.created_at,
        d.updated_at,
        d.remark,
        u.name as user_name,
        u.email as user_email
      FROM user_model_discounts d
      LEFT JOIN user_users u ON d.user_id = u.id
      ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
    );

    res.json({
      success: true,
      data: rows,
      pagination: {
        total,
        page: parseInt(page),
        pageSize: safeLimit,
        totalPages: Math.ceil(total / safeLimit)
      }
    });
  } catch (error) {
    console.error('[user-model-discounts] list error:', error);
    res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

/**
 * GET /api/admin/user-model-discounts/:id
 * 查询单个用户模型优惠
 */
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT
        d.id,
        d.user_id,
        d.models,
        d.discount_type,
        d.discount_value,
        d.start_time,
        d.end_time,
        d.status,
        d.created_at,
        d.updated_at,
        d.remark,
        u.name as user_name,
        u.email as user_email
      FROM user_model_discounts d
      LEFT JOIN user_users u ON d.user_id = u.id
      WHERE d.id = ?`,
      [req.params.id]
    );

    if (!row) {
      return res.status(404).json({ success: false, error: '记录不存在' });
    }

    res.json({ success: true, data: row });
  } catch (error) {
    console.error('[user-model-discounts] detail error:', error);
    res.status(500).json({ success: false, error: '获取详情失败' });
  }
});

/**
 * POST /api/admin/user-model-discounts
 * 创建用户模型优惠
 * models: 模型ID数组，如 ["gpt-4", "claude-3-opus"]
 */
router.post('/', async (req, res) => {
  try {
    const {
      user_id,
      models,
      discount_type = 'PERCENTAGE',
      discount_value,
      start_time,
      end_time,
      status = 1,
      remark = ''
    } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, error: 'user_id 必填' });
    }
    if (!models || !Array.isArray(models) || models.length === 0) {
      return res.status(400).json({ success: false, error: 'models 必填且必须是非空数组' });
    }
    if (discount_value === undefined || discount_value === null) {
      return res.status(400).json({ success: false, error: 'discount_value 必填' });
    }
    if (!['PERCENTAGE', 'FIXED_AMOUNT', 'OVERRIDE_PRICE'].includes(discount_type)) {
      return res.status(400).json({ success: false, error: 'discount_type 必须是 PERCENTAGE、FIXED_AMOUNT 或 OVERRIDE_PRICE' });
    }

    // 检查用户是否存在
    const [user] = await query('SELECT id FROM user_users WHERE id = ?', [user_id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 检查模型是否存在（支持 channel_code/model_id 格式）
    for (const modelId of models) {
      // 尝试多种格式匹配模型
      // 1. 先尝试完整格式匹配（如 aliyun/kimi/kimi-k3）
      // 2. 再尝试 channel/model 格式（如 kimi/kimi-k3）
      // 3. 最后尝试纯 model_id（如 kimi-k3）
      const possibleIds = [];

      // 原始传入值
      possibleIds.push(modelId);

      // 去掉最前面的 channel_code（如果有多层）
      if (modelId.includes('/')) {
        const parts = modelId.split('/');
        // aliyun/kimi/kimi-k3 -> kimi/kimi-k3
        if (parts.length > 2) {
          possibleIds.push(parts.slice(1).join('/'));
        }
        // aliyun/kimi/kimi-k3 -> kimi-k3
        possibleIds.push(parts.pop());
      }

      // 去重
      const uniqueIds = [...new Set(possibleIds)];

      let found = false;
      for (const id of uniqueIds) {
        const [model] = await query('SELECT model_id FROM model_library WHERE model_id = ?', [id]);
        if (model) {
          found = true;
          break;
        }
      }

      if (!found) {
        return res.status(404).json({ success: false, error: `模型 ${modelId} 不存在` });
      }
    }

    const result = await query(
      `INSERT INTO user_model_discounts
        (user_id, models, discount_type, discount_value, start_time, end_time, status, remark, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user_id, JSON.stringify(models), discount_type, discount_value, start_time || null, end_time || null, status, remark, req.user?.id || null]
    );

    req.audit = {
      action: 'user_model_discount.create',
      targetType: 'user_model_discount',
      targetId: result.insertId,
      after: { user_id, models, discount_type, discount_value, start_time, end_time, status, remark }
    };

    // 清除用户模型优惠缓存（使创建立即生效）
    try {
      const keys = await redis.keys('user_model_discounts:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[UserModelDiscountCreate] 清除用户模型优惠缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[UserModelDiscountCreate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, id: result.insertId, message: '创建成功' });
  } catch (error) {
    console.error('[user-model-discounts] create error:', error);
    res.status(500).json({ success: false, error: '创建失败', detail: error.message });
  }
});

/**
 * PUT /api/admin/user-model-discounts/:id
 * 更新用户模型优惠
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      models,
      discount_type,
      discount_value,
      start_time,
      end_time,
      status,
      remark
    } = req.body;

    const [existing] = await query('SELECT * FROM user_model_discounts WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '记录不存在' });
    }

    const sets = [];
    const params = [];

    if (models !== undefined) {
      sets.push('models = ?');
      params.push(models ? JSON.stringify(models) : null);
    }
    if (discount_type !== undefined) {
      sets.push('discount_type = ?');
      params.push(discount_type);
    }
    if (discount_value !== undefined) {
      sets.push('discount_value = ?');
      params.push(discount_value);
    }
    if (start_time !== undefined) {
      sets.push('start_time = ?');
      params.push(start_time || null);
    }
    if (end_time !== undefined) {
      sets.push('end_time = ?');
      params.push(end_time || null);
    }
    if (status !== undefined) {
      sets.push('status = ?');
      params.push(status);
    }
    if (remark !== undefined) {
      sets.push('remark = ?');
      params.push(remark);
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: '无更新字段' });
    }

    params.push(id);
    await query(
      `UPDATE user_model_discounts SET ${sets.join(', ')} WHERE id = ?`,
      params
    );

    req.audit = {
      action: 'user_model_discount.update',
      targetType: 'user_model_discount',
      targetId: id,
      before: existing,
      after: req.body
    };

    // 清除用户模型优惠缓存（使更新立即生效）
    try {
      const keys = await redis.keys('user_model_discounts:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[UserModelDiscountUpdate] 清除用户模型优惠缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[UserModelDiscountUpdate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '更新成功' });
  } catch (error) {
    console.error('[user-model-discounts] update error:', error);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

/**
 * DELETE /api/admin/user-model-discounts/:id
 * 删除用户模型优惠
 */
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query('SELECT * FROM user_model_discounts WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '记录不存在' });
    }

    await query('DELETE FROM user_model_discounts WHERE id = ?', [req.params.id]);

    req.audit = {
      action: 'user_model_discount.delete',
      targetType: 'user_model_discount',
      targetId: req.params.id,
      before: existing
    };

    // 清除用户模型优惠缓存（使删除立即生效）
    try {
      const keys = await redis.keys('user_model_discounts:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[UserModelDiscountDelete] 清除用户模型优惠缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[UserModelDiscountDelete] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('[user-model-discounts] delete error:', error);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

/**
 * GET /api/admin/user-model-discounts/user/:userId
 * 获取指定用户的模型优惠列表
 */
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.query;

    let whereClause = 'WHERE d.user_id = ?';
    const params = [userId];

    if (status !== undefined && status !== '') {
      whereClause += ' AND d.status = ?';
      params.push(parseInt(status, 10));
    }

    const rows = await query(
      `SELECT
        d.id,
        d.user_id,
        d.models,
        d.discount_type,
        d.discount_value,
        d.start_time,
        d.end_time,
        d.status,
        d.created_at,
        d.updated_at,
        d.remark,
        u.name as user_name,
        u.email as user_email
      FROM user_model_discounts d
      LEFT JOIN user_users u ON d.user_id = u.id
      ${whereClause}
      ORDER BY d.created_at DESC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[user-model-discounts] user list error:', error);
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

module.exports = router;
