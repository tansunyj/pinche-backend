/**
 * 充值功能测试脚本
 *
 * 功能：
 * 1. 创建测试用户（邀请人和被邀请人）
 * 2. 模拟创建充值订单并标记为已支付
 * 3. 验证 invitee_stats 表的累计金额和次数是否正确
 *
 * 使用方法：
 *   npx tsx scripts/test-recharge-stats.ts
 *
 * 环境变量（可选）：
 *   MYSQL_HOST - 数据库主机（默认 localhost）
 *   MYSQL_PORT - 数据库端口（默认 3306）
 *   MYSQL_USER - 数据库用户（默认 root）
 *   MYSQL_PASSWORD - 数据库密码（默认 123456）
 *   MYSQL_DATABASE - 数据库名（默认 silievo）
 */

import mysql from "mysql2/promise";
import crypto from "crypto";

// 数据库配置
const dbConfig = {
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "123456",
  database: process.env.MYSQL_DATABASE || "silievo",
  charset: "utf8mb4" as const,
  timezone: "+08:00",
  decimalNumbers: true,
};

// 测试用户ID
const TEST_INVITER_ID = 11;    // 测试邀请人
const TEST_INVITEE_ID = 15;    // 测试被邀请人

// 测试订单信息
const TEST_ORDER_AMOUNTS = [50.0, 100.0, 30.5]; // 充值金额（元）

/**
 * 生成业务订单号
 */
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

/**
 * 获取当前日期字符串
 */
function getTodayStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 获取当前月份字符串
 */
function getCurrentMonthStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * 创建测试用户
 */
async function createTestUsers(pool: mysql.Pool): Promise<void> {
  console.log("\n[步骤1] 创建测试用户...");

  // 创建邀请人
  await pool.execute(
    `INSERT INTO user_users (id, name, phone, email, password_hash, balance, user_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), balance = VALUES(balance)`,
    [
      TEST_INVITER_ID,
      "测试邀请人-充值测试",
      `13888${TEST_INVITER_ID.toString().slice(-5)}`,
      `inviter_${TEST_INVITER_ID}@test.com`,
      "$2b$10$testhash",
      0,
      1,
      1,
    ]
  );

  // 创建被邀请人（带有 invited_by）
  await pool.execute(
    `INSERT INTO user_users (id, name, phone, email, password_hash, balance, invited_by, user_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), balance=VALUES(balance), invited_by=VALUES(invited_by)`,
    [
      TEST_INVITEE_ID,
      "测试被邀请人-充值测试",
      `13999${TEST_INVITEE_ID.toString().slice(-5)}`,
      `invitee_${TEST_INVITEE_ID}@test.com`,
      "$2b$10$testhash",
      0,
      TEST_INVITER_ID,
      1,
      1,
    ]
  );

  // 创建邀请关系
  await pool.execute(
    `INSERT INTO user_invites (inviter_id, invitee_id, invite_code, status, registered_at, created_at)
     VALUES (?, ?, ?, 'registered', NOW(), NOW())
     ON DUPLICATE KEY UPDATE status = 'registered'`,
    [TEST_INVITER_ID, TEST_INVITEE_ID, "TESTCODE"]
  );

  console.log(`  ✓ 邀请人 ID: ${TEST_INVITER_ID}`);
  console.log(`  ✓ 被邀请人 ID: ${TEST_INVITEE_ID} (invited_by=${TEST_INVITER_ID})`);
}

/**
 * 清理测试数据
 */
