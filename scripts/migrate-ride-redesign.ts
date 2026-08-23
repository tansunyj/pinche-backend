/**
 * 车次模型简化迁移脚本
 *
 * 去掉 ride_type / discount_expire_at / join_deadline / visibility / group_name，
 * 新增 start_time / end_time，status 枚举加入 PENDING（默认待上线）。
 *
 * 用法：
 *   npx tsx scripts/migrate-ride-redesign.ts
 *
 * 幂等：通过 INFORMATION_SCHEMA.COLUMNS 判断列是否存在，重复执行安全。
 * 前置：已导入 sql/pt_carpool.sql（旧结构或新结构均可）。
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

    // 1. pt_rides 新增 start_time / end_time（不存在才加）
    for (const [col, comment] of [
      ["start_time", "车次开始时间（展示用）"],
      ["end_time", "车次结束时间（= 上车截止 + 折扣过期，硬门禁）"],
    ] as const) {
      if (!(await columnExists("pt_rides", col))) {
        await conn.execute(
          `ALTER TABLE pt_rides ADD COLUMN ${col} DATETIME COMMENT '${comment}' AFTER current_count`
        );
        console.log(`✓ pt_rides 新增 ${col}`);
      } else {
        console.log(`- pt_rides.${col} 已存在，跳过`);
      }
    }

    // 2. status 枚举扩展（已存在行保持原状态；默认值改为 PENDING 只影响新行）
    await conn.execute(
      `ALTER TABLE pt_rides
       MODIFY COLUMN status ENUM('PENDING', 'ACTIVE', 'FULL', 'EXPIRED', 'CLOSED')
         NOT NULL DEFAULT 'PENDING' COMMENT '状态：待上线/上线/满员/已结束/已关闭'`
    );
    console.log("✓ pt_rides.status 枚举扩展为 PENDING/ACTIVE/FULL/EXPIRED/CLOSED，默认 PENDING");

    // 3. pt_rides 删除废弃列（单列索引随列删除自动移除）
    for (const col of ["ride_type", "discount_expire_at", "join_deadline", "visibility"]) {
      if (await columnExists("pt_rides", col)) {
        await conn.execute(`ALTER TABLE pt_rides DROP COLUMN ${col}`);
        console.log(`✓ pt_rides 删除 ${col}`);
      } else {
        console.log(`- pt_rides.${col} 已不存在，跳过`);
      }
    }

    // 4. pt_ride_groups 删除 group_name
    if (await columnExists("pt_ride_groups", "group_name")) {
      await conn.execute("ALTER TABLE pt_ride_groups DROP COLUMN group_name");
      console.log("✓ pt_ride_groups 删除 group_name");
    } else {
      console.log("- pt_ride_groups.group_name 已不存在，跳过");
    }

    console.log("\n迁移完成。");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("迁移失败:", err);
  process.exit(1);
});
