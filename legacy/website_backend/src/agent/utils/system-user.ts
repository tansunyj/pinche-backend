import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../../db/mysql";

const SYSTEM_AGENT_USERNAME = "system_agent";
const SYSTEM_AGENT_EMAIL = "agent@silievo.com";
const SYSTEM_AGENT_ROLE = "admin";
const SYSTEM_AGENT_COINS = 999999;

// 本地定义 User 类型（替代 Prisma User）
interface User {
  id: number;
  username: string;
  email: string;
  emailVerified: Date | null;
  phone: string | null;
  phoneVerified: Date | null;
  role: string;
  siliconCoins: number;
  avatar: string | null;
  bio: string | null;
}

async function buildSystemAgentPassword(): Promise<string> {
  return bcrypt.hash(crypto.randomUUID(), 10);
}

export async function getOrCreateSystemAgent(): Promise<User> {
  // 使用 MySQL 查询现有系统用户
  const [rows] = await pool.execute(
    "SELECT * FROM user_users WHERE username = ?",
    [SYSTEM_AGENT_USERNAME]
  );
  const existing = (rows as any[])[0];

  if (!existing) {
    try {
      const password = await buildSystemAgentPassword();
      const [result] = await pool.execute(
        "INSERT INTO user_users (username, email, password, role, balance, email_verified) VALUES (?, ?, ?, ?, ?, NOW())",
        [SYSTEM_AGENT_USERNAME, SYSTEM_AGENT_EMAIL, password, SYSTEM_AGENT_ROLE, SYSTEM_AGENT_COINS]
      );
      const insertId = (result as any).insertId;
      const [newRows] = await pool.execute(
        "SELECT * FROM user_users WHERE id = ?",
        [insertId]
      );
      return (newRows as any[])[0] as User;
    } catch (error: any) {
      // 如果是唯一键冲突（可能是并发创建），重新查询
      if (error.code === "ER_DUP_ENTRY") {
        const [rows2] = await pool.execute(
          "SELECT * FROM user_users WHERE username = ?",
          [SYSTEM_AGENT_USERNAME]
        );
        const user = (rows2 as any[])[0];
        if (user) return user as User;
      }
      throw error;
    }
  }

  // 检查是否需要更新
  const updates: string[] = [];
  const values: any[] = [];

  if (!existing.password?.startsWith("$2")) {
    updates.push("password = ?");
    values.push(await buildSystemAgentPassword());
  }
  if (existing.role !== SYSTEM_AGENT_ROLE) {
    updates.push("role = ?");
    values.push(SYSTEM_AGENT_ROLE);
  }
  if (existing.email !== SYSTEM_AGENT_EMAIL) {
    updates.push("email = ?");
    values.push(SYSTEM_AGENT_EMAIL);
  }
  if (existing.balance < SYSTEM_AGENT_COINS) {
    updates.push("balance = ?");
    values.push(SYSTEM_AGENT_COINS);
  }

  if (updates.length > 0) {
    values.push(existing.id);
    await pool.execute(
      `UPDATE user_users SET ${updates.join(", ")} WHERE id = ?`,
      values
    );
    // 重新查询更新后的数据
    const [updatedRows] = await pool.execute(
      "SELECT * FROM user_users WHERE id = ?",
      [existing.id]
    );
    return (updatedRows as any[])[0] as User;
  }

  return existing as User;
}
