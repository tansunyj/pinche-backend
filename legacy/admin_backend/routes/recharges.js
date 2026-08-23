/**
 * 充值记录管理路由
 * 路径: /api/admin/recharges
 */
const express = require('express');
const router = express.Router();
const { query } = require('../db/init');

/**
 * GET /api/admin/recharges
 * 获取所有充值记录列表（支持分页、筛选、排序）
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      pageSize = 20,
      userId,
      userName,
      orderNo,
      status,
      paymentChannel,
      startDate,
      endDate,
      sortField = 'created_at',
      sortOrder = 'desc'
    } = req.query;

    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;

    // 构建 WHERE 条件
    const whereConditions = ['1=1'];
    const params = [];

    if (userId) {
      whereConditions.push('o.user_id = ?');
      params.push(userId);
    }

    if (userName) {
      whereConditions.push('u.name LIKE ?');
      params.push(`%${userName}%`);
    }

    if (orderNo) {
      whereConditions.push('o.order_no LIKE ?');
      params.push(`%${orderNo}%`);
    }

    if (status) {
      whereConditions.push('o.status = ?');
      params.push(status);
    }

    if (paymentChannel) {
      whereConditions.push('o.payment_channel = ?');
      params.push(paymentChannel);
    }

    if (startDate) {
      whereConditions.push('o.created_at >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('o.created_at <= ?');
      params.push(endDate);
    }

    const whereClause = whereConditions.join(' AND ');

    // 排序字段映射
    const allowedSortFields = ['created_at', 'paid_at', 'amount', 'points', 'status'];
    const finalSortField = allowedSortFields.includes(sortField) ? sortField : 'created_at';
    const finalSortOrder = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // 查询总数
    const countSql = `
      SELECT COUNT(*) as total
      FROM billing_orders o
      LEFT JOIN user_users u ON o.user_id = u.id
      WHERE ${whereClause}
    `;
    const [countResult] = await query(countSql, params);
    const total = countResult?.total || 0;

    // 查询充值记录
    const recordsSql = `
      SELECT
        o.id,
        o.order_no,
        o.user_id,
        u.name as user_name,
        u.email as user_email,
        o.amount,
        o.points,
        o.payment_channel,
        o.payment_method,
        o.status,
        o.paid_at,
        o.created_at,
        o.updated_at
      FROM billing_orders o
      LEFT JOIN user_users u ON o.user_id = u.id
      WHERE ${whereClause}
      ORDER BY ${finalSortField} ${finalSortOrder}
      LIMIT ${limit} OFFSET ${offset}
    `;
    const records = await query(recordsSql, params);

    // 统计信息
    const statsSql = `
      SELECT
        COUNT(*) as total_count,
        SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN o.status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN o.status = 'paid' THEN o.amount ELSE 0 END) as total_paid_amount,
        SUM(CASE WHEN o.status = 'paid' THEN o.points ELSE 0 END) as total_paid_points
      FROM billing_orders o
      LEFT JOIN user_users u ON o.user_id = u.id
      WHERE ${whereClause}
    `;
    const [stats] = await query(statsSql, [...params]);

    // 格式化返回数据
    const formattedRecords = records.map(r => ({
      id: r.id,
      order_no: r.order_no,
      user_id: r.user_id,
      user_name: r.user_name,
      user_email: r.user_email,
      amount: parseFloat(r.amount) || 0,
      points: parseInt(r.points) || 0,
      payment_channel: r.payment_channel,
      payment_method: r.payment_method,
      status: r.status, // pending, paid, failed, cancelled, expired
      paid_at: r.paid_at,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));

    res.json({
      success: true,
      data: formattedRecords,
      stats: {
        totalCount: parseInt(stats?.total_count) || 0,
        paidCount: parseInt(stats?.paid_count) || 0,
        pendingCount: parseInt(stats?.pending_count) || 0,
        failedCount: parseInt(stats?.failed_count) || 0,
        totalPaidAmount: parseFloat(stats?.total_paid_amount) || 0,
        totalPaidPoints: parseInt(stats?.total_paid_points) || 0
      },
      pagination: {
        total,
        page: parseInt(page),
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[Recharges] 获取充值记录失败:', error);
    res.status(500).json({ success: false, error: '获取充值记录失败: ' + error.message });
  }
});

/**
 * GET /api/admin/recharges/channels
 * 获取所有支付渠道列表（用于筛选）
 */
router.get('/channels', async (req, res) => {
  try {
    const rows = await query(
      `SELECT DISTINCT payment_channel
       FROM billing_orders
       WHERE payment_channel IS NOT NULL AND payment_channel != ''
       ORDER BY payment_channel`
    );
    res.json({
      success: true,
      data: rows.map(r => r.payment_channel)
    });
  } catch (error) {
    console.error('[Recharges] 获取支付渠道失败:', error);
    res.status(500).json({ success: false, error: '获取支付渠道失败' });
  }
});

module.exports = router;
