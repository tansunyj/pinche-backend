/**
 * 邀请奖励服务 - RewardService
 *
 * 功能：奖励审批和发放核心服务
 *
 * 核心方法：
 *   - approveReward() - 审批通过
 *   - rejectReward() - 审批拒绝
 *   - issueReward() - 单条发放
 *   - batchIssueRewards() - 批量发放
 *   - issueToBalance() - 发放到用户账户余额
 *
 * 状态流转：
 *   pending → approved → issued
 *        ↘ rejected
 */

import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool, { transaction } from "../db/mysql";

export type RewardStatus = "pending" | "approved" | "rejected" | "issued";
export type IssueMethod = "manual" | "auto" | "batch";

export interface InviteReward {
  id: number;
  inviter_id: number;
  settlement_month: string;
  invitee_id: number;
  recharge_amount: number;
  consumption_points: number;
  reward_amount: number;
  reward_type: "recharge_bonus" | "consumption_bonus" | "fixed";
  reward_rate: number;
  status: RewardStatus;
  reviewed_by: number | null;
  reviewed_at: Date | null;
  review_remark: string | null;
  issued_at: Date | null;
  issued_by: number | null;
  issued_transaction_id: number | null;
  issue_method: IssueMethod;
  remark: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BatchIssueResult {
  totalProcessed: number;
  successCount: number;
  failCount: number;
  failDetails: Array<{ id: number; reason: string }>;
}

class RewardService {
  /**
   * 审批通过奖励申请
   *
   * @param rewardId - 奖励记录ID
   * @param adminId - 审批管理员ID
   * @param remark - 审批备注（可选）
   * @param immediateIssue - 是否立即发放（可选，默认false）
   * @returns 更新后的奖励记录
   */
  async approveReward(
    rewardId: number,
    adminId: number,
    remark?: string,
    immediateIssue: boolean = false
  ): Promise<InviteReward> {
    // 检查奖励是否存在且状态为pending
    const reward = await this.getRewardById(rewardId);
    if (!reward) {
      throw new Error("奖励记录不存在");
    }
    if (reward.status !== "pending") {
      throw new Error(`奖励状态不允许审批: ${reward.status}`);
    }

    // 更新状态为approved
    await pool.execute(
      `UPDATE invite_rewards
       SET status = 'approved',
           reviewed_by = ?,
           reviewed_at = NOW(),
           review_remark = ?
       WHERE id = ?`,
      [adminId, remark || null, rewardId]
    );

    console.log(
      `[RewardService] 奖励审批通过: id=${rewardId}, admin=${adminId}`
    );

    // 如果要求立即发放
    if (immediateIssue) {
      await this.issueReward(rewardId, adminId, "manual");
    }

    return this.getRewardById(rewardId) as Promise<InviteReward>;
  }

  /**
   * 审批拒绝奖励申请
   *
   * @param rewardId - 奖励记录ID
   * @param adminId - 审批管理员ID
   * @param reason - 拒绝原因（必填）
   * @returns 更新后的奖励记录
   */
  async rejectReward(
    rewardId: number,
    adminId: number,
    reason: string
  ): Promise<InviteReward> {
    if (!reason || reason.trim().length === 0) {
      throw new Error("拒绝原因不能为空");
    }

    // 检查奖励是否存在且状态为pending
    const reward = await this.getRewardById(rewardId);
    if (!reward) {
      throw new Error("奖励记录不存在");
    }
    if (reward.status !== "pending") {
      throw new Error(`奖励状态不允许拒绝: ${reward.status}`);
    }

    // 更新状态为rejected
    await pool.execute(
      `UPDATE invite_rewards
       SET status = 'rejected',
           reviewed_by = ?,
           reviewed_at = NOW(),
           review_remark = ?
       WHERE id = ?`,
      [adminId, reason.trim(), rewardId]
    );

    console.log(
      `[RewardService] 奖励审批拒绝: id=${rewardId}, admin=${adminId}, reason=${reason}`
    );

    return this.getRewardById(rewardId) as Promise<InviteReward>;
  }

