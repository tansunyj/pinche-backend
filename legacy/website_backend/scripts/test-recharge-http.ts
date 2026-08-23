/**
 * 充值功能HTTP接口测试脚本
 *
 * 测试流程：
 * 1. 被邀请人登录获取 JWT Token
 * 2. 创建充值订单 (POST /api/payments/create)
 * 3. 模拟支付回调 (POST /api/payments/notify/alipay)
 * 4. 查询邀请统计验证数据
 *
 * 使用方法：
 *   npx tsx scripts/test-recharge-http.ts
 *
 * 配置：
 *   - 被邀请人用户ID: 15
 *   - 邀请人用户ID: 11
 *   - API基础地址: http://localhost:3001
 */

import crypto from "crypto";

// ==================== 配置 ====================
const CONFIG = {
  API_BASE: process.env.API_BASE || "http://localhost:13001",
  INVITER_ID: 11,           // 邀请人ID（固定）
  INVITEE_ID: 15,           // 被邀请人ID（固定）
  // JWT Tokens - 直接在这里配置
  INVITER_TOKEN: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjExLCJlbWFpbCI6InRlc3RAdGVzdC5jb20iLCJ1c2VyVHlwZSI6MSwiaWF0IjoxNzgwMzI3MTk4LCJleHAiOjE3ODA5MzE5OTh9.VxMx5E_2VtYXLVmuMORDCY_GZtLrsjs5N6wts76xmD8",
  INVITEE_TOKEN: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjE1LCJlbWFpbCI6bnVsbCwidXNlclR5cGUiOjEsImlhdCI6MTc4MDYyODUxNiwiZXhwIjoxNzgxMjMzMzE2fQ.P3nn4Osbc6ggFaC182xq-QjLkk9tV7Cntv9RwRF2_tg",
  TEST_AMOUNTS: [50.0, 100.0, 30.5], // 充值金额列表
};

// ==================== 工具函数 ====================

/**
 * 生成业务订单号（与BillingService一致）
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
 * 获取当前日期字符串 YYYY-MM-DD
 */
function getTodayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 获取当前月份字符串 YYYY-MM
 */
function getCurrentMonthStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * HTTP请求封装
 */
async function httpRequest(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: any }> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

// ==================== 测试步骤 ====================

/**
 * 步骤2: 创建充值订单
 */
async function createOrder(
  token: string,
  amount: number
): Promise<{ orderNo: string; amount: number }> {
  console.log(`\n[步骤2] 创建充值订单...`);
  console.log(`  金额: ¥${amount}`);

  const { status, data } = await httpRequest(
    `${CONFIG.API_BASE}/api/payments/create`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        amount,
        payMethod: "alipay",
      }),
    }
  );

  if (status !== 200 || !data?.order?.orderNo) {
    throw new Error(`创建订单失败: ${data?.error || `HTTP ${status}`}`);
  }

  console.log(`  ✓ 订单创建成功`);
  console.log(`  ✓ 订单号: ${data.order.orderNo}`);
  console.log(`  ✓ 订单金额: ¥${data.order.amount}`);
  console.log(`  ✓ 积分数量: ${data.order.points}`);
  console.log(`  ✓ 订单状态: ${data.order.status}`);
  console.log(`  ✓ dryRun模式: ${data.payment?.dryRun}`);

  return {
    orderNo: data.order.orderNo,
    amount: data.order.amount,
  };
}

/**
 * 步骤3: 模拟支付宝回调
 */
async function simulateAlipayNotify(orderNo: string, amount: number): Promise<void> {
  console.log(`\n[步骤3] 模拟支付宝回调...`);

  // 构建支付宝回调参数（简化版，实际会有更多字段和签名）
  const notifyData = {
    out_trade_no: orderNo,
    trade_no: `ALIPAY_${Date.now()}`,
    total_amount: amount.toFixed(2),
    trade_status: "TRADE_SUCCESS",
    gmt_payment: new Date().toISOString(),
  };

  // 构建form-data格式的body（支付宝实际回调格式）
  const formData = new URLSearchParams();
  Object.entries(notifyData).forEach(([key, value]) => {
    formData.append(key, value as string);
  });
  // 添加 sign 参数（dry-run模式下需要，真实环境下无效但避免报错）
  formData.append("sign", "mock_sign_for_testing");
  formData.append("sign_type", "RSA2");

  const { status, data } = await httpRequest(
    `${CONFIG.API_BASE}/api/payments/notify/alipay`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    }
  );

  // 支付宝回调要求返回 "success" 字符串
  if (status !== 200) {
    console.error(`  ✗ 回调响应:`, data);
    throw new Error(`回调处理失败: HTTP ${status} - ${data?.error || data?.message || '未知错误'}`);
  }

  console.log(`  ✓ 回调发送成功`);
  console.log(`  ✓ 响应状态: ${status}`);
}

