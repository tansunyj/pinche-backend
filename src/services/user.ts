/**
 * 用户服务：直连拼车库 pt_users 表（用户唯一存储，余额也在这里）
 * 仅保留拼车需要的操作：手机号注册/查询、资料更新、密码、登录记录。
 */

import bcrypt from "bcryptjs";
import { cpQuery } from "../config/db";

export interface UserRow {
  id: number;
  phone: string | null; // 手机号登录用户
  email: string | null; // 邮箱验证码登录用户
  password_hash: string | null;
  nickname: string | null;
  avatar_url: string | null;
  status: string; // 'ACTIVE' | 'DISABLED'
  balance: number;
  cumulative_recharge: number;
  last_login_at: Date | null;
  created_at: Date;
}

export function getPublicUser(user: UserRow) {
  return {
    id: user.id,
    phone: user.phone ?? undefined,
    email: user.email ?? undefined,
    name: user.nickname, // 前端 mapCarpoolUser 依赖 name 键
    avatar: user.avatar_url,
    provider: user.email ? "email" : "phone", // 区分两种账户类型
    userType: 1,
    status: user.status,
    balance: Number(user.balance),
    createdAt: user.created_at,
  };
}

const SELECT_USER_COLUMNS = `
  id, phone, email, password_hash, nickname, avatar_url, status,
  balance, cumulative_recharge, last_login_at, created_at
`;

class UserService {
  async findById(id: number): Promise<UserRow | null> {
    const rows = await cpQuery(
      `SELECT ${SELECT_USER_COLUMNS} FROM pt_users WHERE id = ? LIMIT 1`,
      [id]
    );
    return (rows[0] as UserRow) || null;
  }

  async findByPhone(phone: string): Promise<UserRow | null> {
    const rows = await cpQuery(
      `SELECT ${SELECT_USER_COLUMNS} FROM pt_users WHERE phone = ? LIMIT 1`,
      [phone]
    );
    return (rows[0] as UserRow) || null;
  }

  /** 邮箱验证码登录用户查询 */
  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await cpQuery(
      `SELECT ${SELECT_USER_COLUMNS} FROM pt_users WHERE email = ? LIMIT 1`,
      [email]
    );
    return (rows[0] as UserRow) || null;
  }

  /** 手机号注册：首次手机号登录时自动建用户 */
  async createPhoneUser(input: { phone: string; nickname?: string | null }): Promise<number> {
    const r = await cpQuery(
      `INSERT INTO pt_users (phone, nickname) VALUES (?, ?)`,
      [input.phone, input.nickname ?? null]
    );
    return (r as any).insertId;
  }

  /** 邮箱注册：首次邮箱验证码登录时自动建用户 */
  async createEmailUser(input: { email: string; nickname?: string | null }): Promise<number> {
    const r = await cpQuery(
      `INSERT INTO pt_users (email, nickname) VALUES (?, ?)`,
      [input.email, input.nickname ?? null]
    );
    return (r as any).insertId;
  }

  async updateProfile(
    userId: number,
    fields: { nickname?: string; avatar_url?: string }
  ): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];
    if (fields.nickname !== undefined) {
      sets.push("nickname = ?");
      values.push(fields.nickname);
    }
    if (fields.avatar_url !== undefined) {
      sets.push("avatar_url = ?");
      values.push(fields.avatar_url);
    }
    if (sets.length === 0) return;
    values.push(userId);
    await cpQuery(`UPDATE pt_users SET ${sets.join(", ")} WHERE id = ?`, values);
  }

  async updatePassword(userId: number, newPassword: string): Promise<void> {
    const hash = await bcrypt.hash(newPassword, 10);
    await cpQuery(`UPDATE pt_users SET password_hash = ? WHERE id = ?`, [hash, userId]);
  }

  async markLoginSuccess(userId: number): Promise<void> {
    await cpQuery(`UPDATE pt_users SET last_login_at = NOW() WHERE id = ?`, [userId]);
  }
}

export default new UserService();
