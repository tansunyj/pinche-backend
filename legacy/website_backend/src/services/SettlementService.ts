/**
 * 邀请结算服务 - SettlementService
 *
 * 功能：月度结算定时任务核心逻辑
 *
 * 核心方法：
 *   - monthlySettlement() - 执行月度结算
 *     * 防重检查：查询 settlement_logs 表
 *     * 获取上月所有 unsettled 的 monthly 记录
 *     * 标记 settled + 生成 invite_rewards 记录
 *   - generateRewardForInvitee() - 单条奖励生成
 *   - manualTriggerSettlement() - 手动触发结算
 *
 * 定时任务：每月1日 00:05 执行
 */

import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool, { transaction } from "../db/mysql";

export type SettlementStatus = "running" | "success" | "failed";
export type RewardStatus = "pending" | "approved" | "rejected" | "issued";
export type RewardType = "recharge_bonus" | "consumption_bonus" | "fixed";

export interface SettlementLog {
  id: number;
  settlement_month: string;
  started_at: Date;
  completed_at: Date | null;
  inviter_count: number;
  reward_count: number;
  status: SettlementStatus;
  error_msg: string | null;
}

export interface InviteeMonthlyStats {
  id: number;
  inviter_id: number;
  invitee_id: number;
  period: string;
  recharge_amount: number;
  recharge_count: number;
  consumption_points: number;
  consumption_count: number;
  settlement_status: "unsettled" | "settled" | "rewarded";
}

export interface RewardConfig {
  // 消费返利比例（如 0.1 表示 10%）
  consumptionRate: number;
  // 充值返利比例（如 0.05 表示 5%）
  rechargeRate: number;
  // 最低奖励金额（元），低于此金额不生成奖励
  minRewardAmount: number;
}

// 默认奖励配置
const DEFAULT_REWARD_CONFIG: RewardConfig = {
  consumptionRate: 0.005, // 消费返0.5%（即0.5%消费额度）
  rechargeRate: 0, // 充值不返利（可根据需求调整）
  minRewardAmount: 0.01, // 最低1分钱
};

/**
 * 获取上月月份字符串（YYYY-MM）
 */
function getLastMonthStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11

  if (month === 0) {
    // 1月，上月是去年12月
    return `${year - 1}-12`;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * 计算奖励金额
 */
function calculateReward(
  stats: InviteeMonthlyStats,
  config: RewardConfig
): { amount: number; type: RewardType; rate: number } | null {
  // 优先计算消费返利
  if (config.consumptionRate > 0 && stats.consumption_points > 0) {
    // consumption_points 是积分，需要转换为元再计算
    // 假设 1元 = 100000积分（与充值比例一致）
    const pointsPerYuan = Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;
    const consumptionYuan = stats.consumption_points / pointsPerYuan;
    const rewardAmount = consumptionYuan * config.consumptionRate;

    if (rewardAmount >= config.minRewardAmount) {
      return {
        amount: Math.floor(rewardAmount * 100) / 100, // 保留两位小数
        type: "consumption_bonus",
        rate: config.consumptionRate,
      };
    }
  }

  // 充值返利
  if (config.rechargeRate > 0 && stats.recharge_amount > 0) {
    const rewardAmount = stats.recharge_amount * config.rechargeRate;

    if (rewardAmount >= config.minRewardAmount) {
      return {
        amount: Math.floor(rewardAmount * 100) / 100,
        type: "recharge_bonus",
        rate: config.rechargeRate,
      };
    }
  }

  return null;
}

class SettlementService {
  private rewardConfig: RewardConfig;

  constructor(config: RewardConfig = DEFAULT_REWARD_CONFIG) {
    this.rewardConfig = config;
  }

  /**
   * 设置奖励配置
   */
  setRewardConfig(config: Partial<RewardConfig>): void {
    this.rewardConfig = { ...this.rewardConfig, ...config };
  }

  /**
   * 执行月度结算（简化版 - 不再使用 settlement_logs）
   *
   * @param targetMonth - 目标月份（YYYY-MM）
   * @returns 结算结果
   */
  async monthlySettlement(targetMonth?: string): Promise<{
    success: boolean;
    month: string;
    processedCount: number;
    rewardCount: number;
    message: string;
  }> {
    const settlementMonth = targetMonth || getLastMonthStr();

    console.log(`[Settlement] 开始月度结算: ${settlementMonth}`);

    // 1. 防重检查 - 查 invite_rewards 表
    const [existingRows]: any = await pool.execute(
      `SELECT COUNT(*) as count FROM invite_rewards WHERE settlement_month = ?`,
      [settlementMonth]
    );
    if (existingRows?.[0]?.count > 0) {
      console.log(`[Settlement] ${settlementMonth} 已结算，跳过`);
      return {
        success: true,
        month: settlementMonth,
        processedCount: 0,
        rewardCount: 0,
        message: "该月已结算",
      };
    }

    try {
      // 2. 获取上月所有未结算的 monthly 记录
      const monthlyRecords = await this.getUnsettledMonthlyStats(
        settlementMonth
      );
      console.log(
        `[Settlement] 查询到 ${monthlyRecords.length} 条待结算记录`
      );

      let processedCount = 0;
      let rewardCount = 0;

      // 3. 循环处理每条记录
      for (const record of monthlyRecords) {
        const result = await this.processSingleRecord(record);
        if (result.processed) {
          processedCount++;
          if (result.hasReward) {
            rewardCount++;
          }
        }
      }

      console.log(
        `[Settlement] ${settlementMonth} 结算成功: 处理 ${processedCount} 条记录, 生成 ${rewardCount} 条奖励`
      );

      return {
        success: true,
        month: settlementMonth,
        processedCount,
        rewardCount,
        message: `结算成功: 处理 ${processedCount} 条记录, 生成 ${rewardCount} 条奖励`,
      };
    } catch (error: any) {
      console.error(`[Settlement] ${settlementMonth} 结算失败:`, error);
      throw error;
    }
  }

  /**
   * 处理单条统计记录
   * 注意：现在按月聚合，单条记录只更新状态，不插入 invite_rewards
   * invite_rewards 由用户手动申请结算时插入（referral.ts /settlement/apply）
   */
  private async processSingleRecord(
    record: InviteeMonthlyStats
  ): Promise<{ processed: boolean; hasReward: boolean }> {
    try {
      await transaction(async (conn: PoolConnection) => {
        // 标记为已结算（自动结算标记，实际奖励需要用户手动申请）
        await conn.execute(
          `UPDATE invitee_stats
           SET settlement_status = 'settled'
           WHERE id = ? AND settlement_status = 'unsettled'`,
          [record.id]
        );
      });

      return { processed: true, hasReward: false };
    } catch (err) {
      console.error(
        `[Settlement] 处理记录失败: id=${record.id}`,
        err
      );
      return { processed: false, hasReward: false };
    }
  }

  /**
   * 获取未结算的月度统计记录
   */
  private async getUnsettledMonthlyStats(
    period: string
  ): Promise<InviteeMonthlyStats[]> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM invitee_stats
       WHERE stat_type = 'monthly'
         AND period = ?
         AND settlement_status = 'unsettled'`,
      [period]
    );
    return rows as InviteeMonthlyStats[];
  }

  /**
   * 手动触发结算（管理员用）
   *
   * @param month - 指定月份（YYYY-MM），不传则默认上月
   * @param force - 是否强制重新结算（已结算的月份）
   */
  async manualTriggerSettlement(
    month?: string,
    force: boolean = false
  ): Promise<{
    success: boolean;
    month: string;
    processedCount: number;
    rewardCount: number;
    message: string;
  }> {
    const targetMonth = month || getLastMonthStr();

    if (force) {
      // 强制重新结算：先删除已有奖励记录
      await pool.execute(
        `DELETE FROM invite_rewards WHERE settlement_month = ?`,
        [targetMonth]
      );
      console.log(`[Settlement] 强制重新结算: ${targetMonth}`);
    }

    return this.monthlySettlement(targetMonth);
  }

  /**
   * 查询结算状态
   */
  async getSettlementStatus(month: string): Promise<{
    month: string;
    isSettled: boolean;
    processedCount: number;
    rewardCount: number;
  }> {
    // 查 invite_rewards 表判断状态
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
        COUNT(DISTINCT inviter_id) as inviter_count,
        COUNT(*) as reward_count
       FROM invite_rewards WHERE settlement_month = ?`,
      [month]
    );

    const result = rows[0] as any;
    const isSettled = (result?.reward_count || 0) > 0;

    if (isSettled) {
      return {
        month,
        isSettled: true,
        processedCount: result?.inviter_count || 0,
        rewardCount: result?.reward_count || 0,
      };
    }

    // 查询待结算记录数
    const [pendingRows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM invitee_stats
       WHERE stat_type = 'monthly' AND period = ? AND settlement_status = 'unsettled'`,
      [month]
    );

    return {
      month,
      isSettled: false,
      processedCount: 0,
      rewardCount: 0,
    };
  }
}

export default new SettlementService();
