/**
 * 交互式创建/重置管理员（pt_admins，bcrypt 哈希）
 *
 * 用法：
 *   npm run admin
 *
 * 执行时按提示输入：
 *   1. 用户名（回车默认 admin）
 *   2. 密码（静默输入不回显，且要求两次确认一致）
 *
 * 已存在同用户名 → 仅重置密码（保持原 role/status）
 * 不存在 → 新建为 SUPER_ADMIN / ACTIVE
 *
 * 前置：已导入 sql/pt_carpool.sql，.env.development 已配好连接
 */

import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

import { createInterface } from "readline/promises";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 10;

/** 静默输入密码（按字符回显 *，支持退格/Ctrl+C），返回密码字符串 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    // 非 TTY（管道/重定向）时报错退出，避免挂死
    if (!stdin.isTTY) {
      reject(new Error("stdin 不是终端，无法静默输入密码；请在交互式终端里执行 npm run admin"));
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();

    let input = "";
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdout.write("\n");
          cleanup();
          resolve(input);
          return;
        }
        if (ch === "") {
          // Ctrl+C
          stdout.write("\n^C\n");
          cleanup();
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        input += ch;
        stdout.write("*");
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const usernameInput = await rl.question("用户名（回车默认 admin）: ");
  const username = (usernameInput.trim() || "admin").trim();

  const pwd1 = await promptHidden(`请输入「${username}」的密码: `);
  const pwd2 = await promptHidden("再次输入确认: ");

  if (pwd1 !== pwd2) {
    console.error("❌ 两次密码不一致，已取消");
    process.exit(1);
  }
  if (pwd1.length < 8) {
    console.error("❌ 密码至少 8 位，已取消");
    process.exit(1);
  }
  const password = pwd1;

  // 连接 pt_carpool（拼车库）
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "123456",
    database: process.env.CARPOOL_DB || "pt_carpool",
    charset: "utf8mb4",
  });

  try {
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

    const [rows] = await conn.execute("SELECT id, role, status FROM pt_admins WHERE username = ? LIMIT 1", [username]);
    if ((rows as any[]).length > 0) {
      const existing = (rows as any[])[0];
      await conn.execute("UPDATE pt_admins SET password_hash = ? WHERE username = ?", [hash, username]);
      console.log(`✓ 管理员「${username}」已存在，密码已重置（role=${existing.role}, status=${existing.status}）`);
    } else {
      await conn.execute(
        "INSERT INTO pt_admins (username, password_hash, role, status) VALUES (?, ?, 'SUPER_ADMIN', 'ACTIVE')",
        [username, hash]
      );
      console.log(`✓ 管理员「${username}」已创建（SUPER_ADMIN / ACTIVE）`);
    }
    console.log(`\n完成。登录方式：管理端 → 用户名 ${username} + 你输入的密码。`);
  } finally {
    await conn.end();
    rl.close();
  }
}

main().catch((err) => {
  console.error("创建管理员失败:", err);
  process.exit(1);
});
