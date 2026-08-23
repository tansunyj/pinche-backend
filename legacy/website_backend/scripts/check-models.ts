/**
 * 诊断模型广场数据问题
 *
 * 用法：
 *   cd silievo-site/backend
 *   npx tsx scripts/check-models.ts
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

import pool from "../src/db/mysql";

async function checkModels() {
  console.log("========================================");
  console.log("      模型广场数据诊断");
  console.log("========================================\n");

  // 1. 查询所有分类
  console.log("【1】所有分类统计：");
  const [categories] = await pool.execute<any[]>(
    `SELECT category, COUNT(*) as cnt,
     SUM(CASE WHEN status=1 AND is_visible=1 THEN 1 ELSE 0 END) as visible_cnt
     FROM model_library
     GROUP BY category`
  );
  console.log("category | 总数 | 可见数");
  console.log("---------|------|-------");
  for (const row of categories) {
    console.log(`${row.category.padEnd(10)} | ${row.cnt} | ${row.visible_cnt}`);
  }

  // 2. 查询所有模型（只看关键字段）
  console.log("\n【2】所有模型列表（前20条）：");
  const [models] = await pool.execute<any[]>(
    `SELECT model_id, display_name, category, provider, status, is_visible
     FROM model_library
     ORDER BY id DESC
     LIMIT 20`
  );
  console.log("model_id | display_name | category | status | visible");
  console.log("---------|--------------|----------|--------|-------");
  for (const m of models) {
    console.log(`${m.model_id.slice(0,20).padEnd(20)} | ${m.display_name.slice(0,15).padEnd(15)} | ${m.category.padEnd(8)} | ${m.status} | ${m.is_visible}`);
  }

  // 3. 查询条件筛选结果
  console.log("\n【3】模拟前端查询条件：");
  const conditions = [
    { name: "video分类,可见", sql: "category='video' AND status=1 AND is_visible=1" },
    { name: "image分类,可见", sql: "category='image' AND status=1 AND is_visible=1" },
    { name: "video分类,全部", sql: "category='video'" },
    { name: "image分类,全部", sql: "category='image'" },
    { name: "全部可见", sql: "status=1 AND is_visible=1" },
    { name: "全部", sql: "1=1" },
  ];

  for (const cond of conditions) {
    const [result] = await pool.execute<any[]>(
      `SELECT COUNT(*) as cnt FROM model_library WHERE ${cond.sql}`
    );
    console.log(`${cond.name.padEnd(15)}: ${result[0].cnt} 条`);
  }

  // 4. 检查相关表
  console.log("\n【4】相关表统计：");
  const tables = ['model_library', 'model_endpoints', 'model_prices', 'model_token_groups'];
  for (const table of tables) {
    try {
      const [result] = await pool.execute<any[]>(`SELECT COUNT(*) as cnt FROM ${table}`);
      console.log(`${table.padEnd(25)}: ${result[0].cnt} 条`);
    } catch (e) {
      console.log(`${table.padEnd(25)}: 表不存在或无法访问`);
    }
  }

  console.log("\n========================================");
  console.log("诊断完成！");
  console.log("\n常见问题：");
  console.log("1. category 字段值不匹配（如配成了 't2v' 而不是 'video'）");
  console.log("2. status 或 is_visible 为 0");
  console.log("3. 数据配置到了其他数据库（server/ 使用的是另一个数据库？）");

  await pool.end();
}

checkModels().catch((err) => {
  console.error("诊断失败:", err);
  process.exit(1);
});