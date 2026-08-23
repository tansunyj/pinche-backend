/**
 * 邀请奖励管理路由 (admin_backend版本)
 *
 * 功能：
 * - 奖励申请列表查询与审批（按邀请人分组）
 * - 批量发放奖励
 * - 邀请人统计查询
 *
 * 注意：连接的是与website_backend相同的MySQL数据库
 */

const { Router } = require('express');
const { body, validationResult, query, param } = require('express-validator');
const { query: dbQuery } = require('../db/init');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = Router();

// 审核日志辅助函数
const auditLog = (req, action, targetType, targetId, details) => {
  if (req.audit) {
    req.audit.action = action;
    req.audit.targetType = targetType;
    req.audit.targetId = String(targetId);
    req.audit.after = details;
  }
};

// ============================================
// 按邀请人分组获取奖励汇总列表
// ============================================
router.get(
  '/reward-groups',
  authMiddleware,
  adminMiddleware,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['pending', 'approved', 'rejected', 'issued', 'all']),
    query('startMonth').optional().matches(/^\d{4}-\d{2}$/),
    query('endMonth').optional().matches(/^\d{4}-\d{2}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      const statusParam = req.query.status || 'pending';
      const startMonth = req.query.startMonth;
      const endMonth = req.query.endMonth;
      const offset = (page - 1) * limit;

      // 构建查询条件
      const conditions = [];
      const values = [];

      if (statusParam && statusParam !== 'all') {
        conditions.push('r.status = ?');
        values.push(statusParam);
      }

      if (startMonth && endMonth) {
        conditions.push('r.settlement_month BETWEEN ? AND ?');
        values.push(startMonth, endMonth);
      } else if (startMonth) {
        conditions.push('r.settlement_month >= ?');
        values.push(startMonth);
      } else if (endMonth) {
        conditions.push('r.settlement_month <= ?');
        values.push(endMonth);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // 查询汇总统计（新表结构已是按月聚合）
      const summaryRows = await dbQuery(
        `SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as total_pending,
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as total_approved,
          SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as total_rejected,
          SUM(CASE WHEN status = 'pending' THEN total_reward_amount ELSE 0 END) as total_pending_amount
        FROM invite_rewards r
        ${whereClause}`,
        values
      );

      const summary = summaryRows?.[0];

      // 查询邀请人列表（新表结构已是按月聚合）
      const groupRows = await dbQuery(
        `SELECT
          r.id,
          r.inviter_id,
          i.name as inviter_name,
          r.settlement_month,
          r.status,
          r.total_invitee_count as invitee_count,
          r.total_recharge_amount as total_recharge,
          r.total_consumption_points as total_consumption,
          r.total_reward_amount as total_reward,
          r.created_at,
          r.detail_json
        FROM invite_rewards r
        LEFT JOIN user_users i ON r.inviter_id = i.id
        ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
        values
      );

      // 查询总数
      const countRows = await dbQuery(
        `SELECT COUNT(*) as total FROM invite_rewards r ${whereClause}`,
        values
      );
      const total = countRows?.[0]?.total || 0;

      const list = Array.isArray(groupRows)
        ? groupRows.map((row) => ({
            id: `${row.inviter_id}-${row.settlement_month}`,
            inviter: {
              id: row.inviter_id,
              nickname: row.inviter_name || '未知用户',
            },
            settlement_month: row.settlement_month,
            status: row.status,
            invitee_count: row.invitee_count,
            total_recharge: Number(row.total_recharge || 0),
            total_consumption: Number(row.total_consumption || 0),
            total_reward: Number(row.total_reward || 0),
            created_at: row.created_at,
            reward_ids: [row.id],
            detail_json: row.detail_json,
          }))
        : [];

      res.json({
        success: true,
        data: {
          summary: {
            totalPending: summary?.total_pending || 0,
            totalApproved: summary?.total_approved || 0,
            totalRejected: summary?.total_rejected || 0,
            totalRewardAmount: Number(summary?.total_pending_amount || 0),
          },
          list,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      console.error('Get reward groups error:', error);
      res.status(500).json({ success: false, error: '获取奖励分组列表失败' });
    }
  }
);

// ============================================
// 获取某个邀请人+月份的明细列表
// ============================================
router.get(
  '/reward-groups/:inviterId/:month/detail',
  authMiddleware,
  adminMiddleware,
  [
    param('inviterId').isInt({ min: 1 }),
    param('month').matches(/^\d{4}-\d{2}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    try {
      const inviterId = parseInt(req.params.inviterId);
      const month = req.params.month;

      // 查询聚合记录，从 detail_json 解析明细
      const rows = await dbQuery(
        `SELECT
          r.id,
          r.detail_json,
          r.status,
          r.created_at
        FROM invite_rewards r
        WHERE r.inviter_id = ? AND r.settlement_month = ?
        LIMIT 1`,
        [inviterId, month]
      );

      if (!rows || rows.length === 0) {
        return res.json({
          success: true,
          data: { list: [] },
        });
      }

      const record = rows[0];
      let detailList = [];
      try {
        detailList = JSON.parse(record.detail_json || '[]');
      } catch (e) {
        console.error('Parse detail_json error:', e);
      }

      // 查询被邀请人信息
      const inviteeIds = detailList.map(d => d.invitee_id).filter(id => id);
      let inviteeMap = {};
      if (inviteeIds.length > 0) {
        const placeholders = inviteeIds.map(() => '?').join(',');
        const userRows = await dbQuery(
          `SELECT id, name FROM user_users WHERE id IN (${placeholders})`,
          inviteeIds
        );
        if (Array.isArray(userRows)) {
          userRows.forEach(u => {
            inviteeMap[u.id] = u.name || '未知用户';
          });
        }
      }

      const list = detailList.map((item, index) => ({
        id: `${record.id}-${index}`,
        invitee: {
          id: item.invitee_id,
          nickname: inviteeMap[item.invitee_id] || '未知用户',
        },
        recharge_amount: Number(item.recharge_amount || 0),
        recharge_count: item.recharge_count || 0,
        consumption_points: Number(item.consumption_points || 0),
        consumption_count: item.consumption_count || 0,
        reward_amount: Number(item.reward_amount || 0),
        status: record.status,
        created_at: record.created_at,
      }));

      res.json({
        success: true,
        data: { list },
      });
    } catch (error) {
      console.error('Get reward group detail error:', error);
      res.status(500).json({ success: false, error: '获取明细失败' });
    }
  }
);

// ============================================
// 批量通过并发放（按组）
// ============================================
router.post(
  '/reward-groups/:inviterId/:month/approve',
  authMiddleware,
  adminMiddleware,
  [
    param('inviterId').isInt({ min: 1 }),
    param('month').matches(/^\d{4}-\d{2}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    try {
      const inviterId = parseInt(req.params.inviterId);
      const month = req.params.month;
      const adminId = req.user.id;

      console.log(`[Approve Group] Starting for inviterId=${inviterId}, month=${month}, adminId=${adminId}`);

      // 查询该组所有待发放的奖励
      const rows = await dbQuery(
        'SELECT * FROM invite_rewards WHERE inviter_id = ? AND settlement_month = ? AND status = ?',
        [inviterId, month, 'pending']
      );

      console.log(`[Approve Group] Found ${rows?.length || 0} pending rewards`);

      if (!rows || rows.length === 0) {
        return res.status(400).json({ success: false, error: '没有可发放的奖励记录' });
      }

      const db = await require('../db/init').getDb();
      const conn = await db.getConnection();
      let successCount = 0;
      const pointsPerYuan = Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;

      console.log(`[Approve Group] Using pointsPerYuan=${pointsPerYuan}`);

      try {
        await conn.beginTransaction();

        // 计算总奖励金额（使用 total_reward_amount 字段）
        const totalReward = rows.reduce((sum, r) => sum + Number(r.total_reward_amount || 0), 0);
        const totalPoints = Math.floor(totalReward * pointsPerYuan);

        console.log(`[Approve Group] Total reward=${totalReward}, totalPoints=${totalPoints}`);

        if (totalPoints > 0) {
          // 更新用户余额
          console.log(`[Approve Group] Updating user balance for user ${inviterId}`);
          await conn.execute(
            'UPDATE user_users SET balance = balance + ? WHERE id = ?',
            [totalPoints, inviterId]
          );

          // 查询更新后的余额
          console.log(`[Approve Group] Querying updated balance`);
          const [userRows] = await conn.execute(
            'SELECT balance FROM user_users WHERE id = ? LIMIT 1',
            [inviterId]
          );
          console.log(`[Approve Group] User rows result:`, JSON.stringify(userRows));
          const balanceAfter = Number(userRows?.[0]?.balance || 0);

          // 写账户流水（汇总一条）
          console.log(`[Approve Group] Inserting billing transaction`);
          await conn.execute(
            `INSERT INTO billing_transactions
             (user_id, type, delta, balance_after, ref_type, ref_id, remark)
             VALUES (?, 'reward', ?, ?, 'invite_reward', ?, ?)`,
            [inviterId, totalPoints, balanceAfter, rows[0].id, `邀请奖励：${month}月（共${rows.length}人）`]
          );
        }

        // 更新所有奖励记录状态
        console.log(`[Approve Group] Updating reward records`);
        for (const reward of rows) {
          await conn.execute(
            `UPDATE invite_rewards
             SET status = 'issued',
                 reviewed_by = ?,
                 reviewed_at = NOW(),
                 issued_at = NOW(),
                 issued_by = ?
             WHERE id = ?`,
            [adminId, adminId, reward.id]
          );

          // 从 detail_json 解析被邀请人ID列表，更新 invitee_stats
          console.log(`[Approve Group] Updating invitee_stats for reward ${reward.id}`);
          let detailList = [];
          try {
            detailList = JSON.parse(reward.detail_json || '[]');
          } catch (e) {
            console.error(`[Approve Group] Parse detail_json error for reward ${reward.id}:`, e);
          }

          for (const detail of detailList) {
            if (detail.invitee_id) {
              await conn.execute(
                `UPDATE invitee_stats
                 SET settlement_status = 'rewarded'
                 WHERE inviter_id = ?
                   AND invitee_id = ?
                   AND stat_type = 'monthly'
                   AND period = ?`,
                [reward.inviter_id, detail.invitee_id, reward.settlement_month]
              );
            }
          }

          successCount++;
        }

        console.log(`[Approve Group] Committing transaction`);
        await conn.commit();

        auditLog(req, 'APPROVE_INVITE_REWARD_GROUP', 'invite_reward', inviterId, {
          inviterId,
          month,
          count: successCount,
          totalReward,
        });

        res.json({
          success: true,
          data: {
            inviterId,
            month,
            count: successCount,
            totalReward,
            status: 'issued',
          },
        });
      } catch (err) {
        console.error('[Approve Group] Transaction error:', err);
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error('[Approve Group] Outer error:', error);
      res.status(500).json({ success: false, error: error.message || '审批失败' });
    }
  }
);

// ============================================
// 批量拒绝（按组）
// ============================================
router.post(
  '/reward-groups/:inviterId/:month/reject',
  authMiddleware,
  adminMiddleware,
  [
    param('inviterId').isInt({ min: 1 }),
    param('month').matches(/^\d{4}-\d{2}$/),
    body('reason').trim().notEmpty().isLength({ max: 255 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    try {
      const inviterId = parseInt(req.params.inviterId);
      const month = req.params.month;
      const adminId = req.user.id;
      const reason = req.body.reason;

      // 查询该组所有待审批的奖励
      const rows = await dbQuery(
        'SELECT * FROM invite_rewards WHERE inviter_id = ? AND settlement_month = ? AND status = ?',
        [inviterId, month, 'pending']
      );

      if (!rows || rows.length === 0) {
        return res.status(400).json({ success: false, error: '没有可拒绝的奖励记录' });
      }

      // 更新所有记录状态为拒绝
      for (const reward of rows) {
        await dbQuery(
          `UPDATE invite_rewards
           SET status = 'rejected',
               reviewed_by = ?,
               reviewed_at = NOW(),
               review_remark = ?
           WHERE id = ?`,
          [adminId, reason.trim(), reward.id]
        );
      }

      auditLog(req, 'REJECT_INVITE_REWARD_GROUP', 'invite_reward', inviterId, {
        inviterId,
        month,
        count: rows.length,
        reason: reason.trim(),
      });

      res.json({
        success: true,
        data: {
          inviterId,
          month,
          count: rows.length,
          status: 'rejected',
        },
      });
    } catch (error) {
      console.error('Reject group error:', error);
      res.status(500).json({ success: false, error: error.message || '拒绝失败' });
    }
  }
);

// ============================================
// 批量发放（按选中的组）
// ============================================
router.post(
  '/batch-issue',
  authMiddleware,
  adminMiddleware,
  [
    body('groups').isArray({ min: 1 }).withMessage('groups 必须是非空数组'),
    body('groups.*.inviterId').isInt({ min: 1 }),
    body('groups.*.month').matches(/^\d{4}-\d{2}$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    try {
      const adminId = req.user.id;
      const groups = req.body.groups;

      let totalSuccess = 0;
      let totalFail = 0;
      const pointsPerYuan = Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;

      for (const group of groups) {
        const { inviterId, month } = group;

        try {
          // 查询该组所有已批准的奖励
          const rows = await dbQuery(
            'SELECT * FROM invite_rewards WHERE inviter_id = ? AND settlement_month = ? AND status = ?',
            [inviterId, month, 'approved']
          );

          if (!rows || rows.length === 0) {
            totalFail++;
            continue;
          }

          const db = await require('../db/init').getDb();
          const conn = await db.getConnection();

          try {
            await conn.beginTransaction();

            const totalReward = rows.reduce((sum, r) => sum + Number(r.total_reward_amount || 0), 0);
            const totalPoints = Math.floor(totalReward * pointsPerYuan);

            if (totalPoints > 0) {
              await conn.execute(
                'UPDATE user_users SET balance = balance + ? WHERE id = ?',
                [totalPoints, inviterId]
              );

              const [userRows] = await conn.execute(
                'SELECT balance FROM user_users WHERE id = ? LIMIT 1',
                [inviterId]
              );
              const balanceAfter = Number(userRows[0]?.balance || 0);

              await conn.execute(
                `INSERT INTO billing_transactions
                 (user_id, type, delta, balance_after, ref_type, ref_id, remark)
                 VALUES (?, 'reward', ?, ?, 'invite_reward', ?, ?)`,
                [inviterId, totalPoints, balanceAfter, rows[0].id, `邀请奖励：${month}月（共${rows.length}人）`]
              );
            }

            for (const reward of rows) {
              await conn.execute(
                `UPDATE invite_rewards
                 SET status = 'issued',
                     reviewed_by = ?,
                     reviewed_at = NOW(),
                     issued_at = NOW(),
                     issued_by = ?
                 WHERE id = ?`,
                [adminId, adminId, reward.id]
              );

              // 从 detail_json 解析被邀请人ID列表，更新 invitee_stats
              let detailList = [];
              try {
                detailList = JSON.parse(reward.detail_json || '[]');
              } catch (e) {
                console.error(`[Batch Issue] Parse detail_json error for reward ${reward.id}:`, e);
              }

              for (const detail of detailList) {
                if (detail.invitee_id) {
                  await conn.execute(
                    `UPDATE invitee_stats
                     SET settlement_status = 'rewarded'
                     WHERE inviter_id = ?
                       AND invitee_id = ?
                       AND stat_type = 'monthly'
                       AND period = ?`,
                    [reward.inviter_id, detail.invitee_id, reward.settlement_month]
                  );
                }
              }
            }

            await conn.commit();
            totalSuccess++;
          } catch (err) {
            await conn.rollback();
            throw err;
          } finally {
            conn.release();
          }
        } catch (err) {
          console.error(`Batch issue error for group ${inviterId}-${month}:`, err);
          totalFail++;
        }
      }

      auditLog(req, 'BATCH_ISSUE_INVITE_REWARD_GROUPS', 'invite_reward', 0, {
        groups,
        totalSuccess,
        totalFail,
      });

      res.json({
        success: true,
        data: {
          successCount: totalSuccess,
          failCount: totalFail,
          total: groups.length,
        },
      });
    } catch (error) {
      console.error('Batch issue error:', error);
      res.status(500).json({ success: false, error: error.message || '批量发放失败' });
    }
  }
);

module.exports = router;
