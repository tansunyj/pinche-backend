/**
 * 移除网关 users 表,用户统一收敛到 pt_users
 *
 * 背景:users 表（网关用户）与拼车无关,carpool 已无需它。
 *   - pt_users ADD balance / cumulative_recharge / last_login_at（余额迁入拼车库）
 *   - pt_users DROP user_users_id 及其索引（不再映射网关用户）
 *   - DROP TABLE users（存量数据不迁移,开发阶段直接删除）
 *   - TRUNCATE proxy_tokens / proxy_logs（旧 token.user_id 指向已删 users.id,
 *     孤儿数据;新 ensureUser 会在下次登录幂等补发默认 Key）
 *
 * 用法:
 *   npx tsx scripts/migrate-remove-users.ts
 *
 * 幂等:通过 INFORMATION_SCHEMA 判断列/索引/表是否存在,重复执行安全。
 */

import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "123456",
    database: process.env.CARPOOL_DB || "pt_carpool",
    charset: "utf8mb4",
    timezone: "+08:00",
  });

  try {
    async function columnExists(table: string, column: string): Promise<boolean> {
      const [rows] = await conn.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      return (rows as any[]).length > 0;
    }

    async function indexExists(table: string, index: string): Promise<boolean> {
      const [rows] = await conn.execute(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
         LIMIT 1`,
        [table, index]
      );
      return (rows as any[]).length > 0;
    }

    async function tableExists(table: string): Promise<boolean> {
      const [rows] = await conn.execute(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
      );
      return (rows as any[]).length > 0;
    }

    // 1. pt_users 新增余额/累计充值/最近登录时间（不存在才加）
    const ptUserColumns: Array<[string, string]> = [
      [
        "balance",
        "ADD COLUMN balance BIGINT NOT NULL DEFAULT 0 COMMENT '钱包余额（额度值，1元=100000额度）' AFTER avatar_url",
      ],
      [
        "cumulative_recharge",
        "ADD COLUMN cumulative_recharge BIGINT NOT NULL DEFAULT 0 COMMENT '累计充值（额度值，成功到账累计）' AFTER balance",
      ],
      [
        "last_login_at",
        "ADD COLUMN last_login_at DATETIME COMMENT '最近登录时间' AFTER status",
      ],
    ];
    for (const [col, ddl] of ptUserColumns) {
      if (!(await columnExists("pt_users", col))) {
        await conn.execute(`ALTER TABLE pt_users ${ddl}`);
        console.log(`✓ pt_users 新增 ${col}`);
      } else {
        console.log(`- pt_users.${col} 已存在，跳过`);
      }
    }

    // 2. pt_users 删除 user_users_id 及索引（先删索引，再删列）
    if (await indexExists("pt_users", "idx_user_users_id")) {
      await conn.execute("ALTER TABLE pt_users DROP INDEX idx_user_users_id");
      console.log("✓ pt_users 删除索引 idx_user_users_id");
    } else {
      console.log("- pt_users.idx_user_users_id 不存在，跳过");
    }
    if (await columnExists("pt_users", "user_users_id")) {
      await conn.execute("ALTER TABLE pt_users DROP COLUMN user_users_id");
      console.log("✓ pt_users 删除列 user_users_id");
    } else {
      console.log("- pt_users.user_users_id 不存在，跳过");
    }

    // 3. 删除网关 users 表（存量数据不迁移）
    if (await tableExists("users")) {
      await conn.execute("DROP TABLE IF EXISTS users");
      console.log("✓ DROP TABLE users");
    } else {
      console.log("- users 表不存在，跳过");
    }

    // 4. 清空孤儿代理数据（旧 token.user_id 指向已删 users.id）
    if (await tableExists("proxy_tokens")) {
      await conn.execute("TRUNCATE TABLE proxy_tokens");
      console.log("✓ TRUNCATE proxy_tokens");
    }
    if (await tableExists("proxy_logs")) {
      await conn.execute("TRUNCATE TABLE proxy_logs");
      console.log("✓ TRUNCATE proxy_logs");
    }

    // —— 验证 ——
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pt_users'
       ORDER BY ORDINAL_POSITION`
    );
    console.log("pt_users 当前列：");
    for (const c of cols as any[]) {
      console.log(`  ${c.COLUMN_NAME}`);
    }
    const [idxRows] = await conn.execute(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pt_users'
       GROUP BY INDEX_NAME`
    );
    console.log("pt_users 当前索引：");
    for (const i of idxRows as any[]) {
      console.log(`  ${i.INDEX_NAME}`);
    }
    console.log(`users 表仍存在？ ${await tableExists("users")}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