async function cleanupTestData(pool: mysql.Pool): Promise<void> {
  console.log("\n[清理] 清理旧的测试数据...");

  // 删除 invitee_stats 中的测试数据
  await pool.execute(
    `DELETE FROM invitee_stats WHERE inviter_id = ? AND invitee_id = ?`,
    [TEST_INVITER_ID, TEST_INVITEE_ID]
  );

  // 删除 billing_orders 中的测试数据
  await pool.execute(
    `DELETE FROM billing_orders WHERE user_id = ?`,
    [TEST_INVITEE_ID]
  );

  // 删除 billing_transactions 中的测试数据
  await pool.execute(
    `DELETE FROM billing_transactions WHERE user_id = ?`,
    [TEST_INVITEE_ID]
  );

  // 重置用户余额
  await pool.execute(
    `UPDATE user_users SET balance = 0 WHERE id = ?`,
    [TEST_INVITEE_ID]
  );

  console.log("  ✓ 清理完成");
}

/**
 * 创建并支付订单（模拟充值流程）
 */
async function createAndPayOrder(
  pool: mysql.Pool,
  amount: number
): Promise<{ orderId: number; orderNo: string }> {
  const pointsPerYuan = Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;
  const points = Math.round(amount * pointsPerYuan);
  const orderNo = generateOrderNo(TEST_INVITEE_ID);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. 创建订单
    const [insertResult] = await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO billing_orders
       (order_no, user_id, amount, points, payment_channel, status, expired_at, created_at)
       VALUES (?, ?, ?, ?, 'alipay', 'pending', DATE_ADD(NOW(), INTERVAL 30 MINUTE), NOW())`,
      [orderNo, TEST_INVITEE_ID, amount, points]
    );
    const orderId = insertResult.insertId;

    // 2. 标记订单为已支付
    await conn.execute(
      `UPDATE billing_orders
       SET status = 'paid', paid_at = NOW(), third_party_order_no = ?
       WHERE id = ?`,
      [`THIRD_${orderNo}`, orderId]
    );

    // 3. 更新用户余额
    await conn.execute(
      `UPDATE user_users
       SET balance = balance + ?, cumulative_recharge = cumulative_recharge + ?
       WHERE id = ?`,
      [points, points, TEST_INVITEE_ID]
    );

    // 4. 查询最新余额
    const [userRows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT balance FROM user_users WHERE id = ?`,
      [TEST_INVITEE_ID]
    );
    const balanceAfter = Number(userRows[0]?.balance || 0);

    // 5. 写流水
    await conn.execute(
      `INSERT INTO billing_transactions
       (user_id, type, delta, balance_after, ref_type, ref_id, remark)
       VALUES (?, 'recharge', ?, ?, 'order', ?, ?)`,
      [
        TEST_INVITEE_ID,
        points,
        balanceAfter,
        orderId,
        `充值 ¥${amount.toFixed(2)} (alipay)`,
      ]
    );

    // 6. 更新邀请统计（核心逻辑！）
    const today = getTodayStr();
    const currentMonth = getCurrentMonthStr();

    // 更新日统计
    await conn.execute(
      `INSERT INTO invitee_stats
       (inviter_id, invitee_id, stat_type, period,
        recharge_amount, recharge_count, consumption_points, consumption_count)
       VALUES (?, ?, 'daily', ?, ?, 1, 0, 0)
       ON DUPLICATE KEY UPDATE
       recharge_amount = recharge_amount + VALUES(recharge_amount),
       recharge_count = recharge_count + VALUES(recharge_count)`,
      [TEST_INVITER_ID, TEST_INVITEE_ID, today, amount]
    );

    // 更新月统计
    await conn.execute(
      `INSERT INTO invitee_stats
       (inviter_id, invitee_id, stat_type, period,
        recharge_amount, recharge_count, consumption_points, consumption_count)
       VALUES (?, ?, 'monthly', ?, ?, 1, 0, 0)
       ON DUPLICATE KEY UPDATE
       recharge_amount = recharge_amount + VALUES(recharge_amount),
       recharge_count = recharge_count + VALUES(recharge_count)`,
      [TEST_INVITER_ID, TEST_INVITEE_ID, currentMonth, amount]
    );

    await conn.commit();

    return { orderId, orderNo };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 查询并打印当前统计
 */