  /**
   * 发放单条奖励
   *
   * @param rewardId - 奖励记录ID
   * @param operatorId - 操作人ID
   * @param issueMethod - 发放方式
   * @returns 发放后的奖励记录
   */
  async issueReward(
    rewardId: number,
    operatorId: number,
    issueMethod: IssueMethod = "manual"
  ): Promise<InviteReward> {
    // 检查奖励是否存在且状态为approved
    const reward = await this.getRewardById(rewardId);
    if (!reward) {
      throw new Error("奖励记录不存在");
    }
    if (reward.status !== "approved") {
      throw new Error(`奖励状态不允许发放: ${reward.status}`);
    }

    await transaction(async (conn: PoolConnection) => {
      // 1. 发放到用户账户余额
      const transactionId = await this.issueToBalance(
        conn,
        reward.inviter_id,
        reward.reward_amount,
        reward.id,
        reward.settlement_month
      );

      // 2. 更新奖励记录状态
      await conn.execute(
        `UPDATE invite_rewards
         SET status = 'issued',
             issued_at = NOW(),
             issued_by = ?,
             issued_transaction_id = ?,
             issue_method = ?
         WHERE id = ?`,
        [operatorId, transactionId, issueMethod, rewardId]
      );

      // 3. 更新 inviter_stats 结算状态为 rewarded
      await conn.execute(
        `UPDATE invitee_stats
         SET settlement_status = 'rewarded'
         WHERE inviter_id = ?
           AND invitee_id = ?
           AND stat_type = 'monthly'
           AND period = ?`,
        [reward.inviter_id, reward.invitee_id, reward.settlement_month]
      );
    });

    console.log(
      `[RewardService] 奖励发放成功: id=${rewardId}, amount=${reward.reward_amount}, inviter=${reward.inviter_id}`
    );

    return this.getRewardById(rewardId) as Promise<InviteReward>;
  }

  /**
   * 批量发放奖励
   *
   * @param options - 批量发放选项
   * @param operatorId - 操作人ID
   * @returns 批量发放结果
   */
  async batchIssueRewards(
    options: {
      ids?: number[]; // 指定ID列表
      settlementMonth?: string; // 指定结算月份
    },
    operatorId: number
  ): Promise<BatchIssueResult> {
    if (!options.ids && !options.settlementMonth) {
      throw new Error("必须指定ids或settlementMonth参数");
    }

    // 查询待发放的奖励记录
    let rewards: InviteReward[] = [];

    if (options.ids && options.ids.length > 0) {
      // 按ID列表查询
      const placeholders = options.ids.map(() => "?").join(",");
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT * FROM invite_rewards
         WHERE id IN (${placeholders})
           AND status = 'approved'`,
        options.ids
      );
      rewards = rows as InviteReward[];
    } else if (options.settlementMonth) {
      // 按月份查询
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT * FROM invite_rewards
         WHERE settlement_month = ?
           AND status = 'approved'`,
        [options.settlementMonth]
      );
      rewards = rows as InviteReward[];
    }

    console.log(
      `[RewardService] 批量发放: 查询到 ${rewards.length} 条待发放记录`
    );

    const result: BatchIssueResult = {
      totalProcessed: rewards.length,
      successCount: 0,
      failCount: 0,
      failDetails: [],
    };

    // 循环发放
    for (const reward of rewards) {
      try {
        await this.issueReward(reward.id, operatorId, "batch");
        result.successCount++;
      } catch (err: any) {
        result.failCount++;
        result.failDetails.push({
          id: reward.id,
          reason: err.message || "发放失败",
        });
      }
    }

    console.log(
      `[RewardService] 批量发放完成: 成功 ${result.successCount}, 失败 ${result.failCount}`
    );

    return result;
  }

