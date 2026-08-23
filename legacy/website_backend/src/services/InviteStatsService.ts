/**
 * 邀请统计服务 - InviteStatsService
 *
 * 功能：实时累计被邀请人的充值和消费数据
 *
 * 核心方法：
 *   - updateInviteeStats(inviterId, inviteeId, data) 更新统计数据
 *     * 支持充值数据累计（recharge_amount, recharge_count）
 *     * 支持消费数据累计（consumption_points, consumption_count）
 *     * 同时更新 daily 和 monthly 记录
 *     * 使用 INSERT ... ON DUPLICATE KEY UPDATE 保证幂等
 *
 * 触发点：
 *   - billing_orders 充值成功后调用
 *   - proxy_logs 消费完成后调用
 */

import type { PoolConnection, ResultSetHeader } from "mysql2/promise";
import pool, { transaction } from "../db/mysql";

export interface UpdateStatsData {
  rechargeAmount?: number; // 充值金额（元）
  rechargeCount?: number; // 充值笔数，默认1
  consumptionPoints?: number; // 消费积分
  consumptionCount?: number; // 消费次数，默认1
}

export interface InviteeStats {
  id: number;
  inviter_id: number;
  invitee_id: number;
  stat_type: "daily" | "monthly";
  period: string;
  recharge_amount: number;
  recharge_count: number;
  consumption_points: number;
  consumption_count: number;
  settlement_status: "unsettled" | "settled" | "rewarded";
  created_at: Date;
  updated_at: Date;
}

/**
 * 获取当前日期字符串（YYYY-MM-DD）
 */
function getTodayStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 获取当前月份字符串（YYYY-MM）
 */
function getCurrentMonthStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

class InviteStatsService {
  /**
   * 更新被邀请人统计数据（实时累计）
   *
   * @param inviterId - 邀请人ID
   * @param inviteeId - 被邀请人ID
   * @param data - 更新数据
   */
  async updateInviteeStats(
    inviterId: number,
    inviteeId: number,
    data: UpdateStatsData
  ): Promise<void> {
    if (!inviterId || !inviteeId) {
      console.warn("[InviteStats] 邀请人或被邀请人ID为空，跳过统计");
      return;
    }

    const hasRecharge =
      data.rechargeAmount && data.rechargeAmount > 0;
    const hasConsumption =
      data.consumptionPoints && data.consumptionPoints > 0;

    if (!hasRecharge && !hasConsumption) {
      console.warn("[InviteStats] 没有充值或消费数据，跳过统计");
      return;
    }

    const today = getTodayStr();
    const currentMonth = getCurrentMonthStr();

    try {
      await transaction(async (conn: PoolConnection) => {
        // 1. 更新日统计（今天）
        await this.upsertDailyStats(conn, inviterId, inviteeId, today, data);

        // 2. 更新月统计（当前月份）
        await this.upsertMonthlyStats(
          conn,
          inviterId,
          inviteeId,
          currentMonth,
          data
        );
      });

      console.log(
        `[InviteStats] 统计更新成功: inviter=${inviterId}, invitee=${inviteeId}, ` +
          `recharge=${data.rechargeAmount || 0}, consumption=${data.consumptionPoints || 0}`
      );
    } catch (err) {
      console.error("[InviteStats] 统计更新失败:", err);
      throw err;
    }
  }

  /**
   * 插入或更新日统计记录
   */
  private async upsertDailyStats(
    conn: PoolConnection,
    inviterId: number,
    inviteeId: number,
    period: string,
    data: UpdateStatsData
  ): Promise<void> {
    const rechargeAmount = data.rechargeAmount || 0;
    const rechargeCount = data.rechargeCount || (data.rechargeAmount ? 1 : 0);
    const consumptionPoints = data.consumptionPoints || 0;
    const consumptionCount =
      data.consumptionCount || (data.consumptionPoints ? 1 : 0);

    const sql = `
      INSERT INTO invitee_stats
        (inviter_id, invitee_id, stat_type, period,
         recharge_amount, recharge_count, consumption_points, consumption_count, settlement_status)
      VALUES (?, ?, 'daily', ?, ?, ?, ?, ?, 'unsettled')
      ON DUPLICATE KEY UPDATE
        recharge_amount = recharge_amount + VALUES(recharge_amount),
        recharge_count = recharge_count + VALUES(recharge_count),
        consumption_points = consumption_points + VALUES(consumption_points),
        consumption_count = consumption_count + VALUES(consumption_count)
    `;

    await conn.execute<ResultSetHeader>(sql, [
      inviterId,
      inviteeId,
      period,
      rechargeAmount,
      rechargeCount,
      consumptionPoints,
      consumptionCount,
    ]);
  }