/**
 * 步骤4: 查询订单状态确认已支付
 */
async function checkOrderStatus(
  token: string,
  orderNo: string
): Promise<{ status: string; paidAt: string | null }> {
  console.log(`\n[步骤4] 查询订单状态...`);

  const { status, data } = await httpRequest(
    `${CONFIG.API_BASE}/api/payments/orders/${orderNo}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (status !== 200) {
    throw new Error(`查询订单失败: ${data?.error || `HTTP ${status}`}`);
  }

  console.log(`  ✓ 订单状态: ${data.status}`);
  console.log(`  ✓ 支付时间: ${data.paidAt || "未支付"}`);

  return {
    status: data.status,
    paidAt: data.paidAt,
  };
}

/**
 * 步骤5: 查询邀请统计
 */
async function queryInviteStats(): Promise<{
  daily: any;
  monthly: any;
}> {
  console.log(`\n[步骤5] 查询邀请统计...`);
  console.log(`  邀请人ID: ${CONFIG.INVITER_ID}`);
  console.log(`  被邀请人ID: ${CONFIG.INVITEE_ID}`);

  // 这里我们需要直接查询数据库，因为没有公开的HTTP接口查询invitee_stats
  // 或者可以通过 /api/referral/invites 接口查看
  const { status, data } = await httpRequest(
    `${CONFIG.API_BASE}/api/referral/invites?limit=50`,
    {
      method: "GET",
      // 注意：这里需要使用邀请人的token，而不是被邀请人的
    }
  );

  if (status === 401) {
    console.log(`  ⚠ 需要邀请人登录才能查看统计`);
    console.log(`  跳过接口查询，请手动在前端查看或查询数据库`);
    return { daily: null, monthly: null };
  }

  if (status === 200 && data?.data?.list) {
    // 查找对应被邀请人的统计
    const invitee = data.data.list.find(
      (item: any) => item.invitee?.id === CONFIG.INVITEE_ID
    );

    if (invitee) {
      console.log(`  ✓ 找到被邀请人统计:`);
      console.log(`    - 当前月充值: ¥${invitee.currentMonthStats?.rechargeAmount || 0}`);
      console.log(`    - 当前月消费: ${invitee.currentMonthStats?.consumptionPoints || 0}积分`);
      console.log(`    - 结算状态: ${invitee.currentMonthStats?.settlementStatus}`);
      return {
        daily: null, // 日统计需要通过日明细接口查询
        monthly: invitee.currentMonthStats,
      };
    }
  }

  console.log(`  ⚠ 未找到被邀请人统计信息`);
  return { daily: null, monthly: null };
}

/**
 * 步骤6: 查询被邀请人日明细
 */
async function queryDailyStats(token: string): Promise<any[]> {
  console.log(`\n[步骤6] 查询日明细...`);

  const month = getCurrentMonthStr();
  const { status, data } = await httpRequest(
    `${CONFIG.API_BASE}/api/referral/invitee/daily?inviteeId=${CONFIG.INVITEE_ID}&month=${month}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (status !== 200) {
    console.log(`  ⚠ 查询日明细失败: ${data?.error || `HTTP ${status}`}`);
    return [];
  }

  const dailyData = data?.data?.dailyData || [];
  console.log(`  ✓ 查询到 ${dailyData.length} 条日明细记录`);

  dailyData.forEach((day: any, i: number) => {
    console.log(`    ${i + 1}. ${day.date}: 充值¥${day.rechargeAmount}, 消费${day.consumptionPoints}积分`);
  });

  return dailyData;
}

/**
 * 验证最终结果
 */
function verifyResults(
  orders: Array<{ amount: number }>,
  dailyStats: any[],
  monthlyStats: any
): boolean {
  console.log(`\n[验证] 检查结果...`);

  const expectedTotal = orders.reduce((sum, o) => sum + o.amount, 0);
  const expectedCount = orders.length;

  // 计算日统计总和
  const today = getTodayStr();
  const todayStat = dailyStats.find((d: any) => d.date === today);
  const actualDailyAmount = todayStat?.rechargeAmount || 0;
  const actualDailyCount = todayStat?.rechargeCount || 0;

  console.log(`\n  预期结果:`);
  console.log(`    - 累计充值金额: ¥${expectedTotal}`);
  console.log(`    - 充值笔数: ${expectedCount}`);

  console.log(`\n  实际日统计 (${today}):`);
  console.log(`    - 充值金额: ¥${actualDailyAmount}`);
  console.log(`    - 充值笔数: ${actualDailyCount}`);

  let passed = true;

  if (Math.abs(actualDailyAmount - expectedTotal) < 0.01) {
    console.log(`    ✓ 金额正确`);
  } else {
    console.log(`    ✗ 金额错误: ${actualDailyAmount} != ${expectedTotal}`);
    passed = false;
  }

  if (actualDailyCount === expectedCount) {
    console.log(`    ✓ 笔数正确`);
  } else {
    console.log(`    ✗ 笔数错误: ${actualDailyCount} != ${expectedCount}`);
    passed = false;
  }

  return passed;
}

// ==================== 主函数 ====================

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("邀请系统充值HTTP接口测试脚本");
  console.log("=".repeat(70));
  console.log(`API地址: ${CONFIG.API_BASE}`);
  console.log(`邀请人ID: ${CONFIG.INVITER_ID}`);
  console.log(`被邀请人ID: ${CONFIG.INVITEE_ID}`);
  console.log(`测试金额: [${CONFIG.TEST_AMOUNTS.join(", ")}]元`);

  const createdOrders: Array<{ orderNo: string; amount: number }> = [];

  // 检查token配置
  if (!CONFIG.INVITEE_TOKEN) {
    console.error("\n[错误] 请配置被邀请人的JWT Token:");
    console.error("  方式1: 修改脚本中的 CONFIG.INVITEE_TOKEN");
    console.error("  方式2: 设置环境变量 INVITEE_TOKEN=xxx");
    process.exit(1);
  }

  if (!CONFIG.INVITER_TOKEN) {
    console.warn("\n[警告] 未配置邀请人Token，将跳过邀请统计查询");
  }

  try {
    // 步骤1: 使用配置的token查询用户信息（验证token有效）
    console.log("\n[步骤1] 验证被邀请人Token...");
    const { status, data } = await httpRequest(
      `${CONFIG.API_BASE}/api/auth/me`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${CONFIG.INVITEE_TOKEN}` },
      }
    );

    if (status !== 200) {
      throw new Error(`Token验证失败: HTTP ${status}`);
    }

    console.log(`  ✓ Token有效`);
    console.log(`  ✓ 用户ID: ${data?.id}`);
    console.log(`  ✓ 用户名: ${data?.name}`);
    console.log(`  ✓ 邮箱: ${data?.email}`);
    console.log(`  ✓ 邀请人ID: ${data?.invitedBy || "无"}`);

    if (data?.id !== CONFIG.INVITEE_ID) {
      console.warn(`  ⚠ 警告: Token对应的用户ID(${data?.id})与预期的${CONFIG.INVITEE_ID}不符!`);
    }

    if (data?.invitedBy !== CONFIG.INVITER_ID) {
      console.warn(`  ⚠ 警告: 该用户的邀请人ID(${data?.invitedBy})与预期的${CONFIG.INVITER_ID}不符!`);
    }

    // 步骤2-4: 循环充值
    for (let i = 0; i < CONFIG.TEST_AMOUNTS.length; i++) {
      const amount = CONFIG.TEST_AMOUNTS[i];
      console.log(`\n${"=".repeat(70)}`);
      console.log(`[充值 ${i + 1}/${CONFIG.TEST_AMOUNTS.length}] ¥${amount}`);
      console.log("=".repeat(70));

      // 创建订单
      const { orderNo } = await createOrder(CONFIG.INVITEE_TOKEN, amount);

      // 模拟回调
      await simulateAlipayNotify(orderNo, amount);

      // 等待一小会儿让服务器处理
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 确认订单状态
      const orderStatus = await checkOrderStatus(CONFIG.INVITEE_TOKEN, orderNo);

      if (orderStatus.status !== "paid") {
        console.error(`  ✗ 订单未成功支付!`);
        continue;
      }

      createdOrders.push({ orderNo, amount });

      // 等待统计更新（可能有延迟）
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // 步骤5: 查询邀请统计（使用邀请人token）
    if (CONFIG.INVITER_TOKEN) {
      await queryInviteStats();
    }

    // 步骤6: 查询日明细（使用邀请人token）
    const dailyStats = CONFIG.INVITER_TOKEN
      ? await queryDailyStats(CONFIG.INVITER_TOKEN)
      : [];

    // 验证结果
    const passed = verifyResults(createdOrders, dailyStats, null);

    // 最终结论
    console.log("\n" + "=".repeat(70));
    if (passed) {
      console.log("✓ 测试通过！充值统计功能工作正常");
    } else {
      console.log("✗ 测试失败！充值统计数据存在异常");
    }
    console.log("=".repeat(70));

    // 打印汇总信息
    console.log("\n[测试汇总]");
    console.log(`  成功充值订单数: ${createdOrders.length}/${CONFIG.TEST_AMOUNTS.length}`);
    console.log(`  订单列表:`);
    createdOrders.forEach((o, i) => {
      console.log(`    ${i + 1}. ${o.orderNo} - ¥${o.amount}`);
    });

  } catch (err: any) {
    console.error("\n[错误] 测试执行失败:", err.message);
    console.error(err);
    process.exit(1);
  }
}

// 运行测试
main();
