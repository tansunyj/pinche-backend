/**
 * 套餐管理路由 (packages)
 *
 * 功能：
 *   - 套餐 CRUD（创建、查询、更新、删除、切换状态）
 *   - 用户套餐绑定（绑定、更换、取消、查询）
 *   - 批量绑定
 *   - Redis 缓存失效
 */

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db/init');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

// 所有路由需要管理员权限
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * 计算套餐有效期状态
 * @param {Object} pkg - 套餐对象，包含 start_at, end_at, status
 * @returns {string} - 'pending'(待生效), 'active'(生效中), 'expired'(已过期), 'disabled'(已禁用)
 */
function getPackageStatus(pkg) {
  if (pkg.status === 0) return 'disabled';
  const now = new Date();
  if (pkg.start_at && new Date(pkg.start_at) > now) return 'pending';
  if (pkg.end_at && new Date(pkg.end_at) < now) return 'expired';
  return 'active';
}

/**
 * 安全解析 models JSON 字段
 * mysql2 execute() 可能已自动将 MySQL JSON 列解析为对象，需兼容两种格式
 * @param {string|object|array} val - 原始值（可能是 JSON 字符串或已解析的对象）
 * @returns {array} 解析后的模型配置数组
 */
function parseModelsField(val) {
  if (!val) return [];
  // mysql2 已自动解析为对象/数组 → 直接返回
  if (typeof val === 'object') return Array.isArray(val) ? val : [val];
  // 仍是 JSON 字符串 → 手动解析
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[packages] models JSON parse error:', e.message);
    return [];
  }
}

/**
 * 校验 models 配置中是否存在重复模型
 * 同一个模型（完整 channel_code/model_id）不能出现在多个折扣组中
 * @param {array} models - 模型配置数组 [{models: ["aliyun/qwen"], price_markup: 0.8}, ...]
 * @returns {{ valid: boolean, duplicates: string[] }}
 */
function validateNoDuplicateModels(models) {
  const seen = new Map(); // model_id → group index
  const duplicates = [];

  for (let i = 0; i < models.length; i++) {
    const modelIds = models[i].models || [];
    for (const modelId of modelIds) {
      if (seen.has(modelId)) {
        duplicates.push(`"${modelId}" 同时出现在配置组 #${seen.get(modelId) + 1} 和配置组 #${i + 1} 中`);
      } else {
        seen.set(modelId, i);
      }
    }
  }

  return { valid: duplicates.length === 0, duplicates };
}

/**
 * 删除用户套餐缓存
 * @param {number} userId - 用户ID
 */
async function invalidateUserPackageCache(userId) {
  try {
    const key = `package:user:${userId}`;
    await redis.del(key);
    console.log(`[PackageCache] 已清除用户 ${userId} 的套餐缓存`);
  } catch (err) {
    console.error(`[PackageCache] 清除缓存失败:`, err.message);
  }
}

/**
 * 批量删除套餐缓存
 * @param {number} packageId - 套餐ID
 */
async function invalidatePackageCache(packageId) {
  try {
    // 查询所有绑定该套餐的用户
    const users = await query('SELECT user_id FROM user_packages WHERE package_id = ?', [packageId]);
    if (users && users.length > 0) {
      const keys = users.map(u => `package:user:${u.user_id}`);
      // 使用 pipeline 批量删除
      const pipeline = redis.pipeline();
      keys.forEach(k => pipeline.del(k));
      await pipeline.exec();
      console.log(`[PackageCache] 已清除套餐 ${packageId} 的 ${users.length} 个用户缓存`);
    }
  } catch (err) {
    console.error(`[PackageCache] 批量清除缓存失败:`, err.message);
  }
}

// ==================== 套餐管理接口 ====================

/**
 * GET /api/admin/packages
 * 套餐列表（支持分页、搜索、状态筛选）
 */