  /**
   * 插入或更新月统计记录
   */
  private async upsertMonthlyStats(
    conn: PoolConnection,
    inviterId: number,
    inviteeId: number,
    period: string,
    data: UpdateStatsData
  ): Promise<void> {
    const rechargeAmount = data.rechargeAmount || 0;
    const rechargeCount = data.rechargeCount || (data.rechargeAmount ? 1 : 0);
    const consumptionPoints = data.consumptionPoints || 0;
    const consumptionCount =
      data.consumptionCount || (data.consumptionPoints ? 1 : 0);

    const sql = `
      INSERT INTO invitee_stats
        (inviter_id, invitee_id, stat_type, period,
         recharge_amount, recharge_count, consumption_points, consumption_count, settlement_status)
      VALUES (?, ?, 'monthly', ?, ?, ?, ?, ?, 'unsettled')
      ON DUPLICATE KEY UPDATE
        recharge_amount = recharge_amount + VALUES(recharge_amount),
        recharge_count = recharge_count + VALUES(recharge_count),
        consumption_points = consumption_points + VALUES(consumption_points),
        consumption_count = consumption_count + VALUES(consumption_count)
    `;

    await conn.execute<ResultSetHeader>(sql, [
      inviterId,
      inviteeId,
      period,
      rechargeAmount,
      rechargeCount,
      consumptionPoints,
      consumptionCount,
    ]);
  }

  /**
   * 查询被邀请人某月明细（日维度）
   */
  async getDailyStatsByMonth(
    inviterId: number,
    inviteeId: number,
    month: string
  ): Promise<InviteeStats[]> {
    const [rows] = await pool.execute(
      `SELECT * FROM invitee_stats
       WHERE inviter_id = ?
         AND invitee_id = ?
         AND stat_type = 'daily'
         AND period LIKE ?
       ORDER BY period ASC`,
      [inviterId, inviteeId, `${month}%`]
    );
    return rows as InviteeStats[];
  }

  /**
   * 查询邀请人某月汇总（被邀请人维度）
   */
  async getMonthlyStatsByInvitee(
    inviterId: number,
    month: string
  ): Promise<
    {
      invitee_id: number;
      recharge_amount: number;
      recharge_count: number;
      consumption_points: number;
      consumption_count: number;
      settlement_status: string;
    }[]
  > {
    const [rows] = await pool.execute(
      `SELECT
        invitee_id,
        recharge_amount,
        recharge_count,
        consumption_points,
        consumption_count,
        settlement_status
      FROM invitee_stats
      WHERE inviter_id = ?
        AND stat_type = 'monthly'
        AND period = ?
      ORDER BY invitee_id ASC`,
      [inviterId, month]
    );
    return rows as any[];
  }

  /**
   * 查询被邀请人当前月统计
   */
  async getCurrentMonthStats(
    inviterId: number,
    inviteeId: number
  ): Promise<InviteeStats | null> {
    const currentMonth = getCurrentMonthStr();
    const [rows] = await pool.execute(
      `SELECT * FROM invitee_stats
       WHERE inviter_id = ?
         AND invitee_id = ?
         AND stat_type = 'monthly'
         AND period = ?
       LIMIT 1`,
      [inviterId, inviteeId, currentMonth]
    );
    return (rows as InviteeStats[])[0] || null;
  }

  /**
   * 获取邀请人当前月所有被邀请人统计汇总
   */
  async getCurrentMonthSummary(
    inviterId: number
  ): Promise<{
    totalRecharge: number;
    totalConsumption: number;
    activeInviteeCount: number;
  }> {
    const currentMonth = getCurrentMonthStr();
    const [rows] = await pool.execute(
      `SELECT
        SUM(recharge_amount) as total_recharge,
        SUM(consumption_points) as total_consumption,
        COUNT(DISTINCT invitee_id) as active_invitee_count
      FROM invitee_stats
      WHERE inviter_id = ?
        AND stat_type = 'monthly'
        AND period = ?`,
      [inviterId, currentMonth]
    );

    const result = (rows as any[])[0];
    return {
      totalRecharge: Number(result?.total_recharge || 0),
      totalConsumption: Number(result?.total_consumption || 0),
      activeInviteeCount: Number(result?.active_invitee_count || 0),
    };
  }
}

export default new InviteStatsService();
