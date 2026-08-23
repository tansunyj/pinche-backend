/**
 * 计费/订单/余额服务
 *
 * 复用现有 MySQL 表：
 *   - billing_orders        充值订单（order_no、amount、points、status、third_party_order_no...）
 *   - billing_transactions  余额流水（type、delta、balance_after、ref_type、ref_id...）
 *   - user_users.balance / cumulative_recharge  实时余额 + 累计充值
 *
 * 设计要点：
 *   - amount 始终为元（DECIMAL(10,2)），points 始终为整数（点/分）
 *   - markOrderPaid 用事务 + SELECT FOR UPDATE 防重入 + 写流水保证可追溯
 *   - 所有读写都基于 mysql pool，不依赖 Prisma
 */

import crypto from "crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../db/mysql";
import StatsService from "./StatsService";
import InviteStatsService from "./InviteStatsService";

export type PayMethod = "alipay" | "wechat" | "stripe" | "paypal";
export type OrderStatus = "pending" | "paid" | "failed" | "refunded" | "expired";

export interface BillingOrder {
  id: number;
  order_no: string;
  user_id: number;
  amount: number; // 元
  points: number; // 点
  payment_channel: PayMethod;
  payment_method: string | null;
  third_party_order_no: string | null;
  status: OrderStatus;
  paid_at: Date | null;
  expired_at: Date | null;
  client_ip: string | null;
  user_agent: string | null;
  created_at: Date;
  updated_at: Date;
}

export function getPointsPerYuan(): number {
  // 与Token系统保持一致：1元 = 100000额度
  return Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;
}

export function getOrderExpireMinutes(): number {
  return Number(process.env.ORDER_EXPIRE_MINUTES) || 30;
}