router.get('/', async (req, res) => {
  try {
    const {
      keyword = '',
      status,
      page = 1,
      pageSize = 20
    } = req.query;

    let whereClause = 'WHERE deleted_at IS NULL';
    const params = [];

    if (keyword) {
      whereClause += ' AND (name LIKE ? OR description LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    if (status !== undefined && status !== '') {
      whereClause += ' AND status = ?';
      params.push(parseInt(status, 10));
    }

    // 查询总数
    const [countResult] = await query(
      `SELECT COUNT(*) as total FROM packages ${whereClause}`,
      params
    );
    const total = countResult.total;

    // 分页
    const safeLimit = Math.max(1, parseInt(pageSize) || 20);
    const safeOffset = Math.max(0, (parseInt(page) - 1) * safeLimit);

    // 查询列表
    const rows = await query(
      `SELECT
        id,
        name,
        description,
        models,
        status,
        sort_order,
        start_at,
        end_at,
        min_consumption,
        max_consumption,
        created_at,
        updated_at
      FROM packages
      ${whereClause}
      ORDER BY sort_order ASC, id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
    );

    // 格式化返回数据
    const formattedRows = rows.map(row => {
      // mysql2 execute() 会自动解析 JSON 列为对象，需兼容两种格式
      let models = parseModelsField(row.models);
      // 计算包含的模型总数
      const modelCount = Array.isArray(models)
        ? models.reduce((sum, item) => sum + (item.models?.length || 0), 0)
        : 0;

      return {
        ...row,
        models,
        model_count: modelCount,
        status_text: getPackageStatus({ ...row, status: row.status })
      };
    });

    res.json({
      success: true,
      data: formattedRows,
      pagination: {
        total,
        page: parseInt(page),
        pageSize: safeLimit,
        totalPages: Math.ceil(total / safeLimit)
      }
    });
  } catch (error) {
    console.error('[packages] list error:', error);
    res.status(500).json({ success: false, error: '获取套餐列表失败' });
  }
});

/**
 * GET /api/admin/packages/:id
 * 套餐详情
 */
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT * FROM packages WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!row) {
      return res.status(404).json({ success: false, error: '套餐不存在' });
    }

    let models = parseModelsField(row.models);

    res.json({
      success: true,
      data: {
        ...row,
        models,
        status_text: getPackageStatus(row)
      }
    });
  } catch (error) {
    console.error('[packages] detail error:', error);
    res.status(500).json({ success: false, error: '获取套餐详情失败' });
  }
});

/**
 * POST /api/admin/packages
 * 创建套餐
 */
router.post('/', async (req, res) => {
  try {
    const {
      name,
      description = '',
      models,
      status = 1,
      sort_order = 0,
      start_at,
      end_at,
      min_consumption = 0,
      max_consumption = null,
    } = req.body;

    // 参数校验
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: '套餐名称必填' });
    }
    if (!models || !Array.isArray(models) || models.length === 0) {
      return res.status(400).json({ success: false, error: '模型配置必填且必须是非空数组' });
    }

    // 验证 models 格式
    for (const item of models) {
      if (!item.models || !Array.isArray(item.models) || item.models.length === 0) {
        return res.status(400).json({ success: false, error: '每组模型配置必须包含 models 数组' });
      }
      if (item.price_markup === undefined || item.price_markup === null) {
        return res.status(400).json({ success: false, error: '每组模型配置必须包含 price_markup' });
      }
      if (item.price_markup <= 0 || item.price_markup > 1) {
        return res.status(400).json({ success: false, error: 'price_markup 必须在 0.01 ~ 1.00 之间' });
      }
    }

    // 校验：同一个模型不能出现在多个折扣组中
    const { valid, duplicates } = validateNoDuplicateModels(models);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: '存在重复模型：' + duplicates.join('；'),
        duplicates
      });
    }

    const result = await query(
      `INSERT INTO packages
        (name, description, models, status, sort_order, start_at, end_at, min_consumption, max_consumption)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        description || null,
        JSON.stringify(models),
        status,
        sort_order,
        start_at || null,
        end_at || null,
        min_consumption || 0,
        max_consumption || null,
      ]
    );

    req.audit = {
      action: 'package.create',
      targetType: 'package',
      targetId: result.insertId,
      after: { name, description, models, status, sort_order, start_at, end_at }
    };

    res.json({ success: true, id: result.insertId, message: '套餐创建成功' });
  } catch (error) {
    console.error('[packages] create error:', error);
    res.status(500).json({ success: false, error: '创建套餐失败', detail: error.message });
  }
});

