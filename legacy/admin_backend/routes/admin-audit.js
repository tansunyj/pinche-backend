/**
 * 管理员审计日志查询接口
 *   GET /api/admin/audit-logs
 *     query: page, pageSize, admin_id, action, target_type, target_id,
 *            start_date, end_date, q
 *
 *   GET /api/admin/audit-logs/:id
 *     返回单条完整详情（含 before/after JSON）
 *
 *   GET /api/admin/audit-logs/meta
 *     返回过滤用的下拉字典：distinct actions / distinct target_types
 */

const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/meta', async (req, res) => {
  try {
    const [actions, targetTypes, admins] = await Promise.all([
      query('SELECT DISTINCT action FROM admin_audit_logs ORDER BY action ASC LIMIT 200'),
      query('SELECT DISTINCT target_type FROM admin_audit_logs WHERE target_type IS NOT NULL ORDER BY target_type ASC LIMIT 100'),
      query(`SELECT DISTINCT l.admin_id, u.username
               FROM admin_audit_logs l
               LEFT JOIN proxy_users u ON u.id = l.admin_id
              ORDER BY l.admin_id ASC LIMIT 200`),
    ]);
    res.json({
      success: true,
      data: {
        actions: actions.map(r => r.action),
        target_types: targetTypes.map(r => r.target_type),
        admins: admins.map(r => ({ id: r.admin_id, username: r.username })),
      },
    });
  } catch (e) {
    console.error('[admin-audit] meta error:', e);
    res.status(500).json({ success: false, error: '读取失败' });
  }
});

router.get('/', async (req, res) => {
  try {
    const {
      page = 1, pageSize = 20,
      admin_id, action, target_type, target_id, q,
      start_date, end_date,
    } = req.query;

    const where = [];
    const params = [];
    if (admin_id) { where.push('l.admin_id = ?'); params.push(parseInt(admin_id)); }
    if (action) { where.push('l.action = ?'); params.push(action); }
    if (target_type) { where.push('l.target_type = ?'); params.push(target_type); }
    if (target_id) { where.push('l.target_id = ?'); params.push(String(target_id)); }
    if (start_date) { where.push('l.created_at >= ?'); params.push(start_date); }
    if (end_date) { where.push('l.created_at <= ?'); params.push(end_date); }
    if (q) {
      where.push('(l.action LIKE ? OR l.target_type LIKE ? OR l.target_id LIKE ? OR u.username LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const totalRows = await query(
      `SELECT COUNT(*) as c
         FROM admin_audit_logs l
         LEFT JOIN proxy_users u ON u.id = l.admin_id
         ${whereClause}`,
      params
    );
    const total = totalRows[0].c;

    const limitVal = Math.min(parseInt(pageSize) || 20, 200);
    const offsetVal = (Math.max(parseInt(page) || 1, 1) - 1) * limitVal;

    const rows = await query(
      `SELECT l.id, l.admin_id, u.username AS admin_username,
              l.action, l.target_type, l.target_id,
              l.reason, l.ip, l.user_agent,
              DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              -- 列表不返回完整 before/after（可能很大），只返回大小
              OCTET_LENGTH(l.before_value) AS before_size,
              OCTET_LENGTH(l.after_value) AS after_size
         FROM admin_audit_logs l
         LEFT JOIN proxy_users u ON u.id = l.admin_id
         ${whereClause}
        ORDER BY l.id DESC
        LIMIT ${limitVal} OFFSET ${offsetVal}`,
      params
    );

    res.json({ success: true, data: { logs: rows, total, page: parseInt(page) || 1, pageSize: limitVal } });
  } catch (e) {
    console.error('[admin-audit] list error:', e);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const rows = await query(
      `SELECT l.*, u.username AS admin_username,
              DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at_fmt
         FROM admin_audit_logs l
         LEFT JOIN proxy_users u ON u.id = l.admin_id
        WHERE l.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: '记录不存在' });
    res.json({ success: true, data: rows[0] });
  } catch (e) {
    console.error('[admin-audit] get error:', e);
    res.status(500).json({ success: false, error: '查询失败' });
  }
});

module.exports = router;
