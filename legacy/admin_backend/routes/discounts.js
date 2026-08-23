/**
 * 折扣活动管理（model_discounts）
 *
 * 一个活动可以指定：
 *   - discount_type：percentage（百分比）/ fixed_amount（固定金额）/ free（限免）
 *   - discount_value：折扣值（如 0.7 表示 7 折；金额或免费时另解释）
 *   - scope_type：all / model / category / provider / user_tier / specific_users
 *   - scope_targets：JSON 数组，目标对象的 ID 列表
 *   - 时间窗口、用量限制、优先级、是否可叠加
 *
 * 用户站显示规则：用 GET /active 拿当前生效的活动用于角标渲染
 *
 * 全部需要鉴权。仅 GET /active 公开（也单独再暴露一个公开版给 marketplace 接口用）
 */

const express = require('express');
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const publicRouter = express.Router();
const adminRouter = express.Router();
adminRouter.use(authMiddleware);

/** 公开：当前生效的折扣活动列表（不需要登录） */
publicRouter.get('/active', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, name, description, discount_type, discount_value,
              scope_type, scope_targets, start_time, end_time,
              display_badge, display_color, is_featured,
              max_uses_per_user, max_total_uses, current_uses,
              priority, stackable
         FROM model_discounts
        WHERE status = 1
          AND start_time <= NOW()
          AND end_time   >= NOW()
        ORDER BY priority DESC, id ASC`
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('[discounts] active list error:', e);
    res.status(500).json({ success: false, error: '获取活动失败' });
  }
});

/** 列表（管理员）—— 含未开始 / 已结束 / 草稿 */
adminRouter.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT * FROM model_discounts`;
    const params = [];
    if (status !== undefined && status !== '') {
      sql += ` WHERE status = ?`;
      params.push(parseInt(status));
    }
    sql += ` ORDER BY priority DESC, id DESC`;
    const rows = await query(sql, params);
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('[discounts] list error:', e);
    res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

/** 单条详情 */
adminRouter.get('/:id', async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM model_discounts WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: '活动不存在' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

/** 创建活动 */
adminRouter.post('/', async (req, res) => {
  const b = req.body || {};
  const required = ['name', 'discount_type', 'discount_value', 'scope_type', 'start_time', 'end_time'];
  for (const k of required) {
    if (b[k] === undefined || b[k] === null || b[k] === '') {
      return res.status(400).json({ success: false, error: `${k} 必填` });
    }
  }
  try {
    const result = await query(
      `INSERT INTO model_discounts
        (name, description, discount_type, discount_value,
         scope_type, scope_targets,
         start_time, end_time, timezone,
         max_uses_per_user, max_total_uses,
         min_order_amount, stackable, priority,
         status, display_badge, display_color, is_featured,
         created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.name,
        b.description ?? null,
        b.discount_type,
        b.discount_value,
        b.scope_type,
        b.scope_targets ? JSON.stringify(b.scope_targets) : null,
        b.start_time,
        b.end_time,
        b.timezone ?? 'Asia/Shanghai',
        b.max_uses_per_user ?? null,
        b.max_total_uses ?? null,
        b.min_order_amount ?? 0,
        b.stackable ? 1 : 0,
        b.priority ?? 0,
        b.status ?? 0, // 默认草稿
        b.display_badge ?? null,
        b.display_color ?? '#ff6b6b',
        b.is_featured ? 1 : 0,
        req.user?.id ?? null,
      ]
    );
    req.audit = {
      action: 'discount.create',
      targetType: 'discount',
      targetId: result.insertId,
      after: b,
    };
    res.json({ success: true, id: result.insertId, message: '活动已创建（默认草稿状态）' });
  } catch (e) {
    console.error('[discounts] create error:', e);
    res.status(500).json({ success: false, error: '创建失败', detail: e.message });
  }
});

/** 更新活动 */
adminRouter.put('/:id', async (req, res) => {
  const editable = [
    'name', 'description', 'discount_type', 'discount_value',
    'scope_type',
    'start_time', 'end_time', 'timezone',
    'max_uses_per_user', 'max_total_uses',
    'min_order_amount', 'stackable', 'priority',
    'status', 'display_badge', 'display_color', 'is_featured',
  ];
  const sets = [];
  const params = [];
  for (const f of editable) {
    if (req.body && req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (req.body && req.body.scope_targets !== undefined) {
    sets.push('scope_targets = ?');
    params.push(req.body.scope_targets ? JSON.stringify(req.body.scope_targets) : null);
  }
  if (sets.length === 0) {
    return res.status(400).json({ success: false, error: '无更新字段' });
  }
  try {
    const beforeRows = await query('SELECT * FROM model_discounts WHERE id = ?', [req.params.id]);
    if (beforeRows.length === 0) {
      return res.status(404).json({ success: false, error: '活动不存在' });
    }
    params.push(req.params.id);
    const r = await query(
      `UPDATE model_discounts SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '活动不存在' });
    }
    req.audit = {
      action: 'discount.update',
      targetType: 'discount',
      targetId: req.params.id,
      before: beforeRows[0],
      after: req.body,
    };

    // 清除折扣活动缓存（使折扣变更立即生效）
    try {
      const keys = await redis.keys('model_discounts:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[DiscountUpdate] 清除折扣活动缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[DiscountUpdate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '更新成功' });
  } catch (e) {
    console.error('[discounts] update error:', e);
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

/** 删除活动 */
adminRouter.delete('/:id', async (req, res) => {
  try {
    const beforeRows = await query('SELECT * FROM model_discounts WHERE id = ?', [req.params.id]);
    const r = await query(`DELETE FROM model_discounts WHERE id = ?`, [req.params.id]);
    if (r.affectedRows === 0) {
      return res.status(404).json({ success: false, error: '活动不存在' });
    }
    req.audit = {
      action: 'discount.delete',
      targetType: 'discount',
      targetId: req.params.id,
      before: beforeRows[0] || null,
    };

    // 清除折扣活动缓存（使删除立即生效）
    try {
      const keys = await redis.keys('model_discounts:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[DiscountDelete] 清除折扣活动缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[DiscountDelete] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '已删除' });
  } catch (e) {
    console.error('[discounts] delete error:', e);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

/** 快捷操作：上线 / 下线 */
adminRouter.post('/:id/launch', async (req, res) => {
  try {
    await query(`UPDATE model_discounts SET status = 1 WHERE id = ?`, [req.params.id]);
    req.audit = { action: 'discount.launch', targetType: 'discount', targetId: req.params.id, after: { status: 1 } };

    // 清除折扣活动缓存（使状态变更立即生效）
    try {
      const keys = await redis.keys('model_discounts:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[DiscountLaunch] 清除折扣活动缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[DiscountLaunch] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '已上线' });
  } catch (e) {
    res.status(500).json({ success: false, error: '操作失败' });
  }
});
adminRouter.post('/:id/end', async (req, res) => {
  try {
    await query(`UPDATE model_discounts SET status = 2 WHERE id = ?`, [req.params.id]);
    req.audit = { action: 'discount.end', targetType: 'discount', targetId: req.params.id, after: { status: 2 } };

    // 清除折扣活动缓存（使状态变更立即生效）
    try {
      const keys = await redis.keys('model_discounts:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`[DiscountEnd] 清除折扣活动缓存: ${keys.length} 个`);
      }
    } catch (redisErr) {
      console.error(`[DiscountEnd] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true, message: '已结束' });
  } catch (e) {
    res.status(500).json({ success: false, error: '操作失败' });
  }
});

module.exports = { publicRouter, adminRouter };