  /**
   * 发放奖励到用户账户余额
   *
   * @param conn - 数据库连接（事务中）
   * @param userId - 用户ID（邀请人）
   * @param amount - 奖励金额（元）
   * @param rewardId - 奖励记录ID
   * @param settlementMonth - 结算月份
   * @returns 账户流水ID
   */
  private async issueToBalance(
    conn: PoolConnection,
    userId: number,
    amount: number,
    rewardId: number,
    settlementMonth: string
  ): Promise<number> {
    // 转换金额为积分
    const pointsPerYuan = Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;
    const points = Math.floor(amount * pointsPerYuan);

    if (points <= 0) {
      throw new Error("奖励金额无效");
    }

    // 1. 更新用户余额
    await conn.execute(
      `UPDATE user_users
       SET balance = balance + ?
       WHERE id = ?`,
      [points, userId]
    );

    // 2. 查询更新后的余额
    const [userRows] = await conn.execute<RowDataPacket[]>(
      `SELECT balance FROM user_users WHERE id = ? LIMIT 1`,
      [userId]
    );
    const balanceAfter = Number(userRows[0]?.balance || 0);

    // 3. 写账户流水
    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO billing_transactions
       (user_id, type, delta, balance_after, ref_type, ref_id, remark)
       VALUES (?, 'reward', ?, ?, 'invite_reward', ?, ?)`,
      [
        userId,
        points,
        balanceAfter,
        rewardId,
        `邀请奖励：${settlementMonth}月`,
      ]
    );

    console.log(
      `[RewardService] 余额发放: user=${userId}, amount=${amount}, points=${points}, transaction=${result.insertId}`
    );

    return result.insertId;
  }

  /**
   * 根据ID查询奖励记录
   */
  async getRewardById(id: number): Promise<InviteReward | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM invite_rewards WHERE id = ? LIMIT 1`,
      [id]
    );
    return (rows[0] as InviteReward) || null;
  }

  /**
   * 查询奖励列表（分页）
   *
   * @param options - 查询选项
   * @returns 奖励列表和总数
   */
  async listRewards(options: {
    inviterId?: number;
    status?: RewardStatus;
    settlementMonth?: string;
    page?: number;
    limit?: number;
  }): Promise<{ list: InviteReward[]; total: number }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: any[] = [];

    if (options.inviterId) {
      conditions.push("inviter_id = ?");
      values.push(options.inviterId);
    }
    if (options.status) {
      conditions.push("status = ?");
      values.push(options.status);
    }
    if (options.settlementMonth) {
      conditions.push("settlement_month = ?");
      values.push(options.settlementMonth);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 查询总数
    const [countRows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM invite_rewards ${whereClause}`,
      values
    );
    const total = Number(countRows[0]?.total || 0);

    // 查询列表
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM invite_rewards ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      values
    );

    return { list: rows as InviteReward[], total };
  }

  /**
   * 获取奖励汇总统计
   *
   * @param inviterId - 邀请人ID（可选，不传则查全部）
   * @returns 汇总统计
   */
  async getRewardSummary(inviterId?: number): Promise<{
    totalRewardAmount: number;
    issuedAmount: number;
    pendingAmount: number;
    totalCount: number;
  }> {
    const conditions: string[] = [];
    const values: any[] = [];

    if (inviterId) {
      conditions.push("inviter_id = ?");
      values.push(inviterId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
        SUM(reward_amount) as total_amount,
        SUM(CASE WHEN status = 'issued' THEN reward_amount ELSE 0 END) as issued_amount,
        SUM(CASE WHEN status IN ('pending', 'approved') THEN reward_amount ELSE 0 END) as pending_amount,
        COUNT(*) as total_count
      FROM invite_rewards ${whereClause}`,
      values
    );

    const result = rows[0];
    return {
      totalRewardAmount: Number(result?.total_amount || 0),
      issuedAmount: Number(result?.issued_amount || 0),
      pendingAmount: Number(result?.pending_amount || 0),
      totalCount: Number(result?.total_count || 0),
    };
  }
}

export default new RewardService();