async function queryAndPrintStats(pool: mysql.Pool): Promise<{
  daily: any;
  monthly: any;
}> {
  const today = getTodayStr();
  const currentMonth = getCurrentMonthStr();

  // 查询日统计
  const [dailyRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM invitee_stats
     WHERE inviter_id = ? AND invitee_id = ? AND stat_type = 'daily' AND period = ?`,
    [TEST_INVITER_ID, TEST_INVITEE_ID, today]
  );

  // 查询月统计
  const [monthlyRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM invitee_stats
     WHERE inviter_id = ? AND invitee_id = ? AND stat_type = 'monthly' AND period = ?`,
    [TEST_INVITER_ID, TEST_INVITEE_ID, currentMonth]
  );

  const daily = dailyRows[0] || null;
  const monthly = monthlyRows[0] || null;

  console.log("\n  当前统计状态:");
  console.log(
    `    日统计 (${today}):     充值=${daily?.recharge_amount || 0}元, 次数=${daily?.recharge_count || 0}`
  );
  console.log(
    `    月统计 (${currentMonth}): 充值=${monthly?.recharge_amount || 0}元, 次数=${monthly?.recharge_count || 0}`
  );

  return { daily, monthly };
}

/**
 * 执行充值测试
 */
async function runRechargeTest(pool: mysql.Pool): Promise<void> {
  console.log("\n[步骤3] 执行充值测试...");
  console.log(`  计划充值次数: ${TEST_ORDER_AMOUNTS.length}次`);
  console.log(`  充值金额列表: [${TEST_ORDER_AMOUNTS.join(", ")}]元`);
  console.log(`  预期累计金额: ${TEST_ORDER_AMOUNTS.reduce((a, b) => a + b, 0)}元`);
  console.log(`  预期充值次数: ${TEST_ORDER_AMOUNTS.length}次`);

  const results: Array<{ amount: number; orderNo: string }> = [];

  for (let i = 0; i < TEST_ORDER_AMOUNTS.length; i++) {
    const amount = TEST_ORDER_AMOUNTS[i];
    console.log(`\n  [充值 ${i + 1}/${TEST_ORDER_AMOUNTS.length}] 金额: ¥${amount}`);

    const { orderNo } = await createAndPayOrder(pool, amount);
    results.push({ amount, orderNo });

    // 查询当前统计
    await queryAndPrintStats(pool);
  }

  return;
}

/**
 * 验证最终结果
 */
async function verifyFinalResult(pool: mysql.Pool): Promise<boolean> {
  console.log("\n[步骤4] 验证最终结果...");

  const expectedTotalAmount = TEST_ORDER_AMOUNTS.reduce((a, b) => a + b, 0);
  const expectedCount = TEST_ORDER_AMOUNTS.length;

  const { daily, monthly } = await queryAndPrintStats(pool);

  let allPassed = true;

  // 验证日统计
  console.log("\n  日统计验证:");
  if (Math.abs(daily?.recharge_amount - expectedTotalAmount) < 0.01) {
    console.log(`    ✓ 充值金额正确: ${daily?.recharge_amount} == ${expectedTotalAmount}`);
  } else {
    console.log(
      `    ✗ 充值金额错误: ${daily?.recharge_amount} != ${expectedTotalAmount}`
    );
    allPassed = false;
  }

  if (daily?.recharge_count === expectedCount) {
    console.log(`    ✓ 充值次数正确: ${daily?.recharge_count} == ${expectedCount}`);
  } else {
    console.log(
      `    ✗ 充值次数错误: ${daily?.recharge_count} != ${expectedCount}`
    );
    allPassed = false;
  }

  // 验证月统计
  console.log("\n  月统计验证:");
  if (Math.abs(monthly?.recharge_amount - expectedTotalAmount) < 0.01) {
    console.log(
      `    ✓ 充值金额正确: ${monthly?.recharge_amount} == ${expectedTotalAmount}`
    );
  } else {
    console.log(
      `    ✗ 充值金额错误: ${monthly?.recharge_amount} != ${expectedTotalAmount}`
    );
    allPassed = false;
  }

  if (monthly?.recharge_count === expectedCount) {
    console.log(
      `    ✓ 充值次数正确: ${monthly?.recharge_count} == ${expectedCount}`
    );
  } else {
    console.log(
      `    ✗ 充值次数错误: ${monthly?.recharge_count} != ${expectedCount}`
    );
    allPassed = false;
  }

  return allPassed;
}

