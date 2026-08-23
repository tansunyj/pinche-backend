/**
 * 优惠活动管理
 * 表：promotions, user_coupons, token_promotions
 */

const express = require('express');
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

const REDIS_KEY = 'promotions:active';

async function refreshPromotionsCache() {
  const rows = await query(
    `SELECT id, name, description, start_at, end_at,
            discount_rate, gift_amount, gift_ratio, rpm_limit,
            models, max_per_user, total_limit, issued_count
     FROM promotions
     WHERE is_online = 1 AND end_at >= NOW()
     ORDER BY created_at DESC`
  );
  if (rows.length === 0) {
    await redis.del(REDIS_KEY);
    return;
  }
  // TTL = 最近活动截止时间到现在的秒数
  const minEndAt = Math.min(...rows.map(r => new Date(r.end_at).getTime()));
  const ttl = Math.max(60, Math.floor((minEndAt - Date.now()) / 1000));
  await redis.setex(REDIS_KEY, ttl, JSON.stringify(rows));
}

const publicRouter = express.Router();
const adminRouter = express.Router();
adminRouter.use(authMiddleware);

// ============================================================
// 公开接口（用户端）
// ============================================================

/** 获取公开活动列表（visibility=public 且在有效期内） */
publicRouter.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, name, description, start_at, end_at,
              discount_rate, gift_amount, gift_ratio, rpm_limit,
              models, max_per_user, total_limit, issued_count
       FROM promotions
       WHERE visibility = 'public'
         AND start_at <= NOW() AND end_at >= NOW()
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '获取活动列表失败' });
  }
});

// ============================================================
// 管理员接口
// ============================================================

/** 活动列表（全部） */
adminRouter.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let where = '1=1';
    if (status === 'upcoming') where += ' AND NOW() < start_at';
    else if (status === 'active') where += ' AND NOW() BETWEEN start_at AND end_at';
    else if (status === 'ended') where += ' AND NOW() > end_at';

    const rows = await query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM user_coupons WHERE promotion_id = p.id) AS issued_count
       FROM promotions p
       WHERE ${where}
       ORDER BY p.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '获取活动列表失败' });
  }
});

/** 创建活动 */
adminRouter.post('/', async (req, res) => {
  try {
    const {
      name, description, start_at, end_at, visibility = 'public',
      discount_rate = 1.0, gift_amount = 0, gift_ratio = 0,
      rpm_limit = 1000, models, max_per_user = 1, total_limit = 0,
    } = req.body;

    if (!name || !start_at || !end_at) {
      return res.status(400).json({ success: false, error: '名称、开始时间、结束时间为必填项' });
    }

    const result = await query(
      `INSERT INTO promotions
         (name, description, start_at, end_at, visibility,
          discount_rate, gift_amount, gift_ratio, rpm_limit,
          models, max_per_user, total_limit, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, description || null, start_at, end_at, visibility,
        discount_rate, gift_amount, gift_ratio, rpm_limit,
        models ? JSON.stringify(models) : null,
        max_per_user, total_limit, req.user.id,
      ]
    );

    res.json({ success: true, data: { id: result.insertId } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '创建活动失败' });
  }
});

/** 编辑活动 */
adminRouter.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, description, start_at, end_at, visibility,
      discount_rate, gift_amount, gift_ratio, rpm_limit,
      models, max_per_user, total_limit,
    } = req.body;

    await query(
      `UPDATE promotions SET
         name=?, description=?, start_at=?, end_at=?, visibility=?,
         discount_rate=?, gift_amount=?, gift_ratio=?, rpm_limit=?,
         models=?, max_per_user=?, total_limit=?
       WHERE id=?`,
      [
        name, description || null, start_at, end_at, visibility,
        discount_rate, gift_amount, gift_ratio, rpm_limit,
        models ? JSON.stringify(models) : null,
        max_per_user, total_limit, id,
      ]
    );

    // 清除活动缓存（使活动变更立即生效）
    try {
      await redis.del(REDIS_KEY);
      console.log(`[PromotionUpdate] 清除活动缓存: ${REDIS_KEY}`);
    } catch (redisErr) {
      console.error(`[PromotionUpdate] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '更新活动失败' });
  }
});

/** 删除活动 */
adminRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [coupon] = await query('SELECT id FROM user_coupons WHERE promotion_id = ? LIMIT 1', [id]);
    if (coupon) {
      return res.status(400).json({ success: false, error: '已有用户领取该活动，无法删除' });
    }
    await query('DELETE FROM promotions WHERE id = ?', [id]);

    // 清除活动缓存（使删除立即生效）
    try {
      await redis.del(REDIS_KEY);
      console.log(`[PromotionDelete] 清除活动缓存: ${REDIS_KEY}`);
    } catch (redisErr) {
      console.error(`[PromotionDelete] 清除缓存失败:`, redisErr.message);
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

/** 上线活动 */
adminRouter.post('/:id/online', async (req, res) => {
  try {
    await query('UPDATE promotions SET is_online = 1 WHERE id = ?', [req.params.id]);
    await refreshPromotionsCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '操作失败' });
  }
});

/** 下线活动 */
adminRouter.post('/:id/offline', async (req, res) => {
  try {
    await query('UPDATE promotions SET is_online = 0 WHERE id = ?', [req.params.id]);
    await refreshPromotionsCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '操作失败' });
  }
});

/** 管理员派发优惠券给指定用户 */
adminRouter.post('/:id/grant', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_ids, remark } = req.body;

    const [promotion] = await query('SELECT * FROM promotions WHERE id = ?', [id]);
    if (!promotion) return res.status(404).json({ success: false, error: '活动不存在' });

    // 解析 user_ids（支持逗号/换行分隔的字符串或数组）
    let ids = Array.isArray(user_ids)
      ? user_ids
      : String(user_ids).split(/[\s,，\n]+/).map(s => s.trim()).filter(Boolean);

    let success = 0, skipped = 0;
    for (const uid of ids) {
      try {
        await query(
          `INSERT IGNORE INTO user_coupons
             (user_id, promotion_id, source, granted_by, grant_remark, status, expired_at)
           VALUES (?, ?, 'granted', ?, ?, 'active', ?)`,
          [uid, id, req.user.id, remark || null, promotion.end_at]
        );
        success++;
      } catch {
        skipped++;
      }
    }

    res.json({ success: true, data: { success, skipped } });

    // 异步刷新活动缓存（派发优惠券后缓存需要更新）
    try {
      await refreshPromotionsCache();
      console.log(`[PromotionGrant] 派发优惠券后已刷新活动缓存`);
    } catch (redisErr) {
      console.error(`[PromotionGrant] 刷新缓存失败:`, redisErr.message);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '派发失败' });
  }
});

/** 查看活动的领取记录 */
adminRouter.get('/:id/coupons', async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await query(
      `SELECT uc.*, u.name as user_name, u.phone as user_phone, u.email as user_email
       FROM user_coupons uc
       LEFT JOIN user_users u ON uc.user_id = u.id
       WHERE uc.promotion_id = ?
       ORDER BY uc.claimed_at DESC`,
      [id]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '获取领取记录失败' });
  }
});

module.exports = { publicRouter, adminRouter };
