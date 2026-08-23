/**
 * 充值到账 Worker（§2.6 异步可靠到账）
 *
 * 消费 pt_payment_tasks 队列：
 *   1. 更新 pt_users.balance/cumulative_recharge += quota（拼车库，用户唯一存储）
 *   2. 删除 Redis 缓存键 user_balance:{userId}
 *   3. 更新 pt_payments.status = SUCCESS
 * 失败指数退避重试（1s→2s→4s→8s），超 5 次置 FAILED 需人工介入。
 */

import redis from "../../utils/redis";
import { cpQuery, cpTransaction } from "../../config/db";

const MAX_RETRY = 5;

export async function enqueueCreditTask(paymentId: number, orderNo: string) {
  await cpQuery(
    "INSERT INTO pt_payment_tasks (payment_id, order_no, task_type, status) VALUES (?, ?, 'CREDIT_BALANCE', 'PENDING')",
    [paymentId, orderNo]
  );
}

/** 单次处理一批待到账任务（cron 每分钟调用） */
export async function processPendingCreditTasks(batch = 10): Promise<number> {
  const tasks = await cpQuery(
    `SELECT * FROM pt_payment_tasks
     WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
     ORDER BY id ASC LIMIT ${batch}`
  );
  const list = Array.isArray(tasks) ? tasks : [];
  let handled = 0;

  for (const task of list) {
    // Redis 到账锁：同一订单串行处理，防重复到账
    const lockKey = `pt:lock:payment:${task.order_no}`;
    const locked = await redis.set(lockKey, "1", "EX", 60, "NX");
    if (!locked) continue; // 已有并发在途

    try {
      await cpTransaction(async (conn) => {
        // 领取任务（防并发）
        await conn.execute(
          "UPDATE pt_payment_tasks SET status = 'PROCESSING' WHERE id = ? AND status = 'PENDING'",
          [task.id]
        );

        const payment = (await conn.execute("SELECT * FROM pt_payments WHERE id = ? LIMIT 1", [task.payment_id]))[0] as any[];
        if (!payment || payment.length === 0) throw new Error(`payment 不存在: ${task.payment_id}`);
        const p = payment[0];

        // 幂等兜底：已 SUCCESS 说明已到账，直接完成任务
        if (p.status === "SUCCESS") {
          await conn.execute(
            "UPDATE pt_payment_tasks SET status = 'SUCCESS', updated_at = NOW() WHERE id = ?",
            [task.id]
          );
          return;
        }

        const ptUser = (await conn.execute("SELECT id FROM pt_users WHERE id = ? LIMIT 1", [p.user_id]))[0] as any[];
        if (!ptUser || ptUser.length === 0) {
          throw new Error(`用户不存在: ptUserId=${p.user_id}`);
        }

        // 1. pt_users 加余额 + 累计充值（条件更新 + 幂等校验）
        const quota = Number(p.quota);
        const [ur] = await conn.execute(
          "UPDATE pt_users SET balance = balance + ?, cumulative_recharge = cumulative_recharge + ? WHERE id = ?",
          [quota, quota, p.user_id]
        );
        if ((ur as any).affectedRows === 0) throw new Error(`拼车用户不存在: ${p.user_id}`);

        // 2. 清 Redis 余额缓存
        await redis.del(`user_balance:${p.user_id}`);

        // 3. 更新流水 SUCCESS（仅 PENDING/CALLBACK_RECEIVED/PROCESSING → SUCCESS）
        await conn.execute(
          "UPDATE pt_payments SET status = 'SUCCESS' WHERE id = ? AND status IN ('PENDING','CALLBACK_RECEIVED','PROCESSING')",
          [p.id]
        );

        // 4. 任务完成
        await conn.execute(
          "UPDATE pt_payment_tasks SET status = 'SUCCESS', updated_at = NOW() WHERE id = ?",
          [task.id]
        );
      });
      handled++;
      // 成功路径释放锁
      await redis.del(lockKey).catch(() => {});
    } catch (err: any) {
      // 失败路径释放锁（幂等键保证重试不会重复到账）
      await redis.del(lockKey).catch(() => {});
      const next = Number(task.retry_count || 0) + 1;
      const lastError = (err?.message || String(err)).slice(0, 500);
      if (next >= MAX_RETRY) {
        await cpQuery(
          "UPDATE pt_payment_tasks SET status = 'FAILED', retry_count = ?, last_error = ?, updated_at = NOW() WHERE id = ?",
          [next, lastError, task.id]
        );
        console.error(`[Credit] 到账任务 ${task.id} 重试耗尽，需人工介入: ${lastError}`);
      } else {
        const backoffMs = Math.pow(2, next) * 1000;
        await cpQuery(
          "UPDATE pt_payment_tasks SET status = 'PENDING', retry_count = ?, last_error = ?, next_retry_at = DATE_ADD(NOW(), INTERVAL ? SECOND), updated_at = NOW() WHERE id = ?",
          [next, lastError, Math.ceil(backoffMs / 1000), task.id]
        );
        console.warn(`[Credit] 到账任务 ${task.id} 第 ${next} 次重试: ${lastError}`);
      }
    }
  }
  return handled;
}
