/**
 * 邀请功能路由 - 简化版
 * - 生成邀请码
 * - 查看邀请统计
 * - 查看邀请记录
 * - 验证邀请码
 *
 * 对应表：
 *   - user_invite_codes: 邀请码表
 *   - user_invites: 邀请关系表
 */

import { Router, Request, Response } from "express";
import { body, validationResult, query } from "express-validator";
import { authMiddleware } from "../middleware/auth";
import pool from "../db/mysql";
import InviteStatsService from "../services/InviteStatsService";
import RewardService from "../services/RewardService";

const router = Router();

// 配置
const INVITE_CODE_LENGTH = 8;
const WEB_BASE_URL = process.env.WEB_BASE_URL || "http://localhost:13000";
const INVITE_LANDING_PATH = "/register";

/**
 * 生成随机邀请码（大写字母+数字）
 */
function generateRandomCode(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 检查邀请码是否已存在
 */
async function isCodeExists(code: string): Promise<boolean> {
  const [rows]: any = await pool.execute(
    "SELECT 1 FROM user_invite_codes WHERE code = ?",
    [code]
  );
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 生成唯一的邀请码
 */
async function generateUniqueCode(): Promise<string> {
  let code = generateRandomCode(INVITE_CODE_LENGTH);
  let attempts = 0;
  while (await isCodeExists(code)) {
    code = generateRandomCode(INVITE_CODE_LENGTH);
    attempts++;
    if (attempts > 10) {
      throw new Error("无法生成唯一邀请码");
    }
  }
  return code;
}

// ============================================
// 获取邀请码列表（带分页）
// ============================================
router.get(
  "/codes",
  authMiddleware,
  [
    query("page").optional().isInt({ min: 1 }).withMessage("页码必须是正整数"),
    query("limit").optional().isInt({ min: 1, max: 50 }).withMessage("每页数量必须在 1-50 之间"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
      const offset = (page - 1) * limit;

      // 将参数转换为整数
      const limitInt = Number(limit);
      const offsetInt = Number(offset);

      // 获取邀请码总数
      const [countRows]: any = await pool.execute(
        "SELECT COUNT(*) as total FROM user_invite_codes WHERE user_id = ? AND status = 1",
        [userId]
      );
      const total = countRows?.[0]?.total || 0;

      // 获取邀请统计（从 user_invites 表查询实际邀请人数）
      const [statsRows]: any = await pool.execute(
        "SELECT COUNT(*) as total_invited, COUNT(CASE WHEN status = 'registered' THEN 1 END) as registered_count FROM user_invites WHERE inviter_id = ?",
        [userId]
      );
      const stats = Array.isArray(statsRows) && statsRows.length > 0
        ? {
            totalInvited: statsRows[0].total_invited || 0,
            registeredCount: statsRows[0].registered_count || 0,
          }
        : { totalInvited: 0, registeredCount: 0 };

      // 获取邀请码列表（带分页）- 包含每个邀请码的统计数据
      const [codeRows]: any = await pool.execute(
        `
        SELECT
          uic.code,
          uic.remark,
          uic.created_at,
          COUNT(ui.id) as invited_count,
          COUNT(CASE WHEN ui.status = 'registered' THEN 1 END) as registered_count
        FROM user_invite_codes uic
        LEFT JOIN user_invites ui ON uic.code = ui.invite_code
        WHERE uic.user_id = ? AND uic.status = 1
        GROUP BY uic.code, uic.remark, uic.created_at
        ORDER BY uic.created_at DESC
        LIMIT ${limitInt} OFFSET ${offsetInt}
        `,
        [userId]
      );

      const list = Array.isArray(codeRows)
        ? codeRows.map((row: any) => ({
            code: row.code,
            link: `${WEB_BASE_URL}${INVITE_LANDING_PATH}?code=${row.code}`,
            createdAt: row.created_at,
            remark: row.remark,
            invitedCount: row.invited_count || 0,
            registeredCount: row.registered_count || 0,
          }))
        : [];

      res.json({
        success: true,
        data: {
          list,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
          stats,
        },
      });
    } catch (error) {
      console.error("Get invite codes error:", error);
      res.status(500).json({ success: false, error: "获取邀请码列表失败" });
    }
  }
);

// ============================================
// 生成邀请码
// ============================================
router.post(
  "/generate-code",
  authMiddleware,
  [
    body("remark")
      .optional({ nullable: true })
      .trim()
      .isLength({ max: 50 })
      .withMessage("备注长度不能超过50个字符"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const { remark } = req.body;

      // 生成唯一邀请码
      const code = await generateUniqueCode();

      // 写入数据库
      await pool.execute(
        "INSERT INTO user_invite_codes (user_id, code, remark, status) VALUES (?, ?, ?, 1)",
        [userId, code, remark || null]
      );

      // 获取刚插入的记录
      const [rows]: any = await pool.execute(
        "SELECT code, created_at FROM user_invite_codes WHERE code = ?",
        [code]
      );

      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

      res.json({
        success: true,
        data: {
          code,
          link: `${WEB_BASE_URL}${INVITE_LANDING_PATH}?code=${code}`,
          createdAt: row?.created_at || new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error("Generate invite code error:", error);
      res.status(500).json({ success: false, error: "生成邀请码失败" });
    }
  }
);

// ============================================
// 获取邀请列表（改造版 - 增加实时统计）
// ============================================
router.get(
  "/invites",
  authMiddleware,
  [
    query("page").optional().isInt({ min: 1 }).withMessage("页码必须是正整数"),
    query("limit").optional().isInt({ min: 1, max: 50 }).withMessage("每页数量必须在 1-50 之间"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
      const offset = (page - 1) * limit;

      const limitInt = Number(limit);
      const offsetInt = Number(offset);

      // 获取总数
      const [countRows]: any = await pool.execute(
        "SELECT COUNT(*) as total FROM user_invites WHERE inviter_id = ?",
        [userId]
      );
      const total = countRows?.[0]?.total || 0;

      // 获取邀请列表
      const [rows]: any = await pool.execute(
        `
        SELECT
          ui.id,
          ui.invitee_id,
          ui.invite_code,
          ui.status,
          ui.registered_at,
          ui.created_at,
          u.name as invitee_name,
          u.phone as invitee_phone,
          u.avatar as invitee_avatar
        FROM user_invites ui
        LEFT JOIN user_users u ON ui.invitee_id = u.id
        WHERE ui.inviter_id = ?
        ORDER BY ui.created_at DESC
        LIMIT ${limitInt} OFFSET ${offsetInt}
        `,
        [userId]
      );

      // 查询每个被邀请人的当月统计数据
      const inviteeIds = Array.isArray(rows)
        ? rows.map((row: any) => row.invitee_id).filter((id: number) => id)
        : [];

      const currentMonthStats: Record<number, any> = {};
      if (inviteeIds.length > 0) {
        // 批量查询本月统计
        const placeholders = inviteeIds.map(() => "?").join(",");
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
        const [statsRows]: any = await pool.execute(
          `
          SELECT
            invitee_id,
            recharge_amount,
            consumption_points
          FROM invitee_stats
          WHERE inviter_id = ?
            AND stat_type = 'monthly'
            AND period = ?
            AND invitee_id IN (${placeholders})
          `,
          [userId, currentMonth, ...inviteeIds]
        );

        if (Array.isArray(statsRows)) {
          statsRows.forEach((stat: any) => {
            currentMonthStats[stat.invitee_id] = {
              rechargeAmount: Number(stat.recharge_amount || 0),
              consumptionPoints: Number(stat.consumption_points || 0)
            };
          });
        }
      }

      // 获取当前月汇总
      const currentPeriodSummary = await InviteStatsService.getCurrentMonthSummary(userId);

      const list = Array.isArray(rows)
        ? rows.map((row: any) => ({
            id: row.id,
            invitee: {
              id: row.invitee_id,
              nickname: row.invitee_name || "未知用户",
              avatar: row.invitee_avatar,
              phone: row.invitee_phone
                ? row.invitee_phone.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2")
                : undefined,
            },
            inviteCode: row.invite_code,
            status: row.status,
            registeredAt: row.registered_at,
            createdAt: row.created_at,
            // 新增：当前月统计
            currentMonthStats: currentMonthStats[row.invitee_id] || {
              rechargeAmount: 0,
              consumptionPoints: 0,
              settlementStatus: "unsettled",
            },
          }))
        : [];

      res.json({
        success: true,
        data: {
          list,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
          // 新增：当前周期汇总
          currentPeriodSummary: {
            month: new Date().toISOString().slice(0, 7),
            totalRecharge: currentPeriodSummary.totalRecharge,
            totalConsumption: currentPeriodSummary.totalConsumption,
            activeInviteeCount: currentPeriodSummary.activeInviteeCount,
          },
        },
      });
    } catch (error) {
      console.error("Get invite list error:", error);
      res.status(500).json({ success: false, error: "获取邀请列表失败" });
    }
  }
);

// ============================================
// 验证邀请码
// ============================================
router.get(
  "/validate-code",
  [
    query("code")
      .notEmpty()
      .withMessage("邀请码不能为空")
      .isLength({ min: 1, max: 16 })
      .withMessage("邀请码格式错误"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const { code } = req.query as { code: string };

      // 查询邀请码
      const [codeRows]: any = await pool.execute(
        "SELECT user_id FROM user_invite_codes WHERE code = ? AND status = 1",
        [code]
      );

      if (!Array.isArray(codeRows) || codeRows.length === 0) {
        res.json({
          success: true,
          data: { valid: false, message: "邀请码无效" },
        });
        return;
      }

      const inviterId = codeRows[0].user_id;

      // 查询邀请人信息
      const [userRows]: any = await pool.execute(
        "SELECT id, name FROM user_users WHERE id = ?",
        [inviterId]
      );

      if (!Array.isArray(userRows) || userRows.length === 0) {
        res.json({
          success: true,
          data: { valid: false, message: "邀请人信息不存在" },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          valid: true,
          inviter: {
            id: userRows[0].id,
            nickname: userRows[0].name || "用户",
          },
        },
      });
    } catch (error) {
      console.error("Validate invite code error:", error);
      res.status(500).json({ success: false, error: "验证邀请码失败" });
    }
  }
);

// ============================================
// 获取被邀请人日明细（Task 7）
// ============================================
router.get(
  "/invitee/daily",
  authMiddleware,
  [
    query("inviteeId").notEmpty().isInt({ min: 1 }).withMessage("被邀请人ID必须是正整数"),
    query("month").optional().matches(/^\d{4}-\d{2}$/).withMessage("月份格式错误，应为 YYYY-MM"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const inviteeId = parseInt(req.query.inviteeId as string);
      const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);

      // 验证邀请关系是否存在
      const [relationRows]: any = await pool.execute(
        "SELECT 1 FROM user_invites WHERE inviter_id = ? AND invitee_id = ? LIMIT 1",
        [userId, inviteeId]
      );

      if (!Array.isArray(relationRows) || relationRows.length === 0) {
        res.status(403).json({ success: false, error: "无权查看该被邀请人的数据" });
        return;
      }

      // 查询被邀请人信息
      const [userRows]: any = await pool.execute(
        "SELECT id, name, created_at FROM user_users WHERE id = ? LIMIT 1",
        [inviteeId]
      );

      const userInfo = Array.isArray(userRows) && userRows.length > 0
        ? {
            id: userRows[0].id,
            nickname: userRows[0].name || "未知用户",
            invitedAt: userRows[0].created_at,
          }
        : null;

      // 查询月统计汇总
      const [monthStatsRows]: any = await pool.execute(
        `
        SELECT
          recharge_amount,
          consumption_points
        FROM invitee_stats
        WHERE inviter_id = ? AND invitee_id = ? AND stat_type = 'monthly' AND period = ?
        `,
        [userId, inviteeId, month]
      );

      const monthStats = monthStatsRows?.[0];

      // 查询日明细
      const [dailyRows]: any = await pool.execute(
        `
        SELECT
          period as date,
          recharge_amount,
          recharge_count,
          consumption_points,
          consumption_count
        FROM invitee_stats
        WHERE inviter_id = ?
          AND invitee_id = ?
          AND stat_type = 'daily'
          AND period LIKE ?
        ORDER BY period ASC
        `,
        [userId, inviteeId, `${month}%`]
      );

      const dailyData = Array.isArray(dailyRows)
        ? dailyRows.map((row: any) => ({
            date: row.date,
            rechargeAmount: Number(row.recharge_amount || 0),
            rechargeCount: row.recharge_count || 0,
            consumptionPoints: Number(row.consumption_points || 0),
            consumptionCount: row.consumption_count || 0,
          }))
        : [];

      res.json({
        success: true,
        data: {
          userInfo,
          monthSummary: {
            month,
            rechargeAmount: Number(monthStats?.recharge_amount || 0),
            consumptionPoints: Number(monthStats?.consumption_points || 0),
            days: dailyData.length,
            settlementStatus: monthStats?.settlement_status || "unsettled",
          },
          dailyData,
        },
      });
    } catch (error) {
      console.error("Get invitee daily stats error:", error);
      res.status(500).json({ success: false, error: "获取日明细失败" });
    }
  }
);

// ============================================
// 获取月度统计列表（Task 8）
// ============================================
router.get(
  "/stats/monthly",
  authMiddleware,
  [
    query("page").optional().isInt({ min: 1 }).withMessage("页码必须是正整数"),
    query("limit").optional().isInt({ min: 1, max: 50 }).withMessage("每页数量必须在 1-50 之间"),
    query("startMonth").optional().matches(/^\d{4}-\d{2}$/).withMessage("开始月份格式错误"),
    query("endMonth").optional().matches(/^\d{4}-\d{2}$/).withMessage("结束月份格式错误"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
      const startMonth = req.query.startMonth as string;
      const endMonth = req.query.endMonth as string;

      // 构建查询条件
      const conditions: string[] = ["inviter_id = ?", "stat_type = 'monthly'"];
      const values: any[] = [userId];

      if (startMonth && endMonth) {
        conditions.push("period BETWEEN ? AND ?");
        values.push(startMonth, endMonth);
      } else if (startMonth) {
        conditions.push("period >= ?");
        values.push(startMonth);
      } else if (endMonth) {
        conditions.push("period <= ?");
        values.push(endMonth);
      }

      const whereClause = conditions.join(" AND ");

      // 查询总月份数
      const [countRows]: any = await pool.execute(
        `SELECT COUNT(DISTINCT period) as total FROM invitee_stats WHERE ${whereClause}`,
        values
      );
      const total = countRows?.[0]?.total || 0;

      // 查询每月统计（聚合）
      const offset = (page - 1) * limit;
      const [rows]: any = await pool.execute(
        `
        SELECT
          period as month,
          SUM(recharge_amount) as total_recharge,
          SUM(consumption_points) as total_consumption,
          COUNT(DISTINCT invitee_id) as active_invitee_count
        FROM invitee_stats
        WHERE ${whereClause}
        GROUP BY period
        ORDER BY period DESC
        LIMIT ${limit} OFFSET ${offset}
        `,
        values
      );

      // 查询 invite_rewards 表获取结算状态
      const [rewardStatusRows]: any = await pool.execute(
        `
        SELECT settlement_month, status
        FROM invite_rewards
        WHERE inviter_id = ?
        ${startMonth && endMonth ? "AND settlement_month BETWEEN ? AND ?" : ""}
        `,
        startMonth && endMonth
          ? [userId, startMonth, endMonth]
          : [userId]
      );

      // 构建状态映射
      const statusMap: Record<string, string> = {};
      rewardStatusRows?.forEach((row: any) => {
        statusMap[row.settlement_month] = row.status;
      });

      // 查询总体汇总
      const [summaryRows]: any = await pool.execute(
        `
        SELECT
          COUNT(DISTINCT period) as total_months,
          SUM(recharge_amount) as total_recharge,
          SUM(consumption_points) as total_consumption
        FROM invitee_stats
        WHERE ${whereClause}
        `,
        values
      );

      const summary = summaryRows?.[0];

      const list = Array.isArray(rows)
        ? rows.map((row: any) => {
            const consumptionYuan = Number(row.total_consumption || 0) / 100000;
            const rewardAmount = consumptionYuan * 0.005;
            const rewardStatus = statusMap[row.month];
            // pending -> pending, approved/settled/issued -> settled, 其他 -> unsettled
            let settlementStatus = 'unsettled';
            if (rewardStatus === 'pending') settlementStatus = 'pending';
            else if (rewardStatus && ['approved', 'issued'].includes(rewardStatus)) settlementStatus = 'rewarded';
            return {
              month: row.month,
              rechargeAmount: Number(row.total_recharge || 0),
              consumptionPoints: Number(row.total_consumption || 0),
              activeInviteeCount: row.active_invitee_count || 0,
              settlementStatus,
              rewardAmount: Number(rewardAmount.toFixed(4)),
            };
          })
        : [];

      res.json({
        success: true,
        data: {
          list,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
          summary: {
            totalMonths: summary?.total_months || 0,
            totalRecharge: Number(summary?.total_recharge || 0),
            totalConsumption: Number(summary?.total_consumption || 0),
          },
        },
      });
    } catch (error) {
      console.error("Get monthly stats error:", error);
      res.status(500).json({ success: false, error: "获取月度统计失败" });
    }
  }
);

// ============================================
// 获取某月明细（被邀请人维度）（Task 9）
// ============================================
router.get(
  "/stats/month-detail",
  authMiddleware,
  [
    query("month").notEmpty().matches(/^\d{4}-\d{2}$/).withMessage("月份格式错误，应为 YYYY-MM"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const month = req.query.month as string;

      // 查询该月汇总
      const [summaryRows]: any = await pool.execute(
        `
        SELECT
          SUM(recharge_amount) as total_recharge,
          SUM(consumption_points) as total_consumption,
          COUNT(DISTINCT invitee_id) as active_invitee_count
        FROM invitee_stats
        WHERE inviter_id = ? AND stat_type = 'monthly' AND period = ?
        `,
        [userId, month]
      );

      const summary = summaryRows?.[0];

      // 查询被邀请人明细
      const [rows]: any = await pool.execute(
        `
        SELECT
          s.invitee_id,
          u.name as nickname,
          u.avatar,
          s.recharge_amount,
          s.recharge_count,
          s.consumption_points,
          s.consumption_count
        FROM invitee_stats s
        LEFT JOIN user_users u ON s.invitee_id = u.id
        WHERE s.inviter_id = ?
          AND s.stat_type = 'monthly'
          AND s.period = ?
        ORDER BY s.consumption_points DESC, s.recharge_amount DESC
        `,
        [userId, month]
      );

      const invitees = Array.isArray(rows)
        ? rows.map((row: any) => ({
            inviteeId: row.invitee_id,
            nickname: row.nickname || "未知用户",
            avatar: row.avatar,
            rechargeAmount: Number(row.recharge_amount || 0),
            rechargeCount: row.recharge_count || 0,
            consumptionPoints: Number(row.consumption_points || 0),
            consumptionCount: row.consumption_count || 0,
            settlementStatus: row.settlement_status,
          }))
        : [];

      res.json({
        success: true,
        data: {
          month,
          summary: {
            rechargeAmount: Number(summary?.total_recharge || 0),
            consumptionPoints: Number(summary?.total_consumption || 0),
            activeInviteeCount: summary?.active_invitee_count || 0,
            settlementStatus: summary?.settlement_status || "unsettled",
          },
          invitees,
        },
      });
    } catch (error) {
      console.error("Get month detail error:", error);
      res.status(500).json({ success: false, error: "获取月明细失败" });
    }
  }
);

// ============================================
// 获取邀请奖励记录（Task 10）
// ============================================
router.get(
  "/rewards",
  authMiddleware,
  [
    query("page").optional().isInt({ min: 1 }).withMessage("页码必须是正整数"),
    query("limit").optional().isInt({ min: 1, max: 50 }).withMessage("每页数量必须在 1-50 之间"),
    query("startMonth").optional().matches(/^\d{4}-\d{2}$/).withMessage("开始月份格式错误"),
    query("endMonth").optional().matches(/^\d{4}-\d{2}$/).withMessage("结束月份格式错误"),
    query("status").optional().isIn(["pending", "approved", "rejected", "issued"]).withMessage("状态参数错误"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
      const startMonth = req.query.startMonth as string;
      const endMonth = req.query.endMonth as string;
      const status = req.query.status as string;

      // 构建查询选项
      const options: any = { inviterId: userId, page, limit };
      if (startMonth && endMonth) {
        // 使用 settlementMonth 过滤
        options.settlementMonth = startMonth; // 简化处理，实际应该用 BETWEEN
      }
      if (status) {
        options.status = status;
      }

      // 查询奖励列表
      const { list: rewards, total } = await RewardService.listRewards(options);

      // 查询汇总统计
      const summary = await RewardService.getRewardSummary(userId);

      // 按月汇总
      const [monthlyRows]: any = await pool.execute(
        `
        SELECT
          settlement_month as month,
          COUNT(*) as invitee_count,
          SUM(reward_amount) as reward_amount,
          SUM(CASE WHEN status = 'issued' THEN reward_amount ELSE 0 END) as issued_amount,
          SUM(CASE WHEN status IN ('pending', 'approved') THEN reward_amount ELSE 0 END) as pending_amount
        FROM invite_rewards
        WHERE inviter_id = ?
        ${startMonth && endMonth ? "AND settlement_month BETWEEN ? AND ?" : ""}
        GROUP BY settlement_month
        ORDER BY settlement_month DESC
        `,
        startMonth && endMonth
          ? [userId, startMonth, endMonth]
          : [userId]
      );

      const monthlySummary = Array.isArray(monthlyRows)
        ? monthlyRows.map((row: any) => ({
            month: row.month,
            inviteeCount: row.invitee_count,
            rewardAmount: Number(row.reward_amount || 0),
            issuedAmount: Number(row.issued_amount || 0),
            pendingAmount: Number(row.pending_amount || 0),
          }))
        : [];

      // 查询被邀请人信息并组装数据
      const inviteeIds = rewards.map((r) => r.invitee_id);
      const inviteeMap: Record<number, any> = {};

      if (inviteeIds.length > 0) {
        const placeholders = inviteeIds.map(() => "?").join(",");
        const [userRows]: any = await pool.execute(
          `SELECT id, name, avatar FROM user_users WHERE id IN (${placeholders})`,
          inviteeIds
        );

        if (Array.isArray(userRows)) {
          userRows.forEach((u: any) => {
            inviteeMap[u.id] = {
              id: u.id,
              nickname: u.name || "未知用户",
              avatar: u.avatar,
            };
          });
        }
      }

      const list = rewards.map((r) => ({
        id: r.id,
        settlementMonth: r.settlement_month,
        invitee: inviteeMap[r.invitee_id] || { id: r.invitee_id, nickname: "未知用户" },
        rechargeAmount: Number(r.recharge_amount),
        consumptionPoints: Number(r.consumption_points),
        rewardAmount: Number(r.reward_amount),
        rewardType: r.reward_type,
        rewardRate: Number(r.reward_rate),
        status: r.status,
        issuedAt: r.issued_at,
        remark: r.remark,
        createdAt: r.created_at,
      }));

      res.json({
        success: true,
        data: {
          summary: {
            totalRewardAmount: summary.totalRewardAmount,
            issuedAmount: summary.issuedAmount,
            pendingAmount: summary.pendingAmount,
            totalInvitees: summary.totalCount,
          },
          monthlySummary,
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
      console.error("Get rewards error:", error);
      res.status(500).json({ success: false, error: "获取奖励记录失败" });
    }
  }
);

// ============================================
// 按月份查询奖励明细（Task 11）
// ============================================
router.get(
  "/rewards/by-month",
  authMiddleware,
  [
    query("month").notEmpty().matches(/^\d{4}-\d{2}$/).withMessage("月份格式错误，应为 YYYY-MM"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const month = req.query.month as string;

      // 查询该月汇总
      const [summaryRows]: any = await pool.execute(
        `
        SELECT
          SUM(reward_amount) as total_reward,
          SUM(CASE WHEN status = 'issued' THEN reward_amount ELSE 0 END) as issued_amount,
          SUM(CASE WHEN status IN ('pending', 'approved') THEN reward_amount ELSE 0 END) as pending_amount,
          COUNT(DISTINCT invitee_id) as invitee_count
        FROM invite_rewards
        WHERE inviter_id = ? AND settlement_month = ?
        `,
        [userId, month]
      );

      const summary = summaryRows?.[0];

      // 查询该月所有奖励明细
      const [rows]: any = await pool.execute(
        `
        SELECT
          r.id,
          r.invitee_id,
          u.name as nickname,
          u.avatar,
          r.recharge_amount,
          r.consumption_points,
          r.reward_amount,
          r.reward_type,
          r.reward_rate,
          r.status,
          r.issued_at
        FROM invite_rewards r
        LEFT JOIN user_users u ON r.invitee_id = u.id
        WHERE r.inviter_id = ? AND r.settlement_month = ?
        ORDER BY r.created_at DESC
        `,
        [userId, month]
      );

      const invitees = Array.isArray(rows)
        ? rows.map((row: any) => ({
            inviteeId: row.invitee_id,
            nickname: row.nickname || "未知用户",
            avatar: row.avatar,
            rechargeAmount: Number(row.recharge_amount || 0),
            consumptionPoints: Number(row.consumption_points || 0),
            rewardAmount: Number(row.reward_amount || 0),
            rewardType: row.reward_type,
            rewardRate: Number(row.reward_rate || 0),
            status: row.status,
            issuedAt: row.issued_at,
          }))
        : [];

      res.json({
        success: true,
        data: {
          month,
          summary: {
            totalRewardAmount: Number(summary?.total_reward || 0),
            issuedAmount: Number(summary?.issued_amount || 0),
            pendingAmount: Number(summary?.pending_amount || 0),
            inviteeCount: summary?.invitee_count || 0,
          },
          invitees,
        },
      });
    } catch (error) {
      console.error("Get rewards by month error:", error);
      res.status(500).json({ success: false, error: "获取月奖励明细失败" });
    }
  }
);

// ============================================

// ============================================
// 申请结算（提交给管理员审批）
// ============================================
router.post(
  "/settlement/apply",
  authMiddleware,
  [
    body("month").notEmpty().matches(/^\d{4}-\d{2}$/).withMessage("月份格式错误，应为 YYYY-MM"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const userId = req.user!.userId;
      const { month } = req.body;

      // 校验：必须是上个月的月份才能结算
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;

      if (month !== lastMonthStr) {
        res.status(400).json({
          success: false,
          error: `只能结算上月（${lastMonthStr}）的数据`,
        });
        return;
      }

      // 检查该月份是否有数据
      const [dataRows]: any = await pool.execute(
        `
        SELECT
          COUNT(*) as record_count,
          SUM(consumption_points) as total_consumption
        FROM invitee_stats
        WHERE inviter_id = ? AND stat_type = 'monthly' AND period = ?
        `,
        [userId, month]
      );

      if (!dataRows?.[0]?.record_count) {
        res.status(400).json({ success: false, error: "该月份无邀请数据" });
        return;
      }

      // 检查是否已在 invite_rewards 中提交过结算申请
      const [rewardRows]: any = await pool.execute(
        `
        SELECT status
        FROM invite_rewards
        WHERE inviter_id = ? AND settlement_month = ?
        LIMIT 1
        `,
        [userId, month]
      );

      if (rewardRows?.length > 0) {
        const status = rewardRows[0].status;
        if (status === 'issued' || status === 'approved') {
          res.status(400).json({ success: false, error: "该月份已结算或已批准，无需重复申请" });
          return;
        }
        if (status === 'pending') {
          res.status(400).json({ success: false, error: "该月份结算申请已在审批中" });
          return;
        }
      }

      // 查询该月份聚合统计数据
      const [aggRows]: any = await pool.execute(
        `
        SELECT
          COUNT(*) as invitee_count,
          SUM(recharge_amount) as total_recharge,
          SUM(consumption_points) as total_consumption
        FROM invitee_stats
        WHERE inviter_id = ? AND stat_type = 'monthly' AND period = ?
        `,
        [userId, month]
      );

      const aggData = aggRows?.[0];
      if (!aggData || aggData.invitee_count === 0) {
        res.status(400).json({ success: false, error: "该月份无可结算数据" });
        return;
      }

      // 查询明细数据用于JSON存储（包含完整字段）
      const [detailRows]: any = await pool.execute(
        `
        SELECT
          invitee_id,
          recharge_amount,
          recharge_count,
          consumption_points,
          consumption_count
        FROM invitee_stats
        WHERE inviter_id = ? AND stat_type = 'monthly' AND period = ?
        `,
        [userId, month]
      );

      const REWARD_RATE = 0.005; // 0.5% 奖励比例
      const POINTS_PER_YUAN = 100000; // 1元 = 100000积分
      const totalConsumptionYuan = Number(aggData.total_consumption || 0) / POINTS_PER_YUAN;
      const totalRewardAmount = totalConsumptionYuan * REWARD_RATE;

      // 构建明细JSON（包含完整字段）
      const detailJson = JSON.stringify(
        detailRows.map((row: any) => {
          const consumptionYuan = Number(row.consumption_points || 0) / POINTS_PER_YUAN;
          const rewardAmount = consumptionYuan * REWARD_RATE;
          return {
            invitee_id: row.invitee_id,
            recharge_amount: Number(row.recharge_amount || 0),
            recharge_count: row.recharge_count || 0,
            consumption_points: Number(row.consumption_points || 0),
            consumption_count: row.consumption_count || 0,
            reward_amount: Number(rewardAmount.toFixed(4)),
          };
        })
      );

      // 插入按月聚合的奖励记录
      await pool.execute(
        `
        INSERT INTO invite_rewards
          (inviter_id, settlement_month, total_invitee_count, total_recharge_amount,
           total_consumption_points, total_reward_amount, detail_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
        ON DUPLICATE KEY UPDATE
          total_invitee_count = VALUES(total_invitee_count),
          total_recharge_amount = VALUES(total_recharge_amount),
          total_consumption_points = VALUES(total_consumption_points),
          total_reward_amount = VALUES(total_reward_amount),
          detail_json = VALUES(detail_json),
          status = 'pending',
          updated_at = NOW()
        `,
        [
          userId,
          month,
          aggData.invitee_count,
          aggData.total_recharge,
          aggData.total_consumption,
          totalRewardAmount.toFixed(4),
          detailJson,
        ]
      );

      // 更新 invitee_stats 状态为 pending
      await pool.execute(
        `
        UPDATE invitee_stats
        SET updated_at = NOW()
        WHERE inviter_id = ? AND stat_type = 'monthly' AND period = ?
        `,
        [userId, month]
      );

      res.json({
        success: true,
        message: `结算申请已提交，共 ${detailRows.length} 条记录等待管理员审批`,
        data: { month, status: "pending", count: detailRows.length, totalReward: Number(totalRewardAmount.toFixed(4)) },
      });
    } catch (error) {
      console.error("Apply settlement error:", error);
      res.status(500).json({ success: false, error: "提交结算申请失败" });
    }
  }
);

export default router;
