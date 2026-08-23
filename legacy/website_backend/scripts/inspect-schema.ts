/**
 * 一次性只读脚本：列出 silievo 数据库的所有表 + 关键表的字段。
 * 用法（在 silievo-site/backend/ 下）：
 *   npx tsx scripts/inspect-schema.ts
 */
import "../src/utils/env";
import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "123456",
    database: process.env.MYSQL_DATABASE || "silievo",
  });

  const [tables] = await conn.query<any[]>("SHOW TABLES");
  const colName = `Tables_in_${process.env.MYSQL_DATABASE || "silievo"}`;
  const tableNames = (tables as any[]).map((r) => r[colName]);
  console.log(`\n=== silievo 库共 ${tableNames.length} 张表 ===`);
  for (const t of tableNames) console.log(" -", t);

  // 重点对照模型广场需要的表
  const focus = tableNames.filter((t) =>
    /^(model_|user_|proxy_|billing_|admin_)/.test(t)
  );
  console.log(`\n=== 关键表 (${focus.length} 张) 字段明细 ===`);
  for (const t of focus) {
    const [cols] = await conn.query<any[]>(`SHOW FULL COLUMNS FROM \`${t}\``);
    console.log(`\n--- ${t} ---`);
    for (const c of cols as any[]) {
      console.log(
        `  ${c.Field.padEnd(28)} ${String(c.Type).padEnd(40)} ${c.Null === "NO" ? "NOT NULL" : "NULL"}${c.Key ? "  [" + c.Key + "]" : ""}${c.Default !== null ? "  default=" + c.Default : ""}`
      );
    }
  }

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
