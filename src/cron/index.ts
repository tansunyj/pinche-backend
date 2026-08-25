/**
 * 定时任务（§2.6 可靠性 + 活跃度回收）
 *
 *   每分钟  充值到账 worker（消费 pt_payment_tasks）
 *   每分钟  充值对账（主动查支付宝，补漏单）
 *   每5分钟 到期车次置 EXPIRED（网关按 end_time 自动过滤过期折扣，无需撤销）
 *   每5分钟 活跃度回收（长期无消费成员请出）
 */

import cron from "node-cron";
import { cpQuery } from "../config/db";
import { processPendingCreditTasks, enqueueCreditTask } from "../services/payment/credit";
import { kickRideMember } from "../services/ride";
import alipay from "../services/payment/alipay";
import { syncStatsOnce, snapshotRideProgress } from "./statsSync";

/** 不活跃判定：30 天无消费（或上车后一直无消费） */
const INACTIVE_DAYS = Number(process.env.RIDE_INACTIVE_DAYS || 30);

export function initCronJobs() {
  // 充值到账
  cron.schedule("*/1 * * * *", () => {
    processPendingCreditTasks(10).catch((e) => console.error("[Cron] 到账任务失败:", e));
  });

  // 充值对账
  cron.schedule("*/1 * * * *", () => {
    reconcileRecharge().catch((e) => console.error("[Cron] 充值对账失败:", e));
  });

  // 发车处理（成团补种 + 未成团取消），每分钟缩短撤销窗口
  cron.schedule("*/1 * * * *", () => {
    processDepartures().catch((e) => console.error("[Cron] 发车处理失败:", e));
  });

  // 到期车次
  cron.schedule("*/5 * * * *", () => {
    expireRides().catch((e) => console.error("[Cron] 到期处理失败:", e));
  });

  // 活跃度回收
  cron.schedule("*/5 * * * *", () => {
    recycleInactiveMembers().catch((e) => console.error("[Cron] 活跃度回收失败:", e));
  });

  // 统计同步(§5.2):每 60s Redis → unified_stats 覆盖写
  cron.schedule("*/1 * * * *", () => {
    syncStatsOnce()
      .then((n) => {
        if (n > 0) console.log(`[Cron] 统计同步: 写入 ${n} 行`);
      })
      .catch((e) => console.error("[Cron] 统计同步失败:", e));
  });

  // 车次进度快照(§5.6):每天 00:05
  cron.schedule("5 0 * * *", () => {
    snapshotRideProgress().catch((e) => console.error("[Cron] 车次进度快照失败:", e));
  });
}

/**
 * 发车处理：
 *   1. 成团补种（达到最低人数即锁存 established_at，兜底编辑改 min_count 等场景）
 *   2. 发车时间(start_time)到仍未成团 → 自动取消（CANCELLED）
 */
async function processDepartures(): Promise<number> {
  await cpQuery(
    `UPDATE pt_rides SET established_at = COALESCE(established_at, NOW())
     WHERE established_at IS NULL AND current_count >= min_count AND status = 'ACTIVE'`
  );
  const rows = await cpQuery(
    `SELECT id FROM pt_rides
     WHERE status = 'ACTIVE'
       AND start_time IS NOT NULL AND start_time <= NOW()
       AND established_at IS NULL`
  );
  let cancelled = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const rideId = Number(r.id);
    // cpQuery 对 UPDATE 返回裸 ResultSetHeader（非数组），不能解构（见 expireRides 注释）
    const ur = await cpQuery(
      "UPDATE pt_rides SET status = 'CANCELLED' WHERE id = ? AND status = 'ACTIVE'",
      [rideId]
    );
    if (Number((ur as any).affectedRows || 0) === 0) continue;
    cancelled++;
  }
  if (cancelled > 0) console.log(`[Cron] ${cancelled} 个车次发车未成团，已自动取消`);
  return cancelled;
}

