/**
 * 用户模型权限管理路由
 * 表：user_model_permissions
 * models 字段存储 JSON 数组，如 ["gpt-4", "claude-3-opus"]
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

// Redis 缓存 key 前缀（与 Java 网关保持一致）
const MODEL_PERMISSION_CACHE_PREFIX = 'model:permission:blacklist:';

// 清除用户模型权限缓存
async function clearUserPermissionCache(userId) {
  try {
    const cacheKey = MODEL_PERMISSION_CACHE_PREFIX + userId;
    await redis.del(cacheKey);
    console.log(`[user-model-permissions] 清除用户权限缓存: userId=${userId}`);
  } catch (e) {
    console.error('[user-model-permissions] 清除缓存失败:', e);
  }
}

// 所有路由需要管理员权限
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * GET /api/admin/user-model-permissions
 * 查询用户模型权限列表（支持搜索、分页）
 */
router.get('/', async (req, res) => {
  try {
    const {
      user_id,
      models,
      permission_type,
      status,
      page = 1,
      pageSize = 20
    } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (user_id) {
      whereClause += ' AND p.user_id = ?';
      params.push(parseInt(user_id, 10));
    }
    if (models) {
      whereClause += ' AND JSON_CONTAINS(p.models, ?)';
      params.push(JSON.stringify(models));
    }
    if (permission_type) {
      whereClause += ' AND p.permission_type = ?';
      params.push(permission_type);
    }
    if (status !== undefined && status !== '') {
      whereClause += ' AND p.status = ?';
      params.push(parseInt(status, 10));
    }

    // 查询总数
    const [countResult] = await query(
      `SELECT COUNT(*) as total FROM user_model_permissions p ${whereClause}`,
      params
    );
    const total = countResult.total;

    // 分页
    const safeLimit = Math.max(1, parseInt(pageSize) || 20);
    const safeOffset = Math.max(0, (parseInt(page) - 1) * safeLimit);

    // 查询列表（关联用户表）
    const rows = await query(
      `SELECT
        p.id,
        p.user_id,
        p.models,
        p.permission_type,
        p.start_time,
        p.end_time,
        p.status,
        p.created_at,
        p.updated_at,
        p.remark,
        u.name as user_name,
        u.email as user_email
      FROM user_model_permissions p
      LEFT JOIN user_users u ON p.user_id = u.id
      ${whereClause}
      ORDER BY p.created_at DESC
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
    console.error('[user-model-permissions] list error:', error);
    res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

/**
 * GET /api/admin/user-model-permissions/:id
 * 查询单个用户模型权限
 */
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT
        p.id,
        p.user_id,
        p.models,
        p.permission_type,
        p.start_time,
        p.end_time,
        p.status,
        p.created_at,
        p.updated_at,
        p.remark,
        u.name as user_name,
        u.email as user_email
      FROM user_model_permissions p
      LEFT JOIN user_users u ON p.user_id = u.id
      WHERE p.id = ?`,
      [req.params.id]
    );

    if (!row) {
      return res.status(404).json({ success: false, error: '记录不存在' });
    }

    res.json({ success: true, data: row });
  } catch (error) {
    console.error('[user-model-permissions] detail error:', error);
    res.status(500).json({ success: false, error: '获取详情失败' });
  }
});

/**
 * POST /api/admin/user-model-permissions
 * 创建用户模型权限
 * models: 模型ID数组，如 ["gpt-4", "claude-3-opus"]，null 表示所有模型
 */
router.post('/', async (req, res) => {
  try {
    const {
      user_id,
      models,
      permission_type = 'BLACKLIST',
      start_time,
      end_time,
      status = 1,
      remark = ''
    } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, error: 'user_id 必填' });
    }
    if (!permission_type || !['WHITELIST', 'BLACKLIST'].includes(permission_type)) {
      return res.status(400).json({ success: false, error: 'permission_type 必须是 WHITELIST 或 BLACKLIST' });
    }

    // 检查用户是否存在
    const [user] = await query('SELECT id FROM user_users WHERE id = ?', [user_id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 如果指定了 models，检查模型是否存在
    if (models && Array.isArray(models) && models.length > 0) {
      for (const modelId of models) {
        const [model] = await query('SELECT model_id FROM model_library WHERE model_id = ?', [modelId]);
        if (!model) {
          return res.status(404).json({ success: false, error: `模型 ${modelId} 不存在` });
        }
      }
    }

    const result = await query(
      `INSERT INTO user_model_permissions
        (user_id, models, permission_type, start_time, end_time, status, remark, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [user_id, models ? JSON.stringify(models) : null, permission_type, start_time || null, end_time || null, status, remark, req.user?.id || null]
    );

    req.audit = {
      action: 'user_model_permission.create',
      targetType: 'user_model_permission',
      targetId: result.insertId,
      after: { user_id, models, permission_type, start_time, end_time, status, remark }
    };

    // 清除该用户的权限缓存
    await clearUserPermissionCache(user_id);

    res.json({ success: true, id: result.insertId, message: '创建成功' });
  } catch (error) {
    console.error('[user-model-permissions] create error:', error);
    res.status(500).json({ success: false, error: '创建失败', detail: error.message });
  }
});

/**
 * PUT /api/admin/user-model-permissions/:id
 * 更新用户模型权限
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      models,
      permission_type,
      start_time,
      end_time,
      status,
      remark
    } = req.body;

    const [existing] = await query('SELECT * FROM user_model_permissions WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '记录不存在' });
    }

    const sets = [];
    const params = [];

    if (models !== undefined) {
      sets.push('models = ?');
      params.push(models ? JSON.stringify(models) : null);
    }
    if (permission_type !== undefined) {
      sets.push('permission_type = ?');
      params.push(permission_type);
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
      `UPDATE user_model_permissions SET ${sets.join(', ')} WHERE id = ?`,
      params
    );

    req.audit = {
      action: 'user_model_permission.update',
      targetType: 'user_model_permission',
      targetId: id,
      before: existing,
      after: req.body
    };

    // 清除该用户的权限缓存
    await clearUserPermissionCache(existing.user_id);

    res.json({ success: true, message: '更新成功' });
  } catch (error) {
    console.error('[user-model-permissions] update error:', error);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

/**
 * DELETE /api/admin/user-model-permissions/:id
 * 删除用户模型权限
 */
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query('SELECT * FROM user_model_permissions WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '记录不存在' });
    }

    await query('DELETE FROM user_model_permissions WHERE id = ?', [req.params.id]);

    // 清除该用户的权限缓存
    await clearUserPermissionCache(existing.user_id);

    req.audit = {
      action: 'user_model_permission.delete',
      targetType: 'user_model_permission',
      targetId: req.params.id,
      before: existing
    };

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('[user-model-permissions] delete error:', error);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

/**
 * GET /api/admin/user-model-permissions/user/:userId
 * 获取指定用户的模型权限列表
 */
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.query;

    let whereClause = 'WHERE p.user_id = ?';
    const params = [userId];

    if (status !== undefined && status !== '') {
      whereClause += ' AND p.status = ?';
      params.push(parseInt(status, 10));
    }

    const rows = await query(
      `SELECT
        p.id,
        p.user_id,
        p.models,
        p.permission_type,
        p.start_time,
        p.end_time,
        p.status,
        p.created_at,
        p.updated_at,
        p.remark,
        u.name as user_name,
        u.email as user_email
      FROM user_model_permissions p
      LEFT JOIN user_users u ON p.user_id = u.id
      ${whereClause}
      ORDER BY p.created_at DESC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[user-model-permissions] user list error:', error);
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

module.exports = router;
