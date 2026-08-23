/**
 * 车次成团逻辑迁移脚本
 *
 * 新增最低成团人数与成团锁存：
 *   - pt_rides ADD min_count INT NOT NULL DEFAULT 1（最低成团人数）
 *   - pt_rides ADD established_at DATETIME NULL（成团时间锁存，不回退）
 *   - pt_rides.status 枚举加 'CANCELLED'（未成团自动取消）
 *
 * 存量行：min_count = target_count、established_at = NOW()
 *（老车次视为已成立，避免被新的「发车未成团自动取消」规则误取消）。
 *
 * 用法：
 *   npx tsx scripts/migrate-ride-establish.ts
 *
 * 幂等：通过 INFORMATION_SCHEMA.COLUMNS 判断列是否存在，重复执行安全。
 * 前置：已跑过 migrate-ride-redesign.ts（或新装 sql/pt_carpool.sql）。
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

    // 1. 新增 min_count（不存在才加）
    if (!(await columnExists("pt_rides", "min_count"))) {
      await conn.execute(
        `ALTER TABLE pt_rides
         ADD COLUMN min_count INT NOT NULL DEFAULT 1 COMMENT '最低成团人数（达到后车次自动成立）' AFTER current_count`
      );
      console.log("✓ pt_rides 新增 min_count");
    } else {
      console.log("- pt_rides.min_count 已存在，跳过");
    }

    // 2. 新增 established_at（不存在才加）
    if (!(await columnExists("pt_rides", "established_at"))) {
      await conn.execute(
        `ALTER TABLE pt_rides
         ADD COLUMN established_at DATETIME COMMENT '成团时间（达到最低人数后锁存，不回退）' AFTER full_at`
      );
      console.log("✓ pt_rides 新增 established_at");
    } else {
      console.log("- pt_rides.established_at 已存在，跳过");
    }

    // 3. status 枚举加 CANCELLED
    await conn.execute(
      `ALTER TABLE pt_rides
       MODIFY COLUMN status ENUM('PENDING', 'ACTIVE', 'FULL', 'EXPIRED', 'CLOSED', 'CANCELLED')
         NOT NULL DEFAULT 'PENDING' COMMENT '状态：待上线/上线/满员/已结束/已关闭/未成团取消'`
    );
    console.log("✓ pt_rides.status 枚举已含 CANCELLED");

    // 4. 存量行：老车次视为已成立（min_count = target_count、established_at = NOW()）
    const [legacy] = await conn.execute(
      `UPDATE pt_rides SET min_count = target_count, established_at = COALESCE(established_at, NOW())`
    );
    console.log(`✓ 存量车次回填 min_count=target_count、established_at=NOW()（影响 ${(legacy as any).affectedRows} 行）`);

    // —— 验证 ——
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pt_rides'
         AND COLUMN_NAME IN ('min_count', 'established_at', 'status')
       ORDER BY ORDINAL_POSITION`
    );
    for (const c of cols as any[]) {
      console.log(`  ${c.COLUMN_NAME}: ${c.COLUMN_TYPE}`);
    }
    const [rows] = await conn.execute(
      `SELECT id, name, min_count, target_count, status,
              (established_at IS NOT NULL) AS established
       FROM pt_rides ORDER BY id ASC LIMIT 10`
    );
    console.log("存量车次样本：");
    for (const r of rows as any[]) {
      console.log(`  id=${r.id} ${r.name} min=${r.min_count} target=${r.target_count} status=${r.status} established=${r.established}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