/** 到期置 EXPIRED：折扣由网关按 end_time 自动过滤，无需撤销 */
async function expireRides(): Promise<number> {
  // cpQuery 返回裸 ResultSetHeader（非 [rows, fields]），不能再次解构
  // 车次结束时间已过 → 置 EXPIRED（上线中的车次）
  const r = await cpQuery(
    `UPDATE pt_rides SET status = 'EXPIRED'
     WHERE status = 'ACTIVE'
       AND end_time IS NOT NULL AND end_time < NOW()`
  );
  const affected = Number((r as any).affectedRows || 0);
  if (affected > 0) console.log(`[Cron] ${affected} 个车次已到期置 EXPIRED`);
  return affected;
}

/** 活跃度回收：长期无消费的成员请出并撤销折扣、释放名额 */
async function recycleInactiveMembers(): Promise<number> {
  const rows = await cpQuery(
    `SELECT m.ride_id, m.user_id
     FROM pt_ride_members m
     JOIN pt_rides r ON r.id = m.ride_id
     WHERE m.status = 'ACTIVE'
       AND (
         (m.last_consumption_at IS NOT NULL AND m.last_consumption_at < DATE_SUB(NOW(), INTERVAL ? DAY))
         OR (m.last_consumption_at IS NULL AND m.joined_at < DATE_SUB(NOW(), INTERVAL ? DAY))
       )
     LIMIT 50`,
    [INACTIVE_DAYS, INACTIVE_DAYS]
  );
  let kicked = 0;
  for (const m of Array.isArray(rows) ? rows : []) {
    const result = await kickRideMember(Number(m.ride_id), Number(m.user_id));
    if (result.ok) kicked++;
  }
  if (kicked > 0) console.log(`[Cron] 活跃度回收：${kicked} 位不活跃成员已请出`);
  return kicked;
}

/** 充值对账：主动查询 5 分钟前仍未支付的订单，若已支付则推进到账（补漏单） */
async function reconcileRecharge(): Promise<number> {
  if (alipay.isDryRun()) return 0; // DRY_RUN 无真实支付宝可查
  // 只查最近 30 分钟内创建的未付单：支付宝 precreate 超时 15m，超过 30m 且无回调的单
  // 在支付宝侧必然已关闭（TRADE_NOT_EXIST），永远不可能 to paid，不再无限重查。
  const rows = await cpQuery(
    `SELECT id, order_no FROM pt_payments
     WHERE status IN ('PENDING','CALLBACK_RECEIVED')
       AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
       AND created_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
     ORDER BY id ASC LIMIT 10`
  );
  let recovered = 0;
  for (const p of Array.isArray(rows) ? rows : []) {
    try {
      const q = await alipay.queryOrder(p.order_no);
      if (q.status !== "paid") continue;
      await cpQuery(
        `UPDATE pt_payments
         SET status = 'CALLBACK_RECEIVED', out_trade_no = COALESCE(out_trade_no, ?), paid_at = COALESCE(paid_at, NOW())
         WHERE id = ? AND status IN ('PENDING','CALLBACK_RECEIVED')`,
        [q.thirdPartyNo || null, p.id]
      );
      // 防重复入队
      const tasks = await cpQuery(
        "SELECT id FROM pt_payment_tasks WHERE payment_id = ? AND status IN ('PENDING','PROCESSING')",
        [p.id]
      );
      if (!Array.isArray(tasks) || tasks.length === 0) {
        await enqueueCreditTask(p.id, p.order_no);
        recovered++;
      }
    } catch (e) {
      // 只打 .message 会吞掉真实原因（如 undici 的 fetch failed 底层在 e.cause 里）
      const err = e as Error & { cause?: Error };
      const causeMsg = err.cause ? ` (原因: ${err.cause.message})` : "";
      console.error(`[Cron] 对账订单 ${p.order_no} 查询失败: ${err.message}${causeMsg}`);
    }
  }
  if (recovered > 0) console.log(`[Cron] 对账补单 ${recovered} 笔`);
  return recovered;
}
