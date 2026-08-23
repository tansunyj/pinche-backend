/**
 * 用户套餐查询接口（公开接口，用于用户端和 Java Gateway）
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const redis = require('../db/redis');

/**
 * GET /api/user/package
 * 获取当前用户的套餐信息（需要用户 JWT）
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: '未登录' });
    }

    // 尝试从 Redis 缓存获取
    const cacheKey = `package:user:${userId}`;
    try {
      const cacheData = await redis.hgetall(cacheKey);
      if (cacheData && Object.keys(cacheData).length > 0) {
        // 检查是否过期
        const endAt = cacheData.end_at;
        if (endAt && new Date(endAt) < new Date()) {
          // 缓存已过期，删除缓存
          await redis.del(cacheKey);
        } else {
          // 返回缓存数据
          return res.json({
            success: true,
            data: {
              package_id: cacheData.package_id ? parseInt(cacheData.package_id) : null,
              package_name: cacheData.package_name || null,
              models: cacheData.models ? JSON.parse(cacheData.models) : [],
              start_at: cacheData.start_at || null,
              end_at: cacheData.end_at || null,
              assigned_at: cacheData.assigned_at || null,
              cached: true
            }
          });
        }
      }
    } catch (cacheErr) {
      console.error('[UserPackage] 缓存读取失败:', cacheErr.message);
    }

    // 查询数据库
    const [row] = await query(
      `SELECT
        up.package_id,
        up.package_name,
        up.assigned_at,
        p.models,
        p.status,
        p.start_at,
        p.end_at
      FROM user_packages up
      LEFT JOIN packages p ON up.package_id = p.id
      WHERE up.user_id = ?
        AND p.deleted_at IS NULL
        AND p.status = 1`,
      [userId]
    );

    if (!row) {
      return res.json({ success: true, data: null });
    }

    // 检查套餐是否过期
    if (row.end_at && new Date(row.end_at) < new Date()) {
      return res.json({ success: true, data: null, message: '套餐已过期' });
    }

    // 检查套餐是否待生效
    if (row.start_at && new Date(row.start_at) > new Date()) {
      return res.json({ success: true, data: null, message: '套餐尚未生效' });
    }

    // mysql2 execute() 会自动解析 MySQL JSON 列，兼容字符串和已解析对象
    let models = [];
    const rawModels = row.models;
    if (rawModels) {
      if (typeof rawModels === 'object') {
        models = Array.isArray(rawModels) ? rawModels : [rawModels];
      } else {
        try { models = JSON.parse(rawModels); } catch (e) { models = []; }
      }
    }

    const result = {
      package_id: row.package_id,
      package_name: row.package_name,
      models,
      start_at: row.start_at,
      end_at: row.end_at,
      assigned_at: row.assigned_at
    };

    // 写入 Redis 缓存
    try {
      await redis.hmset(cacheKey, {
        package_id: String(result.package_id),
        package_name: result.package_name || '',
        models: JSON.stringify(models),
        start_at: result.start_at || '',
        end_at: result.end_at || '',
        assigned_at: result.assigned_at || ''
      });
      await redis.expire(cacheKey, 300); // TTL 5分钟
    } catch (cacheErr) {
      console.error('[UserPackage] 缓存写入失败:', cacheErr.message);
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[user-package] get error:', error);
    res.status(500).json({ success: false, error: '获取用户套餐失败' });
  }
});

module.exports = router;