/** 生成业务订单号：年月日时分秒 + 用户后4位 + 6随机 */
function generateOrderNo(userId: number): string {
  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const userTail = String(userId).slice(-4).padStart(4, "0");
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${ts}${userTail}${rand}`;
}

class BillingService {
  // ============ 订单 ============

  async createOrder(input: {
    userId: number;
    amount: number; // 元
    payMethod: PayMethod;
    paymentMethodDetail?: string; // 如 alipay_qrcode / wechat_native
    clientIp?: string | null;
    userAgent?: string | null;
  }): Promise<BillingOrder> {
    if (!(input.amount > 0)) {
      throw new Error("订单金额必须 > 0");
    }
    const points = Math.round(input.amount * getPointsPerYuan());
    const orderNo = generateOrderNo(input.userId);
    const expiredAt = new Date(Date.now() + getOrderExpireMinutes() * 60 * 1000);

    const [r] = await pool.execute<ResultSetHeader>(
      `INSERT INTO billing_orders
        (order_no, user_id, amount, points, payment_channel, payment_method,
         status, expired_at, client_ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        orderNo,
        input.userId,
        input.amount.toFixed(2),
        points,
        input.payMethod,
        input.paymentMethodDetail ?? null,
        expiredAt,
        input.clientIp ?? null,
        input.userAgent ?? null,
      ]
    );

    const created = await this.findById(r.insertId);
    if (!created) throw new Error("订单创建后查询失败");
    console.log(
      `[Billing] 已创建订单 order_no=${created.order_no} user=${input.userId} amount=¥${input.amount} points=${points} method=${input.payMethod}`
    );

    // 记录充值订单统计
    StatsService.recordRechargeOrder(input.userId, input.amount, points);

    return created;
  }

  async findById(id: number): Promise<BillingOrder | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM billing_orders WHERE id = ? LIMIT 1`,
      [id]
    );
    return (rows[0] as BillingOrder) || null;
  }

  async findByOrderNo(orderNo: string): Promise<BillingOrder | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM billing_orders WHERE order_no = ? LIMIT 1`,
      [orderNo]
    );
    return (rows[0] as BillingOrder) || null;
  }

  async listUserOrders(
    userId: number,
    opts?: { limit?: number; offset?: number }
  ): Promise<BillingOrder[]> {
    const limit = Math.min(opts?.limit ?? 20, 100);
    const offset = opts?.offset ?? 0;
    // LIMIT 和 OFFSET 直接拼接到 SQL 中，不作为参数传递
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM billing_orders
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      [userId]
    );
    return rows as BillingOrder[];
  }

  /**
   * 标记订单为已支付（幂等）：
   *   - 同一订单多次回调只入账一次
   *   - 失败抛错；成功返回更新后的订单 + 用户最新余额
   */
  async markOrderPaid(input: {
    orderNo: string;
    thirdPartyNo: string;
    paidAt?: Date;
  }): Promise<{ order: BillingOrder; newBalance: number; alreadyPaid: boolean }> {
    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [orderRows] = await conn.execute<RowDataPacket[]>(
        `SELECT * FROM billing_orders WHERE order_no = ? FOR UPDATE`,
        [input.orderNo]
      );
      const order = orderRows[0] as BillingOrder | undefined;
      if (!order) {
        throw new Error(`订单不存在: ${input.orderNo}`);
      }

      if (order.status === "paid") {
        // 已入账，幂等返回
        const [userRows] = await conn.execute<RowDataPacket[]>(
          `SELECT balance FROM user_users WHERE id = ? LIMIT 1`,
          [order.user_id]
        );
        await conn.commit();
        return {
          order,
          newBalance: Number(userRows[0]?.balance ?? 0),
          alreadyPaid: true,
        };
      }

      if (order.status !== "pending") {
        throw new Error(`订单状态不允许入账: ${order.status}`);
      }

      const paidAt = input.paidAt ?? new Date();

      await conn.execute(
        `UPDATE billing_orders
            SET status = 'paid',
                paid_at = ?,
                third_party_order_no = ?
          WHERE id = ?`,
        [paidAt, input.thirdPartyNo, order.id]
      );

      // 更新用户余额 + 累计充值
      await conn.execute(
        `UPDATE user_users
            SET balance = balance + ?,
                cumulative_recharge = cumulative_recharge + ?,
                overdraft_since = NULL
          WHERE id = ?`,
        [order.points, order.points, order.user_id]
      );

      // 写流水
      const [userRows2] = await conn.execute<RowDataPacket[]>(
        `SELECT balance FROM user_users WHERE id = ? LIMIT 1`,
        [order.user_id]
      );
      const balanceAfter = Number(userRows2[0]?.balance ?? 0);

      await conn.execute(
        `INSERT INTO billing_transactions
          (user_id, type, delta, balance_after, ref_type, ref_id, remark)
         VALUES (?, 'recharge', ?, ?, 'order', ?, ?)`,
        [
          order.user_id,
          order.points,
          balanceAfter,
          order.id,
          `充值 ¥${Number(order.amount).toFixed(2)} (${order.payment_channel})`,
        ]
      );

      await conn.commit();

      const fresh = (await this.findById(order.id))!;
      console.log(
        `[Billing] ✅ 订单入账成功 order_no=${order.order_no} user=${order.user_id} +${order.points} 点 newBalance=${balanceAfter}`
      );

      // 记录充值成功统计
      StatsService.recordRechargeSuccess(
        order.user_id,
        Number(order.amount),
        order.points
      );

      // 更新邀请统计（异步执行，不影响主流程）
      this.updateInviteStatsAsync(order.user_id, Number(order.amount));

      return { order: fresh, newBalance: balanceAfter, alreadyPaid: false };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** 用户主动取消未支付订单（pending → expired） */
  async cancelOrder(orderNo: string, userId: number): Promise<BillingOrder> {
    const [r] = await pool.execute<ResultSetHeader>(
      `UPDATE billing_orders
          SET status = 'expired'
        WHERE order_no = ? AND user_id = ? AND status = 'pending'`,
      [orderNo, userId]
    );
    if (r.affectedRows === 0) {
      throw new Error("订单不存在或状态不允许取消");
    }
    return (await this.findByOrderNo(orderNo))!;
  }

  /** 后台 cron 调用：扫描过期未支付订单 */
  async expireStaleOrders(): Promise<number> {
    const [r] = await pool.execute<ResultSetHeader>(
      `UPDATE billing_orders
          SET status = 'expired'
        WHERE status = 'pending' AND expired_at < NOW()`
    );
    if (r.affectedRows > 0) {
      console.log(`[Billing] 自动过期订单 ${r.affectedRows} 条`);
    }
    return r.affectedRows;
  }

  /**
   * 更新邀请统计（异步，不影响主流程）
   * 查询用户是否有邀请人，如果有则更新邀请统计
   */
  private async updateInviteStatsAsync(
    userId: number,
    rechargeAmount: number
  ): Promise<void> {
    try {
      // 查询用户是否有邀请人
      const [userRows] = await pool.execute<RowDataPacket[]>(
        `SELECT invited_by FROM user_users WHERE id = ? AND invited_by IS NOT NULL LIMIT 1`,
        [userId]
      );

      const inviterId = (userRows[0] as { invited_by?: number })?.invited_by;
      if (!inviterId) {
        return; // 没有邀请人，跳过
      }

      // 更新邀请统计
      await InviteStatsService.updateInviteeStats(inviterId, userId, {
        rechargeAmount,
        rechargeCount: 1,
      });

      console.log(
        `[Billing] 邀请统计已更新: inviter=${inviterId}, invitee=${userId}, amount=${rechargeAmount}`
      );
    } catch (err) {
      // 邀请统计不应该影响充值主流程，仅记录错误日志
      console.error("[Billing] 更新邀请统计失败（非关键错误）:", err);
    }
  }
}

export default new BillingService();