/**
 * PUT /api/admin/packages/:id
 * 编辑套餐
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      models,
      status,
      sort_order,
      start_at,
      end_at,
      min_consumption,
      max_consumption,
    } = req.body;

    // 检查套餐是否存在
    const [existing] = await query('SELECT * FROM packages WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '套餐不存在' });
    }

    const sets = [];
    const params = [];

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ success: false, error: '套餐名称不能为空' });
      }
      sets.push('name = ?');
      params.push(name.trim());
    }
    if (description !== undefined) {
      sets.push('description = ?');
      params.push(description || null);
    }
    if (models !== undefined) {
      if (!Array.isArray(models) || models.length === 0) {
        return res.status(400).json({ success: false, error: '模型配置必须是非空数组' });
      }
      // 验证 models 格式
      for (const item of models) {
        if (!item.models || !Array.isArray(item.models) || item.models.length === 0) {
          return res.status(400).json({ success: false, error: '每组模型配置必须包含 models 数组' });
        }
        if (item.price_markup === undefined || item.price_markup === null) {
          return res.status(400).json({ success: false, error: '每组模型配置必须包含 price_markup' });
        }
        if (item.price_markup <= 0 || item.price_markup > 1) {
          return res.status(400).json({ success: false, error: 'price_markup 必须在 0.01 ~ 1.00 之间' });
        }
      }
      // 校验：同一个模型不能出现在多个折扣组中
      const { valid, duplicates } = validateNoDuplicateModels(models);
      if (!valid) {
        return res.status(400).json({
          success: false,
          error: '存在重复模型：' + duplicates.join('；'),
          duplicates
        });
      }
      sets.push('models = ?');
      params.push(JSON.stringify(models));
    }
    if (status !== undefined) {
      sets.push('status = ?');
      params.push(status);
    }
    if (sort_order !== undefined) {
      sets.push('sort_order = ?');
      params.push(sort_order);
    }
    if (start_at !== undefined) {
      sets.push('start_at = ?');
      params.push(start_at || null);
    }
    if (end_at !== undefined) {
      sets.push('end_at = ?');
      params.push(end_at || null);
    }
    if (min_consumption !== undefined) {
      sets.push('min_consumption = ?');
      params.push(min_consumption ?? 0);
    }
    if (max_consumption !== undefined) {
      sets.push('max_consumption = ?');
      params.push(max_consumption || null);
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: '无更新字段' });
    }

    params.push(id);
    await query(
      `UPDATE packages SET ${sets.join(', ')} WHERE id = ?`,
      params
    );

    req.audit = {
      action: 'package.update',
      targetType: 'package',
      targetId: id,
      before: existing,
      after: req.body
    };

    // 清除绑定该套餐的所有用户的缓存
    await invalidatePackageCache(id);

    res.json({ success: true, message: '套餐更新成功' });
  } catch (error) {
    console.error('[packages] update error:', error);
    res.status(500).json({ success: false, error: '更新套餐失败', detail: error.message });
  }
});

/**
 * DELETE /api/admin/packages/:id
 * 删除套餐（软删除）
 */
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query('SELECT * FROM packages WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '套餐不存在' });
    }

    // 清除绑定该套餐的所有用户的缓存
    await invalidatePackageCache(req.params.id);

    // 软删除
    await query(
      `UPDATE packages SET deleted_at = NOW() WHERE id = ?`,
      [req.params.id]
    );

    req.audit = {
      action: 'package.delete',
      targetType: 'package',
      targetId: req.params.id,
      before: existing
    };

    res.json({ success: true, message: '套餐已删除' });
  } catch (error) {
    console.error('[packages] delete error:', error);
    res.status(500).json({ success: false, error: '删除套餐失败' });
  }
});

/**
 * PUT /api/admin/packages/:id/status
 * 切换套餐状态
 */
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (status !== 0 && status !== 1) {
      return res.status(400).json({ success: false, error: 'status 必须是 0 或 1' });
    }

    const [existing] = await query('SELECT * FROM packages WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '套餐不存在' });
    }

    await query('UPDATE packages SET status = ? WHERE id = ?', [status, id]);

    req.audit = {
      action: 'package.update_status',
      targetType: 'package',
      targetId: id,
      after: { status }
    };

    // 清除绑定该套餐的所有用户的缓存
    await invalidatePackageCache(id);

    res.json({ success: true, message: status === 1 ? '套餐已启用' : '套餐已禁用' });
  } catch (error) {
    console.error('[packages] status error:', error);
    res.status(500).json({ success: false, error: '切换状态失败' });
  }
});

// ==================== 用户套餐绑定接口 ====================

/**
 * GET /api/admin/users/:id/package
 * 查询用户绑定的套餐
 */
router.get('/user/:userId/package', async (req, res) => {
  try {
    const { userId } = req.params;

    const [row] = await query(
      `SELECT
        up.id,
        up.user_id,
        up.package_id,
        up.package_name,
        up.assigned_by,
        up.assigned_at,
        up.created_at,
        up.updated_at,
        p.name as package_name_from_pkg,
        p.models,
        p.status as package_status,
        p.start_at,
        p.end_at
      FROM user_packages up
      LEFT JOIN packages p ON up.package_id = p.id
      WHERE up.user_id = ?`,
      [userId]
    );

    if (!row) {
      return res.json({ success: true, data: null });
    }

    let models = parseModelsField(row.models);

    res.json({
      success: true,
      data: {
        id: row.id,
        user_id: row.user_id,
        package_id: row.package_id,
        package_name: row.package_name || row.package_name_from_pkg,
        assigned_by: row.assigned_by,
        assigned_at: row.assigned_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        models,
        package_status: row.package_status,
        start_at: row.start_at,
        end_at: row.end_at,
        status_text: getPackageStatus({
          status: row.package_status,
          start_at: row.start_at,
          end_at: row.end_at
        })
      }
    });
  } catch (error) {
    console.error('[packages] get user package error:', error);
    res.status(500).json({ success: false, error: '获取用户套餐失败' });
  }
});

