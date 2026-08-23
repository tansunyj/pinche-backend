/**
 * 用户开户/注册引导（§2.4 注册即开户）
 *
 * 用户首次登录（手机号验证码）时自动完成：
 *   1. 在拼车库 pt_users 建用户（phone UNIQUE，余额 0）——用户唯一存储，不再写网关 users
 *   2. 发默认 API Key（proxy_tokens，user_id = pt_users.id）
 *
 * 幂等：pt_users.phone UNIQUE + 默认 Key 存在性检查，重复调用安全。
 */

import crypto from "crypto";
import { cpQuery, gatewayPool } from "../config/db";
import type { UserRow } from "./user";

/** 确保拼车用户存在（幂等），返回 pt_users 行 */
export async function ensureUser(phone: string): Promise<UserRow> {
  let user: UserRow | null = null;

  // 1. 已存在则直接用
  const rows = await cpQuery("SELECT * FROM pt_users WHERE phone = ? LIMIT 1", [phone]);
  if (Array.isArray(rows) && rows.length > 0) {
    user = rows[0] as UserRow;
  } else {
    // 2. 新建（phone UNIQUE 兜底并发冲突）
    try {
      const r = await cpQuery("INSERT INTO pt_users (phone) VALUES (?)", [phone]);
      const fresh = await cpQuery("SELECT * FROM pt_users WHERE id = ? LIMIT 1", [
        (r as any).insertId,
      ]);
      user = fresh[0] as UserRow;
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        const again = await cpQuery("SELECT * FROM pt_users WHERE phone = ? LIMIT 1", [phone]);
        user = again[0] as UserRow;
      } else {
        throw err;
      }
    }
  }

  // 3. 始终确保默认 Key 存在（幂等；proxy_tokens 被清空后下次登录自动补发）
  await ensureDefaultKey(user.id);

  return user!;
}

/** 确保邮箱验证码登录用户存在（幂等），返回 pt_users 行。与 ensureUser 对称，email 区分账户类型 */
export async function ensureEmailUser(email: string): Promise<UserRow> {
  let user: UserRow | null = null;

  // 1. 已存在则直接用
  const rows = await cpQuery("SELECT * FROM pt_users WHERE email = ? LIMIT 1", [email]);
  if (Array.isArray(rows) && rows.length > 0) {
    user = rows[0] as UserRow;
  } else {
    // 2. 新建（email UNIQUE 兜底并发冲突）
    try {
      const r = await cpQuery("INSERT INTO pt_users (email) VALUES (?)", [email]);
      const fresh = await cpQuery("SELECT * FROM pt_users WHERE id = ? LIMIT 1", [
        (r as any).insertId,
      ]);
      user = fresh[0] as UserRow;
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        const again = await cpQuery("SELECT * FROM pt_users WHERE email = ? LIMIT 1", [email]);
        user = again[0] as UserRow;
      } else {
        throw err;
      }
    }
  }

  // 3. 始终确保默认 Key 存在（幂等）
  await ensureDefaultKey(user.id);

  return user!;
}

/** 确保默认 API Key 存在（幂等：已有同名 Key 则跳过） */
async function ensureDefaultKey(userId: number): Promise<void> {
  const exists = await gatewayPool.execute(
    "SELECT id FROM proxy_tokens WHERE user_id = ? AND name = '默认Key' LIMIT 1",
    [userId]
  );
  if (Array.isArray(exists[0]) && (exists[0] as any[]).length > 0) return;

  const key = `sk-silievo-${crypto.randomBytes(16).toString("hex")}`;
  await gatewayPool.execute(
    `INSERT INTO proxy_tokens (user_id, name, \`key\`, quota, remain_quota, rate_limit_rpm, status)
     VALUES (?, '默认Key', ?, 0, 0, 10000, 1)`,
    [userId, key]
  );
}
