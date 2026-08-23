/**
 * 去掉「满员上限」迁移脚本
 *
 * 车次不再有目标座位数（target_count）/ 满员（FULL）概念：
 *   - 存量 FULL 车次 → ACTIVE（满员即放开，仍可上车，直到发车/到期）
 *   - status 枚举去掉 'FULL' → ENUM('PENDING','ACTIVE','EXPIRED','CLOSED','CANCELLED')
 *   - DROP target_count（目标座位数）
 *   - DROP full_at（满员时间，已无用）
 *
 * 成团仍由 min_count / established_at 决定（与本脚本无关）。
 *
 * 用法：npx tsx scripts/migrate-remove-capacity.ts
 * 幂等：INFORMATION_SCHEMA 判断列/枚举，重复执行安全。
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

    // 1. 存量 FULL 车次 → ACTIVE（放开满员）
    const [fullRows] = await conn.execute(
      `UPDATE pt_rides SET status = 'ACTIVE', full_at = NULL WHERE status = 'FULL'`
    );
    console.log(`✓ 存量 FULL 车次已置 ACTIVE（影响 ${(fullRows as any).affectedRows} 行）`);

    // 2. status 枚举去掉 FULL
    await conn.execute(
      `ALTER TABLE pt_rides
       MODIFY COLUMN status ENUM('PENDING', 'ACTIVE', 'EXPIRED', 'CLOSED', 'CANCELLED')
         NOT NULL DEFAULT 'PENDING' COMMENT '状态：待上线/上线/已结束/已关闭/未成团取消'`
    );
    console.log("✓ pt_rides.status 枚举已去掉 FULL");

    // 3. DROP target_count
    if (await columnExists("pt_rides", "target_count")) {
      await conn.execute(`ALTER TABLE pt_rides DROP COLUMN target_count`);
      console.log("✓ DROP pt_rides.target_count");
    } else {
      console.log("- pt_rides.target_count 已不存在，跳过");
    }

    // 4. DROP full_at
    if (await columnExists("pt_rides", "full_at")) {
      await conn.execute(`ALTER TABLE pt_rides DROP COLUMN full_at`);
      console.log("✓ DROP pt_rides.full_at");
    } else {
      console.log("- pt_rides.full_at 已不存在，跳过");
    }

    // —— 验证 ——
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pt_rides'`
    );
    const colNames = (cols as any[]).map((c) => c.COLUMN_NAME);
    console.log(
      `pt_rides 现含 target_count=${colNames.includes("target_count")}, full_at=${colNames.includes("full_at")}`
    );
    const [st] = await conn.execute(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pt_rides' AND COLUMN_NAME = 'status'`
    );
    console.log(`status 类型：${(st as any[])[0]?.COLUMN_TYPE}`);
    const [rows] = await conn.execute(
      `SELECT id, name, min_count, status, established_at IS NOT NULL AS established
       FROM pt_rides ORDER BY id ASC LIMIT 10`
    );
    console.log("存量车次样本：");
    for (const r of rows as any[]) {
      console.log(`  id=${r.id} ${r.name} min=${r.min_count} status=${r.status} established=${r.established}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