/**
 * POST /api/admin/users/:id/package
 * 给用户绑定套餐
 */
router.post('/user/:userId/package', async (req, res) => {
  try {
    const { userId } = req.params;
    const { package_id } = req.body;

    if (!package_id) {
      return res.status(400).json({ success: false, error: 'package_id 必填' });
    }

    // 检查用户是否存在
    const [user] = await query('SELECT id, name FROM user_users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ success: false, error: '用户不存在' });
    }

    // 检查套餐是否存在
    const [pkg] = await query('SELECT id, name, status FROM packages WHERE id = ? AND deleted_at IS NULL', [package_id]);
    if (!pkg) {
      return res.status(404).json({ success: false, error: '套餐不存在' });
    }

    // 检查用户是否已绑定套餐
    const [existing] = await query('SELECT id FROM user_packages WHERE user_id = ?', [userId]);

    if (existing) {
      // 更新现有绑定
      await query(
        `UPDATE user_packages
         SET package_id = ?, package_name = ?, assigned_by = ?, assigned_at = NOW()
         WHERE user_id = ?`,
        [package_id, pkg.name, req.user?.id || null, userId]
      );
    } else {
      // 创建新绑定
      await query(
        `INSERT INTO user_packages
         (user_id, package_id, package_name, assigned_by, assigned_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [userId, package_id, pkg.name, req.user?.id || null]
      );
    }

    // 清除用户缓存
    await invalidateUserPackageCache(userId);

    req.audit = {
      action: 'package.assign',
      targetType: 'user_package',
      targetId: userId,
      after: { user_id: userId, package_id, package_name: pkg.name }
    };

    res.json({ success: true, message: '套餐绑定成功' });
  } catch (error) {
    console.error('[packages] assign error:', error);
    res.status(500).json({ success: false, error: '绑定套餐失败', detail: error.message });
  }
});

/**
 * DELETE /api/admin/users/:id/package
 * 取消用户套餐
 */
router.delete('/user/:userId/package', async (req, res) => {
  try {
    const { userId } = req.params;

    // 检查用户是否绑定了套餐
    const [existing] = await query('SELECT id, package_id FROM user_packages WHERE user_id = ?', [userId]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '用户未绑定套餐' });
    }

    await query('DELETE FROM user_packages WHERE user_id = ?', [userId]);

    // 清除用户缓存
    await invalidateUserPackageCache(userId);

    req.audit = {
      action: 'package.unassign',
      targetType: 'user_package',
      targetId: userId,
      before: { package_id: existing.package_id }
    };

    res.json({ success: true, message: '套餐已取消' });
  } catch (error) {
    console.error('[packages] unassign error:', error);
    res.status(500).json({ success: false, error: '取消套餐失败' });
  }
});

// ==================== 批量操作接口 ====================

/**
 * POST /api/admin/packages/:id/batch-assign
 * 批量给用户绑定套餐
 */
router.post('/:id/batch-assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_ids } = req.body;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'user_ids 必填且必须是非空数组' });
    }

    // 检查套餐是否存在
    const [pkg] = await query('SELECT id, name FROM packages WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!pkg) {
      return res.status(404).json({ success: false, error: '套餐不存在' });
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    for (const userId of user_ids) {
      try {
        // 检查用户是否存在
        const [user] = await query('SELECT id FROM user_users WHERE id = ?', [userId]);
        if (!user) {
          failCount++;
          errors.push({ user_id: userId, error: '用户不存在' });
          continue;
        }

        // 检查用户是否已绑定套餐
        const [existing] = await query('SELECT id FROM user_packages WHERE user_id = ?', [userId]);

        if (existing) {
          await query(
            `UPDATE user_packages
             SET package_id = ?, package_name = ?, assigned_by = ?, assigned_at = NOW()
             WHERE user_id = ?`,
            [id, pkg.name, req.user?.id || null, userId]
          );
        } else {
          await query(
            `INSERT INTO user_packages
             (user_id, package_id, package_name, assigned_by, assigned_at)
             VALUES (?, ?, ?, ?, NOW())`,
            [userId, id, pkg.name, req.user?.id || null]
          );
        }

        // 清除用户缓存
        await invalidateUserPackageCache(userId);
        successCount++;
      } catch (err) {
        failCount++;
        errors.push({ user_id: userId, error: err.message });
      }
    }

    req.audit = {
      action: 'package.batch_assign',
      targetType: 'package',
      targetId: id,
      after: { package_id: id, user_ids, successCount, failCount }
    };

    res.json({
      success: true,
      message: `批量绑定完成：成功 ${successCount} 个，失败 ${failCount} 个`,
      data: { successCount, failCount, errors }
    });
  } catch (error) {
    console.error('[packages] batch-assign error:', error);
    res.status(500).json({ success: false, error: '批量绑定失败', detail: error.message });
  }
});

module.exports = router;