/**
 * 打印详细数据查询SQL
 */
async function printDebugInfo(pool: mysql.Pool): Promise<void> {
  console.log("\n[调试信息] 相关数据查询:");

  // 查询 billing_orders
  const [orders] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT order_no, amount, points, status, paid_at
     FROM billing_orders WHERE user_id = ? ORDER BY id ASC`,
    [TEST_INVITEE_ID]
  );
  console.log("\n  billing_orders (充值订单):");
  orders.forEach((o, i) => {
    console.log(`    ${i + 1}. 订单号=${o.order_no}, 金额=${o.amount}元, 状态=${o.status}`);
  });

  // 查询 billing_transactions
  const [transactions] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT type, delta, balance_after, remark, created_at
     FROM billing_transactions WHERE user_id = ? ORDER BY id ASC`,
    [TEST_INVITEE_ID]
  );
  console.log("\n  billing_transactions (余额流水):");
  transactions.forEach((t, i) => {
    console.log(`    ${i + 1}. 类型=${t.type}, 变动=${t.delta}, 余额=${t.balance_after}`);
  });

  // 查询 invitee_stats 详细数据
  const [stats] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT stat_type, period, recharge_amount, recharge_count,
            consumption_points, consumption_count, settlement_status
     FROM invitee_stats WHERE inviter_id = ? AND invitee_id = ?
     ORDER BY stat_type, period`,
    [TEST_INVITER_ID, TEST_INVITEE_ID]
  );
  console.log("\n  invitee_stats (邀请统计) 详细数据:");
  stats.forEach((s, i) => {
    console.log(
      `    ${i + 1}. 类型=${s.stat_type}, 周期=${s.period}, ` +
      `充值=${s.recharge_amount}元(${s.recharge_count}次), ` +
      `消费=${s.consumption_points}积分(${s.consumption_count}次), ` +
      `结算状态=${s.settlement_status}`
    );
  });
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("邀请系统充值统计测试脚本");
  console.log("=".repeat(60));
  console.log(`数据库: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

  const pool = mysql.createPool(dbConfig);

  try {
    // 步骤1: 创建测试用户
    await createTestUsers(pool);

    // 清理旧的测试数据
    await cleanupTestData(pool);

    // 步骤2: 显示初始状态
    console.log("\n[步骤2] 初始状态（充值前）:");
    await queryAndPrintStats(pool);

    // 步骤3: 执行充值测试
    await runRechargeTest(pool);

    // 步骤4: 验证结果
    const passed = await verifyFinalResult(pool);

    // 打印详细调试信息
    await printDebugInfo(pool);

    // 最终结论
    console.log("\n" + "=".repeat(60));
    if (passed) {
      console.log("✓ 测试通过！充值统计功能工作正常");
    } else {
      console.log("✗ 测试失败！充值统计数据存在异常");
      process.exit(1);
    }
    console.log("=".repeat(60));

    // 询问是否清理测试数据
    console.log("\n提示: 测试数据保留在数据库中，用户ID:");
    console.log(`  - 邀请人: ${TEST_INVITER_ID}`);
    console.log(`  - 被邀请人: ${TEST_INVITEE_ID}`);
    console.log("  如需手动验证，可访问前端页面查看邀请统计。");
  } catch (err) {
    console.error("\n测试执行错误:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// 运行测试
main();
