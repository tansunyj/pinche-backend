/**
 * 邀请系统管理端路由
 *
 * 功能：
 * - 奖励申请列表查询与审批
 * - 批量发放奖励
 * - 邀请人统计查询
 * - 月度结算手动触发
 */

import { Router, Request, Response } from "express";
import { body, validationResult, query, param } from "express-validator";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";
import pool from "../db/mysql";
import RewardService from "../services/RewardService";
import SettlementService from "../services/SettlementService";

const router = Router();

// ============================================
// 获取奖励申请列表（Task 12）
// ============================================
router.get(
  "/referral/reward-applications",
  authMiddleware,
  requireAdmin,
  [
    query("page").optional().isInt({ min: 1 }).withMessage("页码必须是正整数"),
    query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("每页数量必须在 1-100 之间"),
    query("status").optional().isIn(["pending", "approved", "rejected", "all"]).withMessage("状态参数错误"),
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
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const statusParam = (req.query.status as string) || "pending";
      const startMonth = req.query.startMonth as string;
      const endMonth = req.query.endMonth as string;

      const offset = (page - 1) * limit;

      // 构建查询条件
      const conditions: string[] = [];
      const values: any[] = [];

      if (statusParam && statusParam !== "all") {
        conditions.push("r.status = ?");
        values.push(statusParam);
      }

      if (startMonth && endMonth) {
        conditions.push("r.settlement_month BETWEEN ? AND ?");
        values.push(startMonth, endMonth);
      } else if (startMonth) {
        conditions.push("r.settlement_month >= ?");
        values.push(startMonth);
      } else if (endMonth) {
        conditions.push("r.settlement_month <= ?");
        values.push(endMonth);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // 查询汇总统计
      const [summaryRows]: any = await pool.execute(
        `
        SELECT
          SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) as total_pending,
          SUM(CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END) as total_approved,
          SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) as total_rejected,
          SUM(CASE WHEN r.status = 'pending' THEN r.reward_amount ELSE 0 END) as total_pending_amount
        FROM invite_rewards r
        ${whereClause}
        `,
        values
      );

      const summary = summaryRows?.[0];

      // 查询总数
      const [countRows]: any = await pool.execute(
        `SELECT COUNT(*) as total FROM invite_rewards r ${whereClause}`,
        values
      );
      const total = countRows?.[0]?.total || 0;

      // 查询列表
      const [rows]: any = await pool.execute(
        `
        SELECT
          r.id,
          r.inviter_id,
          i.name as inviter_name,
          r.invitee_id,
          u.name as invitee_name,
          r.settlement_month,
          r.recharge_amount,
          r.consumption_points,
          r.reward_amount,
          r.reward_type,
          r.reward_rate,
          r.status,
          r.created_at,
          r.reviewed_by,
          a.name as reviewer_name,
          r.reviewed_at,
          r.review_remark
        FROM invite_rewards r
        LEFT JOIN user_users i ON r.inviter_id = i.id
        LEFT JOIN user_users u ON r.invitee_id = u.id
        LEFT JOIN user_users a ON r.reviewed_by = a.id
        ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
        `,
        values
      );

      const list = Array.isArray(rows)
        ? rows.map((row: any) => ({
            id: row.id,
            inviter: {
              id: row.inviter_id,
              nickname: row.inviter_name || "未知用户",
            },
            invitee: {
              id: row.invitee_id,
              nickname: row.invitee_name || "未知用户",
            },
            settlementMonth: row.settlement_month,
            rechargeAmount: Number(row.recharge_amount || 0),
            consumptionPoints: Number(row.consumption_points || 0),
            rewardAmount: Number(row.reward_amount || 0),
            rewardType: row.reward_type,
            rewardRate: Number(row.reward_rate || 0),
            status: row.status,
            createdAt: row.created_at,
            reviewedBy: row.reviewed_by
              ? {
                  id: row.reviewed_by,
                  nickname: row.reviewer_name || "未知管理员",
                }
              : undefined,
            reviewedAt: row.reviewed_at,
            reviewRemark: row.review_remark,
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
      console.error("Get reward applications error:", error);
      res.status(500).json({ success: false, error: "获取奖励申请列表失败" });
    }
  }
);

// ============================================
// 审批通过奖励申请（Task 13）
// ============================================
router.post(
  "/referral/reward-applications/:id/approve",
  authMiddleware,
  requireAdmin,
  [
    param("id").isInt({ min: 1 }).withMessage("ID必须是正整数"),
    body("remark").optional().trim().isLength({ max: 255 }).withMessage("备注长度不能超过255个字符"),
    body("immediateIssue").optional().isBoolean().withMessage("immediateIssue必须是布尔值"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const rewardId = parseInt(req.params.id);
      const adminId = req.user!.userId;
      const { remark, immediateIssue } = req.body;

      const reward = await RewardService.approveReward(
        rewardId,
        adminId,
        remark,
        immediateIssue === true
      );

      // 查询管理员名称
      const [adminRows]: any = await pool.execute(
        "SELECT name FROM user_users WHERE id = ?",
        [adminId]
      );
      const adminName = adminRows?.[0]?.name || "管理员";

      res.json({
        success: true,
        data: {
          id: reward.id,
          status: reward.status,
          reviewedAt: reward.reviewed_at,
          reviewedBy: {
            id: adminId,
            nickname: adminName,
          },
          remark: reward.review_remark,
          issuedInfo:
            reward.status === "issued"
              ? {
                  issuedAt: reward.issued_at,
                  transactionId: reward.issued_transaction_id,
                }
              : undefined,
        },
      });
    } catch (error: any) {
      console.error("Approve reward error:", error);
      res.status(400).json({ success: false, error: error.message || "审批失败" });
    }
  }
);

// ============================================
// 审批拒绝奖励申请（Task 14）
// ============================================
router.post(
  "/referral/reward-applications/:id/reject",
  authMiddleware,
  requireAdmin,
  [
    param("id").isInt({ min: 1 }).withMessage("ID必须是正整数"),
    body("reason").trim().notEmpty().withMessage("拒绝原因不能为空").isLength({ max: 255 }).withMessage("原因长度不能超过255个字符"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const rewardId = parseInt(req.params.id);
      const adminId = req.user!.userId;
      const { reason } = req.body;

      const reward = await RewardService.rejectReward(rewardId, adminId, reason);

      // 查询管理员名称
      const [adminRows]: any = await pool.execute(
        "SELECT name FROM user_users WHERE id = ?",
        [adminId]
      );
      const adminName = adminRows?.[0]?.name || "管理员";

      res.json({
        success: true,
        data: {
          id: reward.id,
          status: reward.status,
          reviewedAt: reward.reviewed_at,
          reviewedBy: {
            id: adminId,
            nickname: adminName,
          },
          reviewRemark: reward.review_remark,
        },
      });
    } catch (error: any) {
      console.error("Reject reward error:", error);
      res.status(400).json({ success: false, error: error.message || "拒绝失败" });
    }
  }
);

// ============================================
// 批量发放奖励（Task 15）
// ============================================
router.post(
  "/referral/batch-issue",
  authMiddleware,
  requireAdmin,
  [
    body("ids").optional().isArray().withMessage("ids必须是数组"),
    body("ids.*").optional().isInt({ min: 1 }).withMessage("ID必须是正整数"),
    body("settlementMonth").optional().matches(/^\d{4}-\d{2}$/).withMessage("月份格式错误"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const adminId = req.user!.userId;
      const { ids, settlementMonth } = req.body;

      // 验证至少有一个参数
      if ((!ids || ids.length === 0) && !settlementMonth) {
        res.status(400).json({ success: false, error: "必须指定ids或settlementMonth参数" });
        return;
      }

      const result = await RewardService.batchIssueRewards(
        { ids, settlementMonth },
        adminId
      );

      res.json({
        success: true,
        data: {
          totalProcessed: result.totalProcessed,
          successCount: result.successCount,
          failCount: result.failCount,
          failDetails: result.failDetails,
        },
      });
    } catch (error: any) {
      console.error("Batch issue rewards error:", error);
      res.status(400).json({ success: false, error: error.message || "批量发放失败" });
    }
  }
);

// ============================================
// 获取邀请人统计（Task 16）
// ============================================
router.get(
  "/referral/inviter-stats",
  authMiddleware,
  requireAdmin,
  [
    query("inviterId").optional().isInt({ min: 1 }).withMessage("邀请人ID必须是正整数"),
    query("page").optional().isInt({ min: 1 }).withMessage("页码必须是正整数"),
    query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("每页数量必须在 1-100 之间"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const inviterId = req.query.inviterId ? parseInt(req.query.inviterId as string) : undefined;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      // 构建查询条件
      const conditions: string[] = [];
      const values: any[] = [];

      if (inviterId) {
        conditions.push("u.id = ?");
        values.push(inviterId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // 查询总数
      const [countRows]: any = await pool.execute(
        `
        SELECT COUNT(DISTINCT u.id) as total
        FROM user_users u
        INNER JOIN user_invites ui ON u.id = ui.inviter_id
        ${whereClause}
        `,
        values
      );
      const total = countRows?.[0]?.total || 0;

      // 查询邀请人统计
      const [rows]: any = await pool.execute(
        `
        SELECT
          u.id as inviter_id,
          u.name as nickname,
          COUNT(DISTINCT ui.invitee_id) as invitee_count,
          COALESCE(SUM(s.recharge_amount), 0) as total_recharge,
          COALESCE(SUM(s.consumption_points), 0) as total_consumption,
          COALESCE(SUM(CASE WHEN r.status = 'issued' THEN r.reward_amount ELSE 0 END), 0) as total_reward_issued,
          COALESCE(SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END), 0) as pending_applications
        FROM user_users u
        INNER JOIN user_invites ui ON u.id = ui.inviter_id
        LEFT JOIN invitee_stats s ON u.id = s.inviter_id AND s.stat_type = 'monthly'
        LEFT JOIN invite_rewards r ON u.id = r.inviter_id
        ${whereClause}
        GROUP BY u.id, u.name
        ORDER BY total_consumption DESC
        LIMIT ${limit} OFFSET ${offset}
        `,
        values
      );

      const list = Array.isArray(rows)
        ? rows.map((row: any) => ({
            inviterId: row.inviter_id,
            nickname: row.nickname || "未知用户",
            inviteeCount: row.invitee_count || 0,
            totalRecharge: Number(row.total_recharge || 0),
            totalConsumption: Number(row.total_consumption || 0),
            totalRewardIssued: Number(row.total_reward_issued || 0),
            pendingApplications: row.pending_applications || 0,
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
        },
      });
    } catch (error) {
      console.error("Get inviter stats error:", error);
      res.status(500).json({ success: false, error: "获取邀请人统计失败" });
    }
  }
);

// ============================================
// 手动触发月度结算（补充接口）
// ============================================
router.post(
  "/referral/settlement",
  authMiddleware,
  requireAdmin,
  [
    body("month").optional().matches(/^\d{4}-\d{2}$/).withMessage("月份格式错误，应为 YYYY-MM"),
    body("force").optional().isBoolean().withMessage("force必须是布尔值"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, error: errors.array()[0].msg });
      return;
    }

    try {
      const { month, force } = req.body;

      const result = await SettlementService.manualTriggerSettlement(month, force === true);

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error("Settlement error:", error);
      res.status(500).json({ success: false, error: error.message || "结算失败" });
    }
  }
);

// ============================================
// 查询结算状态（补充接口）
// ============================================
router.get(
  "/referral/settlement-status",
  authMiddleware,
  requireAdmin,
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
      const month = req.query.month as string;

      const status = await SettlementService.getSettlementStatus(month);

      res.json({
        success: true,
        data: status,
      });
    } catch (error: any) {
      console.error("Get settlement status error:", error);
      res.status(500).json({ success: false, error: error.message || "查询结算状态失败" });
    }
  }
);

export default router;
