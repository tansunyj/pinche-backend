/**
 * 初始化脚本：创建默认管理员 + 幂等默认充值档位
 *
 * 用法：
 *   npm run seed                            # 读取 .env.development，默认 admin / 随机密码（打印一次）
 *   npm run seed -- admin admin123456       # 显式指定 用户名/密码
 *
 * 前置：已导入 sql/pt_carpool.sql
 */

import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

import mysql from "mysql2/promise";
import crypto from "crypto";
import bcrypt from "bcryptjs";

async function main() {
  const username = process.argv[2] || process.env.ADMIN_USERNAME || "admin";
  let password = process.argv[3] || process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(6).toString("base64url").slice(0, 12);
    generated = true;
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "123456",
    database: process.env.CARPOOL_DB || "pt_carpool",
    charset: "utf8mb4",
  });

  try {
    const hash = bcrypt.hashSync(password, 10);

    // 管理员：已存在则仅重置密码，不存在则创建（超管）
    const [rows] = await conn.execute("SELECT id FROM pt_admins WHERE username = ? LIMIT 1", [username]);
    if ((rows as any[]).length > 0) {
      await conn.execute("UPDATE pt_admins SET password_hash = ?, role = 'SUPER_ADMIN', status = 'ACTIVE' WHERE username = ?", [hash, username]);
      console.log(`✓ 管理员「${username}」已存在，密码已重置`);
    } else {
      await conn.execute(
        "INSERT INTO pt_admins (username, password_hash, role, status) VALUES (?, ?, 'SUPER_ADMIN', 'ACTIVE')",
        [username, hash]
      );
      console.log(`✓ 管理员「${username}」已创建（SUPER_ADMIN）`);
    }

    // 默认充值档位（幂等）
    const defaults = [
      { amount: 30, quota: 3000000, order: 10 },
      { amount: 50, quota: 5000000, order: 20 },
      { amount: 100, quota: 10000000, order: 30 },
      { amount: 200, quota: 20000000, order: 40 },
    ];
    for (const d of defaults) {
      const [t] = await conn.execute("SELECT id FROM pt_recharge_tiers WHERE amount_yuan = ? LIMIT 1", [d.amount]);
      if ((t as any[]).length === 0) {
        await conn.execute(
          "INSERT INTO pt_recharge_tiers (amount_yuan, quota, display_order, enabled) VALUES (?, ?, ?, TRUE)",
          [d.amount, d.quota, d.order]
        );
        console.log(`  ✓ 充值档位 ¥${d.amount} → ${d.quota} 额度`);
      }
    }

    if (generated) {
      console.log("\n⚠️  未指定密码，已生成随机密码（仅显示这一次，请立即保存）:");
      console.log(`  用户名: ${username}`);
      console.log(`  密  码: ${password}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("Seed 失败:", err);
  process.exit(1);
});
